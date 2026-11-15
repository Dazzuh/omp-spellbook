/**
 * Prompt spells: `? <description>` becomes what to type into omp's composer, written from a
 * catalogue of the live setup (never the conversation). The model proposes; {@link landAnswer}
 * makes sure what lands names only installed skills (as `skill://<name>`), only enabled magic
 * keywords, and sends omp commands and settings in a form Enter runs.
 */
import { type Catalogue, type DocPage, MAX_DOC_PAGES, type SettingEntry } from "./catalogue";

/** The whole prompt-spell request (system prompt + user message), in UTF-8 bytes. */
export const PROMPT_REQUEST_BUDGET = 32_000;
/** Output budget for one answer: a prompt of a few paragraphs plus its JSON. */
export const PROMPT_MAX_TOKENS = 1_500;
/** The description is cut to this many UTF-8 bytes. */
export const DESCRIPTION_BYTES = 1_000;
/** At most this many matching settings go in the request. */
export const MAX_SETTINGS = 8;

/** What the composer gets: an agent prompt, a slash command, or an `omp config set` line. */
export type PromptKind = "prompt" | "command" | "setting";

export interface PromptAnswer {
	kind: PromptKind;
	/** The composer text, ready for Enter: a prompt, `/<command> …` or `!omp config set …`. */
	text: string;
	/** One plain-words line saying what the text does. */
	explain: string;
	/** What Spellbook changed or could not check, for the line under the composer. */
	warnings: string[];
}

export interface PromptRequest {
	system: string;
	user: string;
}

/** What one prompt spell sends: the description and what the catalogue offers for it, nothing else. */
export interface PromptPacket {
	description: string;
	catalogue: Catalogue;
	/** Doc pages read for this description (at most {@link MAX_DOC_PAGES}). */
	pages: readonly DocPage[];
	/** Settings whose words match the description. */
	settings: readonly SettingEntry[];
}

/** What each magic keyword does, for the model; a keyword omp adds later is listed without one. */
const KEYWORD_USES: Record<string, string> = {
	ultrathink: "the task needs careful, deep multi-step reasoning",
	chillax: "the task is small and wants a quick, low-effort answer",
	orchestrate: "the work should be split up and fanned out to several subagents",
	workflowz: "the work is a scripted multi-step workflow run from the eval kernel",
	jevify: "many items need classifying or judging in bulk",
};

/**
 * Descriptions that clearly ask for a keyword: if the model leaves an enabled one out, it is added.
 * Only unmistakable phrasings ("parallel" alone is not one: tests run in parallel); anything
 * subtler is the model's call.
 */
const KEYWORD_CUES: Record<string, RegExp> = {
	orchestrate:
		/\b(?:orchestrate|fan (?:it |this |the work |them )?out|sub-?agents?|(?:several|multiple|a few|a team of) agents)\b/i,
	ultrathink: /\b(?:ultrathink|think (?:really )?(?:hard|deeply|carefully)|deep(?:ly)? reason(?:ing)?)\b/i,
};

/** A negation shortly before a cue, in the same clause: "don't use subagents", "without sub-agents". */
const NEGATED_RE = /\b(?:don'?t|do not|doesn'?t|does not|no|not|never|without|avoid)\b[^.,;:!?]{0,24}$/i;

/** omp's magic-keyword boundaries (pi-tui `magicKeywordRegex`): standalone prose, case-sensitive. */
function keywordRegex(word: string, flags = ""): RegExp {
	const escaped = word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	return new RegExp(
		String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)${escaped}(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`,
		`${flags}u`,
	);
}

/** Whether `text` holds `word` as a magic keyword omp would fire on. */
export function hasKeyword(text: string, word: string): boolean {
	return keywordRegex(word).test(text);
}

/** Keywords the description clearly asks for, among the enabled ones; a negated cue asks for nothing. */
export function keywordHints(description: string, enabled: readonly string[]): string[] {
	return enabled.filter(word => {
		const cue = KEYWORD_CUES[word];
		if (!cue) return false;
		const match = cue.exec(description);
		return match !== null && !NEGATED_RE.test(description.slice(0, match.index));
	});
}

/** Cut to `maxBytes` of UTF-8 on a code-point boundary, marking the cut with an ellipsis. */
function clip(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let out = "";
	let used = Buffer.byteLength("…");
	for (const char of text) {
		const size = Buffer.byteLength(char);
		if (used + size > maxBytes) break;
		out += char;
		used += size;
	}
	return `${out}…`;
}

/** Words too common to say anything about which page or setting a description means. */
const STOP: Record<string, true> = Object.fromEntries(
	"a an and are as at be but by can do for from get how i in into is it its me my of on or so that the this to up use using want we what when with you your all any make need some should"
		.split(" ")
		.map(w => [w, true] as const),
);

/** Lowercased word tokens of 3+ letters, camelCase split, stop words dropped. */
function words(text: string): string[] {
	return text
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(w => w.length >= 3 && STOP[w] !== true);
}

/** Two words name the same thing: equal, or one a 4+ letter prefix of the other (compact/compaction). */
function sameWord(a: string, b: string): boolean {
	if (a === b) return true;
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	return short.length >= 4 && long.startsWith(short);
}

/** Generic words in doc page names that never pick a page alone. */
const PAGE_NOISE: Record<string, true> = {
	architecture: true,
	runtime: true,
	reference: true,
	guide: true,
	plan: true,
	internals: true,
	pipeline: true,
	lifecycle: true,
};

/**
 * Doc pages the description clearly needs: every telling word of a page's name appears in the
 * description (or the description names it as `omp://<page>`). Pages with more matching words
 * come first; at most {@link MAX_DOC_PAGES}.
 */
export function pickDocPages(docs: readonly string[], description: string): string[] {
	const said = words(description);
	const named = new Set([...description.matchAll(/omp:\/\/([\w./-]+)/g)].map(m => m[1]!.replace(/\.md$/, "")));
	const scored: { name: string; score: number }[] = [];
	for (const name of docs) {
		const stem = name.replace(/\.md$/, "");
		if (named.has(stem)) {
			scored.push({ name, score: 100 });
			continue;
		}
		const telling = words(stem).filter(w => PAGE_NOISE[w] !== true);
		if (telling.length === 0) continue;
		if (telling.every(w => said.some(s => sameWord(s, w)))) scored.push({ name, score: telling.length });
	}
	return scored
		.sort((a, b) => b.score - a.score || a.name.length - b.name.length)
		.slice(0, MAX_DOC_PAGES)
		.map(s => s.name);
}

/**
 * Settings that match the description: each description word scores against the setting's id and
 * label/description words; a setting needs two hits, or one in its id, to count. Best first.
 */
export function matchSettings(settings: readonly SettingEntry[], description: string, limit = MAX_SETTINGS): SettingEntry[] {
	const said = [...new Set(words(description))];
	if (said.length === 0) return [];
	const scored: { setting: SettingEntry; score: number }[] = [];
	for (const setting of settings) {
		const idWords = words(setting.id);
		const textWords = words(setting.description);
		let score = 0;
		let inId = false;
		for (const word of said) {
			if (idWords.some(w => sameWord(w, word))) {
				score += 2;
				inId = true;
			} else if (textWords.some(w => sameWord(w, word))) score += 1;
		}
		if (score >= 2 && inId) scored.push({ setting, score });
	}
	return scored
		.sort((a, b) => b.score - a.score || a.setting.id.length - b.setting.id.length)
		.slice(0, limit)
		.map(s => s.setting);
}

export function buildPromptSystem(catalogue: Catalogue): string {
	const keywords = catalogue.keywords.map(word => `  ${word}: ${KEYWORD_USES[word] ?? "see its omp docs"}`);
	return [
		"You turn a plain-language description into the text the user types into omp's composer. omp is a coding agent in the terminal.",
		"You never do the task yourself: you write what asks omp to do it. Pick exactly one kind:",
		'- "command": the description is really one of the catalogue\'s slash commands. text is "/<command> <arguments>" on one line.',
		'- "setting": the description asks to change an omp setting. text is "omp config set <key> <value>" on one line, the key taken from "Matching settings".',
		'- "prompt": anything else. text is a clear prompt for omp\'s agent, in the user\'s voice, imperative, a few sentences at most. Keep the user\'s intent; never invent files, paths or requirements.',
		"In a prompt:",
		"- Name every catalogue skill that applies, written exactly skill://<name> (for example: Read skill://<name> first). Only skills in the catalogue exist; never write /skill: or skill:<name>.",
		catalogue.keywords.length
			? "- When the description fits a magic keyword, put that word in the prose exactly as listed, lowercase and standalone. Enabled keywords:"
			: "- Write no magic keywords: none are enabled.",
		...keywords,
		"- Point at an omp doc page as omp://<page> only when one listed page clearly helps.",
		'Reply with JSON only, no code fence: {"kind": "prompt" | "command" | "setting", "text": "<the composer text>", "explain": "<one short plain-words sentence: what sending it does>"}',
	].join("\n");
}

function settingLine(s: SettingEntry): string {
	const values = s.values.length ? ` one of ${s.values.join("|")}` : "";
	const fallback = s.default ? `, default ${clip(s.default, 60)}` : "";
	return `- ${s.id} (${s.type}${values}${fallback})${s.description ? `: ${clip(s.description, 160)}` : ""}`;
}

/**
 * The request: system prompt, then the catalogue, matching settings, doc pages and the
 * description, within {@link PROMPT_REQUEST_BUDGET}. When over, doc pages go first (last page
 * first), then the catalogue shrinks to names only.
 */
export function buildPromptRequest(packet: PromptPacket): PromptRequest {
	const system = buildPromptSystem(packet.catalogue);
	const description = `Description: ${clip(packet.description.replace(/\s+/g, " ").trim(), DESCRIPTION_BYTES)}`;
	const hints = keywordHints(packet.description, packet.catalogue.keywords);
	const fixed = [
		...(packet.settings.length ? ["Matching settings (omp config set <key> <value>):", ...packet.settings.map(settingLine)] : []),
		...(hints.length ? [`Keywords this description asks for: ${hints.join(", ")}`] : []),
	];
	const pages = [...packet.pages];
	const assemble = (catalogue: string) =>
		[
			catalogue,
			...fixed,
			...pages.map(page => `omp doc omp://${page.name}:\n${page.text}`),
			"",
			description,
		]
			.filter((part, index) => part !== "" || index > 0)
			.join("\n");
	const room = PROMPT_REQUEST_BUDGET - Buffer.byteLength(system);
	const fullCatalogue = packet.catalogue.render();
	let user = assemble(fullCatalogue);
	while (Buffer.byteLength(user) > room && pages.length > 0) {
		pages.pop();
		user = assemble(fullCatalogue);
	}
	if (Buffer.byteLength(user) > room) {
		const rest = Buffer.byteLength(assemble("")) + 1;
		user = assemble(packet.catalogue.render(Math.max(0, room - rest)));
	}
	return { system, user };
}

/** The model's answer before landing; undefined when the reply holds none. */
export interface RawPromptAnswer {
	kind: PromptKind | undefined;
	text: string;
	explain: string;
}

/** Pull `{kind, text, explain}` out of the reply: JSON (fenced or not), else the reply as a prompt. */
export function parsePromptReply(reply: string): RawPromptAnswer | undefined {
	const text = reply.trim();
	const candidates: string[] = [];
	const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fence) candidates.push(fence[1]!.trim());
	const brace = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (brace !== -1 && last > brace) candidates.push(text.slice(brace, last + 1));
	for (const candidate of candidates) {
		try {
			const value = JSON.parse(candidate) as Record<string, unknown>;
			if (typeof value.text !== "string" || !value.text.trim()) continue;
			const kind = value.kind === "prompt" || value.kind === "command" || value.kind === "setting" ? value.kind : undefined;
			return {
				kind,
				text: value.text.trim(),
				explain: typeof value.explain === "string" ? value.explain.trim().replace(/\s+/g, " ") : "",
			};
		} catch {}
	}
	const bare = text.replace(/^```\w*\s*|```$/g, "").trim();
	if (!bare || bare.startsWith("{")) return undefined;
	return { kind: undefined, text: bare, explain: "" };
}

const CONFIG_SET_RE = /^!*\s*(?:omp\s+)?config\s+set\s+(\S+)(?:\s+([\s\S]*))?$/;

/** A skill reference: `skill://name`, `/skill:name` or `skill:name`; the name ends on a letter, digit or `_`. */
const SKILL_REF_RE = /(?<![\w/:-])(?:skill:\/\/|\/?skill:)([A-Za-z0-9](?:[\w.-]*\w)?)/g;

/** Every skill reference as `skill://<name>` when installed; one that isn't installed keeps only its name. */
function fixSkills(text: string, installed: ReadonlySet<string>, warnings: string[]): string {
	return text.replace(SKILL_REF_RE, (_ref, name: string) => {
		if (installed.has(name)) return `skill://${name}`;
		warnings.push(`skill ${name} is not installed`);
		return name;
	});
}

/** The first line of `text`, trimmed. */
function firstLine(text: string): string {
	return text.split(/\r?\n/, 1)[0]!.trim();
}

/**
 * Make the model's answer safe to land: the right form per kind, installed skills only, enabled
 * keywords only, and an enabled keyword the description clearly asks for. `settingKnown` says
 * whether omp has a setting by that id. Throws when nothing is left to land.
 */
export function landAnswer(
	raw: RawPromptAnswer,
	description: string,
	catalogue: Catalogue,
	settingKnown: (id: string) => boolean,
): PromptAnswer {
	const warnings: string[] = [];
	let text = raw.text.replace(/\r\n?/g, "\n").trim();
	let kind = raw.kind;
	const first = firstLine(text);
	const configSet = CONFIG_SET_RE.exec(first);
	// Unless the model says it is a setting, only a line written as one (`!…`, `omp config set …`)
	// becomes one: prose such as "config set to prod is wrong" stays a prompt, never a `!` line.
	if (configSet && (kind === "setting" || /^(?:!|omp\s)/.test(first))) kind = "setting";
	else if (kind === "setting") kind = "prompt";

	if (kind === "setting") {
		const [, key, value = ""] = configSet!;
		if (!settingKnown(key!)) warnings.push(`omp has no setting ${key}`);
		return { kind, text: `!omp config set ${key}${value.trim() ? ` ${value.trim()}` : ""}`, explain: raw.explain, warnings };
	}

	// Never a line omp would run or recast.
	text = text.replace(/^[?!\s]+/, "");
	const slash = /^\/(\S+)/.exec(text)?.[1];
	// A "prompt" that is a known slash command runs as one on Enter: call it what it is.
	if (kind === undefined || (slash !== undefined && catalogue.commands.some(c => c.name === slash))) {
		kind = slash !== undefined ? "command" : "prompt";
	}
	if (kind === "command") {
		const line = firstLine(text).replace(/^\/*/, "");
		const name = line.split(/\s+/, 1)[0]!;
		if (name.startsWith("skill:")) {
			// omp's /skill: token is a prompt to run a skill: write it as a prompt naming the skill.
			kind = "prompt";
			text = `Use ${line}`;
		} else {
			if (!catalogue.commands.some(c => c.name === name)) warnings.push(`/${name} is not a command omp lists here`);
			text = `/${line}`;
		}
	}

	// Arguments of a command get the same care as a prompt: installed skills only, enabled keywords only.
	text = fixSkills(text, new Set(catalogue.skills.map(s => s.name)), warnings);
	for (const word of catalogue.disabledKeywords) {
		if (!hasKeyword(text, word)) continue;
		text = text
			.replace(keywordRegex(word, "g"), "")
			.replace(/[ \t]{2,}/g, " ")
			.replace(/ +([.,;:!?])/g, "$1")
			.trim();
		warnings.push(`${word} is switched off`);
	}
	if (!text.replace(/^\//, "").trim()) throw new Error("the model gave no prompt");
	if (kind === "command") return { kind, text, explain: raw.explain, warnings };

	for (const word of keywordHints(description, catalogue.keywords)) {
		if (hasKeyword(text, word)) continue;
		// "Orchestrate the review" already says it: lowercase it so omp fires, rather than repeat the word.
		const capitalised = keywordRegex(word, "i").exec(text);
		text = capitalised ? `${text.slice(0, capitalised.index)}${word}${text.slice(capitalised.index + word.length)}` : `${text} ${word}`;
	}
	return { kind: "prompt", text, explain: raw.explain, warnings };
}

/** The packet for `description`: doc pages it needs read from the catalogue, settings that match it. */
export async function promptPacket(description: string, catalogue: Catalogue): Promise<PromptPacket> {
	const pages = await catalogue.readDocs(pickDocPages(catalogue.docs, description));
	return { description, catalogue, pages, settings: matchSettings(catalogue.settings, description) };
}

/**
 * One prompt spell: build the request from the catalogue and the description, ask `complete`,
 * land the answer. Throws when the reply holds no answer.
 */
export async function castPrompt(
	description: string,
	catalogue: Catalogue,
	complete: (request: PromptRequest) => Promise<string>,
	settingKnown: (id: string) => boolean,
): Promise<PromptAnswer> {
	const request = buildPromptRequest(await promptPacket(description, catalogue));
	const raw = parsePromptReply(await complete(request));
	if (!raw) throw new Error("the model gave no prompt");
	return landAnswer(raw, description, catalogue, settingKnown);
}
