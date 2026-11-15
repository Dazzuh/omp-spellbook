/**
 * Prompt spells: `? <description>` becomes what to type into omp's composer, written from omp's
 * own map (doc pages, settings, magic keywords) and the live catalogue, never the conversation.
 * Two model calls: the first picks from the map what helps; the second writes the prompt from
 * what was picked. The model proposes; {@link landAnswer} makes sure what lands names only
 * installed skills (as `skill://<name>`), only enabled magic keywords, and sends omp commands and
 * settings in a form Enter runs.
 */
import { type Catalogue, type DocPage, type KeywordEntry, MAX_DOC_PAGES, type SettingEntry } from "./catalogue";
import { type OmpMap, renderMap } from "./omp-map";

/** The whole request (system prompt + user message) of each of the two calls, in bytes. */
export const PROMPT_REQUEST_BUDGET = 128_000;
/** Output budget for one answer: a prompt of a few paragraphs plus its JSON. */
export const PROMPT_MAX_TOKENS = 1_500;
/** The description is cut to this many bytes. */
export const DESCRIPTION_BYTES = 1_000;
/** At most this many settings are picked from the map. */
export const MAX_PICK_SETTINGS = 8;
/** Spare bytes kept in the pick request, for separators and rounding. */
const REQUEST_MARGIN = 64;

/** What the composer gets: an agent prompt, a slash command, or an `omp config set` line. */
export type PromptKind = "prompt" | "command" | "setting";

/** What the first call picked from the map: doc page names, setting ids and keyword words, all in the map. */
export interface Picks {
	docs: string[];
	settings: string[];
	keywords: string[];
}

export interface PromptAnswer {
	kind: PromptKind;
	/** The composer text, ready for Enter: a prompt, `/<command> …` or `!omp config set …`. */
	text: string;
	/** One plain-words line saying what the text does. */
	explain: string;
	/** What Spellbook changed or could not check, for the line under the composer. */
	warnings: string[];
	/** What the first call picked, when the cast got that far. */
	picks?: Picks;
}

export interface PromptRequest {
	system: string;
	user: string;
}

/** What the second call sends: the description and what the first call picked for it, nothing else. */
export interface PromptPacket {
	description: string;
	catalogue: Catalogue;
	/** Doc pages the first call picked, read (at most {@link MAX_DOC_PAGES}). */
	pages: readonly DocPage[];
	/** Settings the first call picked, in its order. */
	settings: readonly SettingEntry[];
	/** Enabled magic keywords the first call picked, with omp's own descriptions. */
	keywords: readonly KeywordEntry[];
}

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

/** Cut to `maxBytes` of encoded text on a code-point boundary, marking the cut with an ellipsis. */
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

/** The description as a request's last line, whitespace collapsed and cut to {@link DESCRIPTION_BYTES}. */
function descriptionLine(description: string): string {
	return `Description: ${clip(description.replace(/\s+/g, " ").trim(), DESCRIPTION_BYTES)}`;
}

/**
 * The first call: the description and omp's map, asking for the doc pages, settings and magic
 * keywords that help write the prompt. The map is cut to fit {@link PROMPT_REQUEST_BUDGET}.
 */
export function buildPickRequest(description: string, map: OmpMap): PromptRequest {
	const system = [
		"You help write a prompt for omp, a coding agent in the terminal. The description below was written by someone who may not know omp's words: it says what they want in their own words.",
		"The map lists what omp has: doc pages, settings, magic keywords, skills and slash commands. Pick what helps write the prompt for this description: up to " +
			`${MAX_DOC_PAGES} doc pages, up to ${MAX_PICK_SETTINGS} settings, and any magic keywords that fit.`,
		"Judge by meaning, not by shared words: a description can fit a page or a setting whose words it never uses.",
		"Weigh each magic keyword by what it tells the agent: pick it when that is what the description wants done (a keyword is a word the user adds to a prompt, not a setting to change).",
		'Reply with JSON only, no code fence: {"docs": [doc page names from the map], "settings": [setting ids from the map], "keywords": [magic keyword words from the map]}. Use empty arrays when nothing fits.',
	].join("\n");
	const descLine = descriptionLine(description);
	const room = PROMPT_REQUEST_BUDGET - Buffer.byteLength(system) - Buffer.byteLength(descLine) - 2 - REQUEST_MARGIN;
	const mapText = renderMap(map, Math.max(0, room));
	return { system, user: [mapText, descLine].filter(part => part !== "").join("\n\n") };
}

/** The text that might hold a JSON object in a reply: the code fence's body, then the outermost braces. */
function jsonCandidates(reply: string): string[] {
	const text = reply.trim();
	const candidates: string[] = [];
	const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fence) candidates.push(fence[1]!.trim());
	const brace = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (brace !== -1 && last > brace) candidates.push(text.slice(brace, last + 1));
	return candidates;
}

/** The distinct strings of `value` that normalise to a name in `allowed`, in order, at most `max`. */
function pickList(value: unknown, normalise: (item: string) => string, allowed: ReadonlySet<string>, max: number): string[] {
	if (!Array.isArray(value)) return [];
	const out = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const name = normalise(item);
		if (allowed.has(name)) out.add(name);
	}
	return [...out].slice(0, max);
}

/** A doc page name as the map keys it: `omp://` stripped, `.md` added. */
function docName(name: string): string {
	const stem = name.trim().replace(/^omp:\/\//, "");
	return stem.endsWith(".md") ? stem : `${stem}.md`;
}

/**
 * The first call's picks. Tolerant: fenced or bare JSON; a missing or invalid field picks
 * nothing; a name not in the map is dropped; duplicates are dropped; the caps apply.
 */
export function parsePicks(reply: string, map: OmpMap): Picks {
	let value: Record<string, unknown> | undefined;
	for (const candidate of jsonCandidates(reply)) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				value = parsed as Record<string, unknown>;
				break;
			}
		} catch {}
	}
	if (!value) return { docs: [], settings: [], keywords: [] };
	return {
		docs: pickList(value.docs, docName, new Set(map.docs.map(d => d.name)), MAX_DOC_PAGES),
		settings: pickList(value.settings, s => s.trim(), new Set(map.settings.map(s => s.id)), MAX_PICK_SETTINGS),
		keywords: pickList(value.keywords, w => w.trim(), new Set(map.keywords.map(k => k.word)), Infinity),
	};
}

/** The system prompt of the second call. */
export function buildPromptSystem(catalogue: Catalogue): string {
	return [
		"You turn a plain-language description into the text the user types into omp's composer. omp is a coding agent in the terminal.",
		"You never do the task yourself: you write what asks omp to do it. Pick exactly one kind:",
		'- "command": the description is really one of the catalogue\'s slash commands. text is "/<command> <arguments>" on one line.',
		'- "setting": the description asks to change an omp setting. text is "omp config set <key> <value>" on one line, the key taken from "Settings that may fit".',
		'- "prompt": anything else. text is a clear prompt for omp\'s agent, in the user\'s voice, imperative, a few sentences at most. Keep the user\'s intent; never invent files, paths or requirements.',
		"In a prompt:",
		"- Name a catalogue skill, written exactly skill://<name> (for example: Read skill://<name> first), only when its description plainly matches this task; never hedge with \"if it applies\" or \"if relevant\". Only skills in the catalogue exist; never write /skill: or skill:<name>.",
		catalogue.keywords.length
			? '- When "Magic keywords that fit" lists any, put each in the prose exactly as listed, lowercase and standalone. Never use a magic keyword that is not listed there.'
			: "- Write no magic keywords: none are enabled.",
		"- Point at an omp doc page as omp://<page> only when one listed page clearly helps.",
		'Reply with JSON only, no code fence: {"kind": "prompt" | "command" | "setting", "text": "<the composer text>", "explain": "<one short plain-words sentence: what sending it does>"}',
	].join("\n");
}

function settingLine(s: SettingEntry): string {
	const values = s.values.length ? ` one of ${s.values.join("|")}` : "";
	const fallback = s.default ? `, default ${clip(s.default, 60)}` : "";
	return `- ${s.id} (${s.type}${values}${fallback})${s.description ? `: ${clip(s.description, 160)}` : ""}`;
}

function keywordLine(k: KeywordEntry): string {
	const head = k.description ? `- ${k.word}: ${clip(k.description, 300)}` : `- ${k.word}`;
	return k.notice ? `${head}\n  What it tells the agent: ${clip(k.notice, 600)}` : head;
}

/**
 * The second call: system prompt, then the catalogue, the picked settings and keywords, the picked
 * doc pages and the description, within {@link PROMPT_REQUEST_BUDGET}. When over, doc pages go
 * first (last page first), then the catalogue shrinks to names only.
 */
export function buildPromptRequest(packet: PromptPacket): PromptRequest {
	const system = buildPromptSystem(packet.catalogue);
	const blocks = [
		...(packet.settings.length
			? [["Settings that may fit (omp config set <id> <value>):", ...packet.settings.map(settingLine)].join("\n")]
			: []),
		...(packet.keywords.length ? [["Magic keywords that fit:", ...packet.keywords.map(keywordLine)].join("\n")] : []),
	];
	const pages = [...packet.pages];
	// Last, beside the description, where a small model keeps it: the keywords call 1 chose.
	const description = [
		descriptionLine(packet.description),
		...(packet.keywords.length
			? [`If you write a prompt, use these magic keywords in it, each once as a standalone lowercase word: ${packet.keywords.map(k => k.word).join(", ")}`]
			: []),
	].join("\n");
	const assemble = (catalogue: string) =>
		[catalogue, ...blocks, ...pages.map(page => `omp doc omp://${page.name}:\n${page.text}`), "", description]
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
	for (const candidate of jsonCandidates(reply)) {
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
 * Make the model's answer safe to land: the right form per kind, installed skills only, and
 * enabled keywords only. `settingKnown` says whether omp has a setting by that id. Throws when
 * nothing is left to land.
 */
export function landAnswer(raw: RawPromptAnswer, catalogue: Catalogue, settingKnown: (id: string) => boolean): PromptAnswer {
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
	return { kind: "prompt", text, explain: raw.explain, warnings };
}

/**
 * One prompt spell, in two calls. The first picks from `map` what helps write the prompt (doc
 * pages, settings, keywords); the second writes the prompt from those picks, the catalogue and the
 * description, then lands the answer. A first reply that is not JSON picks nothing, and the second
 * call still runs. Throws when the second reply holds no answer.
 */
export async function castPrompt(
	description: string,
	catalogue: Catalogue,
	map: OmpMap,
	complete: (request: PromptRequest) => Promise<string>,
	settingKnown: (id: string) => boolean,
): Promise<PromptAnswer> {
	const picks = parsePicks(await complete(buildPickRequest(description, map)), map);
	const pages = await catalogue.readDocs(picks.docs);
	const settings = picks.settings
		.map(id => map.settings.find(s => s.id === id))
		.filter((s): s is SettingEntry => s !== undefined);
	const keywords = map.keywords.filter(k => picks.keywords.includes(k.word));
	const request = buildPromptRequest({ description, catalogue, pages, settings, keywords });
	const raw = parsePromptReply(await complete(request));
	if (!raw) throw new Error("the model gave no prompt");
	const answer = landAnswer(raw, catalogue, settingKnown);
	if (answer.kind === "prompt") {
		// A keyword the pick call chose but the writer capitalised ("Orchestrate the review") never fires in
		// omp: lowercase that one occurrence. Nothing is added that neither call wrote.
		for (const { word } of keywords) {
			if (hasKeyword(answer.text, word)) continue;
			const capital = keywordRegex(word, "i").exec(answer.text);
			if (capital) answer.text = `${answer.text.slice(0, capital.index)}${word}${answer.text.slice(capital.index + word.length)}`;
		}
	}
	return { ...answer, picks };
}
