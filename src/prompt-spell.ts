/**
 * Prompt spells: `? <description>` becomes what to type into omp's composer, written from omp's
 * own map (doc pages, settings, magic keywords) and the live catalogue, never the conversation.
 * Two model calls: the first picks from the map what helps; the second writes the prompt from
 * what was picked. The model proposes; {@link landAnswer} makes sure what lands names only
 * installed skills (as `skill://<name>`), only enabled magic keywords, and sends omp commands and
 * settings in a form Enter runs.
 */
import { type Catalogue, type DocPage, type KeywordEntry, MAX_DOC_PAGES, type SettingEntry } from "./catalogue";
import { type DocSummary, type OmpMap, renderMap } from "./omp-map";

/** The whole request (system prompt + user message) of each of the two calls, in bytes. */
export const PROMPT_REQUEST_BUDGET = 128_000;
/** Output budget for one answer: a prompt of a few paragraphs plus its JSON. */
export const PROMPT_MAX_TOKENS = 1_500;
/** The description is cut to this many bytes. */
export const DESCRIPTION_BYTES = 1_000;
/** At most this many settings are picked from the map. */
export const MAX_PICK_SETTINGS = 8;
/** At most this many magic keywords are picked: a prompt names one or two, not a list. */
export const MAX_PICK_KEYWORDS = 2;
/** Spare bytes kept in the pick request, for separators and rounding. */
const REQUEST_MARGIN = 64;

/** What the composer gets: an agent prompt, a slash command, or an `omp config set` line. */
export type PromptKind = "prompt" | "command" | "setting";

/** What the first call picked from the map: whether the description is about omp, and doc page names, setting ids and keyword words, all in the map. */
export interface Picks {
	/** "omp" only when the reply says exactly "omp"; anything else is "work". */
	about: "omp" | "work";
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
	/** Enabled magic keywords the first call did not pick: the writer may use one, for work with parts. */
	otherKeywords: readonly KeywordEntry[];
	/** Whether the description is about omp itself (its settings, commands, memory, approvals) or work on the user's project. */
	about?: "omp" | "work";
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
		"Many descriptions are work on the user's own code, not about omp: then docs and settings usually do not fit and their arrays stay empty, but a magic keyword still can.",
		"Weigh each magic keyword by what it tells the agent: pick it when that is what the description wants done (a keyword is a word the user adds to a prompt, not a setting to change).",
		"Settings marked [experimental] or with a Risk note are picked only when nothing stable fits. Magic keywords are for work with several parts, not small single tasks.",
		"Small single tasks fit no magic keyword. Pick a keyword only when what it tells the agent is what the description asks for: work with several parts or areas fits a keyword whose notice is about splitting work across agents. At most one unless the description plainly asks for each.",
		`"about" is "omp" when the description asks to change or understand how omp itself behaves (its settings, commands, memory of the chat, approvals, models), and "work" when it asks for work on the user's own files or project.`,
		'Reply with JSON only, no code fence: {"about": "omp" or "work", "keywords": [magic keyword words from the map], "docs": [doc page names from the map], "settings": [setting ids from the map]}. Decide about first, then the keywords. Use empty arrays when nothing fits.',
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
	if (!value) return { about: "work", docs: [], settings: [], keywords: [] };
	return {
		about: value.about === "omp" ? "omp" : "work",
		docs: pickList(value.docs, docName, new Set(map.docs.map(d => d.name)), MAX_DOC_PAGES),
		settings: pickList(value.settings, s => s.trim(), new Set(map.settings.map(s => s.id)), MAX_PICK_SETTINGS),
		keywords: pickList(value.keywords, w => w.trim(), new Set(map.keywords.map(k => k.word)), MAX_PICK_KEYWORDS),
	};
}

/** The system prompt of the second call. */
export function buildPromptSystem(catalogue: Catalogue): string {
	return [
		"You turn a plain-language description into the text the user types into omp's composer. omp is a coding agent in the terminal.",
		"You never do the task yourself: you write what asks omp to do it. Pick exactly one kind:",
		'- "command": the description is really one of the catalogue\'s slash commands. text is "/<command> <arguments>" on one line.',
		'- "setting": the description asks to change an omp setting. text is "omp config set <key> <value>" on one line, the key taken from "Settings that may fit".',
		'- "prompt": anything else. text is a prompt for omp\'s agent, in the user\'s voice, imperative. Keep the user\'s intent; never invent files, paths or requirements.',
		"Decide in this order:",
		'(a) Is it about omp itself (how omp behaves, a setting, a command)? Prefer kind "command" when a listed slash command does it: "compact the conversation" is /compact. Otherwise kind "setting" when a stable listed setting does it: prefer a stable setting to one marked [experimental] or with a Risk note. A setting line shows (currently <value>) when omp has one, so never pick a setting already at the value asked for. A setting answer is right only when moving the setting from its current value to the new value does what the description asks, judged by omp\'s description of the setting and of each value. If the current value already does it, or no value does it, or the setting is about a different feature than the one described, or the only fit is an experimental or Risk-noted setting, write kind "prompt" of one or two sentences asking omp to explain the relevant feature instead: never a repo investigation, no magic keyword, no skill.',
		"(b) Any other prompt. Small work (one file, a quick fix, a question): one or two sentences, imperative, no magic keyword.",
		"(c) Any other prompt. Work with parts: at most five sentences of plain imperative prose, no headings or bullets, that state (1) the goal, (2) the scope as the description gives it, never inventing paths, files or requirements, (3) how it splits into independent parts, (4) what done looks like. Judge whether the work has parts by the block headed \"How omp's agent judges a prompt\" in the user message.",
		"Rules for every prompt: do exactly what was asked and no more. If they asked to check, review or find, do not ask to fix. Never escalate the user's words: a mess is tidied, not rewritten; check is not fix. Never add steps, files, paths, tools or requirements they did not give. The guidance block is for judging how much to write: never copy its instructions into the prompt, and never tell the agent how to run subagents, dispatch, lint, format or verify its own process; a magic keyword brings those instructions itself.",
		"- Name a catalogue skill, written exactly skill://<name> (for example: Read skill://<name> first), only when its description plainly matches this task; never hedge with \"if it applies\" or \"if relevant\". Only skills in the catalogue exist; never write /skill: or skill:<name>.",
		catalogue.keywords.length
			? '- Magic keywords: use only the ones the user message lists under "Magic keywords that fit" or "Other magic keywords switched on", and only for work with several parts (kind (c)), placed as the user message\'s placement line says: never alone at the end, never as a label, never in a sentence about the keyword itself (never "Use <keyword> so ..."). Never use a magic keyword that is not listed there.'
			: "- Write no magic keywords: none are enabled.",
		"- Point at an omp doc page as omp://<page> only when one listed page clearly helps.",
		'- Settings: a [experimental] setting or one with a Risk note is a last resort (see (a)). If you still choose "setting" for one, explain must say it is experimental or state the risk.',
		'Reply with JSON only, no code fence: {"kind": "prompt" | "command" | "setting", "text": "<the composer text>", "explain": "<one short plain-words sentence: what sending it does>"}',
	].join("\n");
}

/** One setting as the writer and the checker see it: its line, then one line per option omp describes. */
function settingLine(s: SettingEntry): string {
	const values = s.values.length ? ` one of ${s.values.join("|")}` : "";
	const fallback = s.default ? `, default ${clip(s.default, 60)}` : "";
	const experimental = s.experimental ? " [experimental]" : "";
	const description = s.description ? `: ${clip(s.description, 160)}` : "";
	const risk = s.warning ? ` Risk: ${clip(s.warning, 300)}` : "";
	const current = s.current ? ` (currently ${clip(s.current, 60)})` : "";
	const options = s.options.map(o => `\n    ${o.value}${o.description ? `: ${clip(o.description, 240)}` : ""}`).join("");
	return `- ${s.id} (${s.type}${values}${fallback})${experimental}${description}${risk}${current}${options}`;
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
		...(packet.otherKeywords.length
			? [["Other magic keywords switched on (use one only when you write a prompt for work with parts, kind (c), and what it tells the agent is what the description asks for):", ...packet.otherKeywords.map(keywordLine)].join("\n")]
			: []),
	];
	const pages = [...packet.pages];
	// omp's own words on judging a prompt: the writer judges how much to write by them.
	const guidance = packet.catalogue.guidance
		? [`How omp's agent judges a prompt (omp's own instructions: use them to judge how much to write, never copy them into the prompt):\n${packet.catalogue.guidance}`]
		: [];
	// Last, beside the description, where a small model keeps it: the keywords call 1 chose, and the rest.
	const example = packet.keywords[0]?.word ?? packet.otherKeywords[0]?.word;
	const description = [
		...(packet.about === "omp"
			? ["This description is about omp itself: answer with a command, a setting, or a short prompt asking omp to explain the feature; never a task on the user's project."]
			: []),
		descriptionLine(packet.description),
		...(packet.keywords.length ? [`If you write a prompt, use these magic keywords: ${packet.keywords.map(k => k.word).join(", ")}.`] : []),
		...(example !== undefined
			? [`When you use a magic keyword in a prompt, make one the main verb of the prompt's first sentence when it reads as a verb (for example: "${example} a review of ..."), with what the work is right after it. Never in a sentence about the keyword itself (for example: "Use ${example} to ..."), never after a comma or "with", never only in a last sentence after the first, never alone at the end or as a label.`]
			: []),
	].join("\n");
	const assemble = (catalogue: string) =>
		[catalogue, ...blocks, ...pages.map(page => `omp doc omp://${page.name}:\n${page.text}`), ...guidance, "", description]
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

/**
 * The checker's verdict: `does` is true only when the current value does not do what is asked, the new
 * value does, and the new value makes nothing the user did not ask for. Any other field, missing or not
 * a boolean, is a no. `why` is one line. Tolerant: fenced or bare JSON; anything else is a no with no reason.
 */
export function parseSettingCheck(reply: string): { does: boolean; why: string } {
	for (const candidate of jsonCandidates(reply)) {
		try {
			const value: unknown = JSON.parse(candidate);
			if (value !== null && typeof value === "object" && !Array.isArray(value)) {
				const { currentDoes, newDoes, worse, why } = value as Record<string, unknown>;
				return {
					does: currentDoes === false && newDoes === true && worse === false,
					why: typeof why === "string" ? why.replace(/\s+/g, " ").trim() : "",
				};
			}
		} catch {}
	}
	return { does: false, why: "" };
}

/**
 * A setting value as the checker reads it, with what it means: a boolean's true or false as on or off, with
 * the setting's own description; any other value with omp's description of that option, or the value alone.
 */
function valueWithDescription(setting: SettingEntry, value: string): string {
	if (setting.type === "boolean" && (value === "true" || value === "false")) {
		const text = setting.description ? `: ${clip(setting.description, 160)}` : "";
		return `${value} — ${value === "true" ? "on" : "off"}${text}`;
	}
	const text = setting.options.find(o => o.value === value)?.description;
	return text ? `${value} — ${text}` : value;
}

/** The most doc text the checker is given, in UTF-8 bytes: the header and whole paragraphs. */
const CHECK_DOC_BYTES = 4_000;

/**
 * The paragraphs of the doc pages that name the setting verbatim, each under its page, in page order.
 * Whole paragraphs only: the block stops before the next one would pass {@link CHECK_DOC_BYTES}.
 */
function settingDocBlock(setting: SettingEntry, pages: readonly DocPage[]): string {
	const header = "What omp's docs say about this setting:";
	const entries = pages.flatMap(page =>
		page.text
			.split(/\n\s*\n/)
			.map(paragraph => paragraph.trim())
			.filter(paragraph => paragraph.includes(setting.id))
			.map(paragraph => `omp://${page.name}:\n${paragraph}`),
	);
	const kept: string[] = [];
	let bytes = Buffer.byteLength(header);
	for (const entry of entries) {
		bytes += 1 + Buffer.byteLength(entry);
		if (bytes > CHECK_DOC_BYTES) break;
		kept.push(entry);
	}
	return kept.length ? [header, ...kept].join("\n") : "";
}

/**
 * The check on one setting change: the setting as omp describes it (options included), the current
 * value and the new value, each with omp's description of it, the description, and the docs the writer
 * had: the picked pages' summaries and the paragraphs that name the setting. The reply judges both ends,
 * and whether the new one makes omp do something unasked.
 */
export function buildSettingCheck(
	description: string,
	setting: SettingEntry,
	value: string,
	pages: readonly DocPage[] = [],
	summaries: readonly DocSummary[] = [],
): PromptRequest {
	let current: string;
	if (setting.current) current = valueWithDescription(setting, plainValue(setting.current));
	else if (setting.default) current = `unknown (default ${valueWithDescription(setting, plainValue(setting.default))})`;
	else current = "unknown (no default)";
	const picked = summaries.map(s => `- ${s.name}: ${s.title}. ${s.sentence}`);
	return {
		system: [
			"You check one omp setting change for someone who does not know omp. Judge only by omp's descriptions and docs below.",
			'Reply with JSON only, no code fence, the why first so you reason before you judge: {"why": "<one or two short sentences: what the current value does, what the new value does>", "currentDoes": true|false, "newDoes": true|false, "worse": true|false}. currentDoes is true when, with the current value, omp already behaves the way the description asks. newDoes is true when, with the new value, omp behaves the way the description asks (for "turn X off", a value that turns X off does). worse is true when the new value also changes something else the description did not ask about (for example more confirmations). Effects that follow directly from doing exactly what was asked are not worse.',
			"If omp's docs or the picked pages show the description is about a different feature than this setting, newDoes is false.",
			"The change is right only when currentDoes is false, newDoes is true and worse is false.",
		].join(" "),
		user: [
			settingLine(setting),
			`Current value: ${current}`,
			`New value: ${valueWithDescription(setting, value)}`,
			descriptionLine(description),
			...(picked.length ? [["Picked doc pages:", ...picked].join("\n")] : []),
			settingDocBlock(setting, pages),
		]
			.filter(part => part !== "")
			.join("\n"),
	};
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

/** Words that hedge a skill mention: "if it applies", "only if relevant", and the like. */
const SKILL_HEDGE_RE = /\b(if (it )?(applies|is relevant|relevant|applicable|needed|useful)|only if|where relevant|when relevant)\b/i;

/** Drop each sentence that names a skill and hedges it; the other sentences keep their own spacing. */
function dropHedgedSkills(text: string, warnings: string[]): string {
	// Even entries are sentences, odd ones the whitespace after each: a dropped sentence takes its whitespace along.
	const parts = text.split(/(?<=[.!?])(\s+)/);
	let out = "";
	for (let i = 0; i < parts.length; i += 2) {
		const sentence = parts[i]!;
		const refs = [...sentence.matchAll(SKILL_REF_RE)];
		if (refs.length && SKILL_HEDGE_RE.test(sentence)) {
			for (const ref of refs) warnings.push(`dropped a hedged skill mention: skill://${ref[1]}`);
			continue;
		}
		out += sentence + (parts[i + 1] ?? "");
	}
	return out.trim();
}

/** The first line of `text`, trimmed. */
function firstLine(text: string): string {
	return text.split(/\r?\n/, 1)[0]!.trim();
}

/** Drop the clause the model wrote about undoing: Spellbook writes its own undo line. */
const MODEL_UNDO_RE = /(?:^|[.!?;,])\s*\b(?:to undo|you can undo)\b[\s\S]*$/i;

/** The explain without the model's own undo clause. */
function stripUndo(explain: string): string {
	if (!MODEL_UNDO_RE.test(explain)) return explain;
	const out = explain.replace(MODEL_UNDO_RE, "").trim();
	return out && !/[.!?]$/.test(out) ? `${out}.` : out;
}

/** The setting's explain line, with what the composer must show before Enter: that it is experimental, its risk, and how to undo it; or that it changes nothing when the value is already set. */
function settingExplain(explain: string, setting: SettingEntry | undefined, value: string, alreadySet: boolean): string {
	if (!setting) return explain;
	let out = stripUndo(explain);
	if (setting.experimental && !/experimental/i.test(out)) out = out ? `Experimental setting: ${out}` : "Experimental setting.";
	if (setting.warning && !out.includes(setting.warning)) out = `${out} omp warns: ${setting.warning}`.trim();
	if (alreadySet) return `${out} It is already ${value}, so this changes nothing.`.trim();
	if (setting.current) out = `${out} To undo: !omp config set ${setting.id} ${plainValue(setting.current)}`.trim();
	return out;
}

/** A setting's value as JSON text, in the plain form `omp config set` takes: a string without its quotes. */
function plainValue(json: string): string {
	try {
		const value: unknown = JSON.parse(json);
		return typeof value === "string" ? value : json;
	} catch {
		return json;
	}
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
		const setting = catalogue.settings.find(s => s.id === key);
		const plain = value.trim();
		const alreadySet = !!setting?.current && plainValue(setting.current) === plain;
		if (!settingKnown(key!)) warnings.push(`omp has no setting ${key}`);
		if (alreadySet) warnings.push(`${key} is already ${plain}`);
		const explain = settingExplain(raw.explain, setting, plain, alreadySet);
		return { kind, text: `!omp config set ${key}${plain ? ` ${plain}` : ""}`, explain, warnings };
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
	text = dropHedgedSkills(text, warnings);
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

/** Whether the last standalone `word` in `text` is tacked on alone at the end: a full stop before it, only punctuation after it. */
function tackedOnAtEnd(text: string, word: string): boolean {
	const matches = [...text.matchAll(keywordRegex(word, "g"))];
	const last = matches[matches.length - 1];
	if (!last || last.index === undefined) return false;
	const end = last.index + last[0].length;
	return /[.!?]\s*$/.test(text.slice(0, last.index)) && /^[\s.!?]*$/.test(text.slice(end));
}

/** Whether `word` is a keyword in `text` only in its last sentence, with at least one sentence before it. */
function onlyInLastSentence(text: string, word: string): boolean {
	const sentences = text.split(/(?<=[.!?])\s+/);
	if (sentences.length < 2) return false;
	const last = sentences[sentences.length - 1]!;
	return hasKeyword(last, word) && !sentences.slice(0, -1).some(sentence => hasKeyword(sentence, word));
}

/**
 * A setting that omp's own metadata marks experimental or Risk-noted is never a one-Enter switch:
 * it lands as a prompt asking omp about the setting, and the switch is left as a line to type.
 */
function askAboutRiskySetting(answer: PromptAnswer, description: string, catalogue: Catalogue): PromptAnswer {
	if (answer.kind !== "setting") return answer;
	const match = CONFIG_SET_RE.exec(answer.text);
	const setting = catalogue.settings.find(s => s.id === match?.[1]);
	if (!setting || !(setting.experimental || setting.warning)) return answer;
	const id = setting.id;
	const value = (match?.[2] ?? "").trim();
	const asked = description.replace(/\s+/g, " ").trim().replace(/"/g, "'");
	const head = setting.experimental ? `${id} is experimental` : `${id} has a risk note`;
	const note = setting.warning ? `; omp warns: ${setting.warning.replace(/\.$/, "")}` : "";
	return {
		kind: "prompt",
		text: `Explain omp's ${setting.experimental ? "experimental " : ""}${id} setting: what setting it to ${value} changes, whether it helps with "${asked}", and how to change it back.`,
		explain: `${head}${note}, so this asks omp about it instead of switching it on. To switch it yourself: !omp config set ${id} ${value}`,
		warnings: [...answer.warnings, `${head}: asking about it instead`],
	};
}

/**
 * A setting answer that would switch a setting is checked first. Already at the value asked for, the
 * switch changes nothing: it re-lands as a prompt, with no check. Otherwise the model checks the switch
 * against omp's own descriptions, and a no re-lands as a prompt asking omp instead. Other answers pass.
 */
async function checkSetting(
	answer: PromptAnswer,
	description: string,
	catalogue: Catalogue,
	complete: (request: PromptRequest) => Promise<string>,
	pages: readonly DocPage[],
	summaries: readonly DocSummary[],
): Promise<PromptAnswer> {
	if (answer.kind !== "setting") return answer;
	const match = CONFIG_SET_RE.exec(answer.text);
	const setting = catalogue.settings.find(s => s.id === match?.[1]);
	if (!setting) return answer;
	const id = setting.id;
	const value = (match?.[2] ?? "").trim();
	let explain: string;
	let warning: string;
	if (!!setting.current && plainValue(setting.current) === value) {
		explain = `${id} is already ${value}, so changing it would do nothing; this asks omp instead.`;
		warning = `${id} is already ${value}`;
	} else {
		const check = parseSettingCheck(await complete(buildSettingCheck(description, setting, value, pages, summaries)));
		if (check.does) return answer;
		const current = setting.current ? plainValue(setting.current) : `default ${plainValue(setting.default) || "unknown"}`;
		explain = `Spellbook checked !omp config set ${id} ${value} against your current value (${current}): ${check.why || "it would not do what the description asks."} So this asks omp instead.`;
		warning = `${id} ${value} would not do what you asked`;
	}
	const asked = description.replace(/\s+/g, " ").trim().replace(/"/g, "'");
	return {
		kind: "prompt",
		text: `Explain which omp setting or feature helps with "${asked}", what it changes, and how to turn it on and off.`,
		explain,
		warnings: [...answer.warnings.filter(w => w !== warning), warning],
	};
}

/**
 * One prompt spell, in two calls. The first picks from `map` what helps write the prompt (doc
 * pages, settings, keywords); the second writes the prompt from those picks, the catalogue and the
 * description, then lands the answer. A first reply that is not JSON picks nothing, and the second
 * call still runs. Throws when the second reply holds no answer. A setting answer is then checked by a third call.
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
	const otherKeywords = map.keywords.filter(k => !picks.keywords.includes(k.word));
	const request = buildPromptRequest({ description, catalogue, pages, settings, keywords, otherKeywords, about: picks.about });
	const raw = parsePromptReply(await complete(request));
	if (!raw) throw new Error("the model gave no prompt");
	const answer = landAnswer(raw, catalogue, settingKnown);
	if (answer.kind === "prompt") {
		// A keyword omp has switched on that the writer capitalised ("Orchestrate the review") never fires in
		// omp: lowercase that one occurrence. Nothing is added that neither call wrote.
		for (const { word } of map.keywords) {
			if (!hasKeyword(answer.text, word)) {
				const capital = keywordRegex(word, "i").exec(answer.text);
				if (capital) answer.text = `${answer.text.slice(0, capital.index)}${word}${answer.text.slice(capital.index + word.length)}`;
			}
			if (tackedOnAtEnd(answer.text, word)) answer.warnings.push(`${word} was tacked on at the end`);
			else if (onlyInLastSentence(answer.text, word)) answer.warnings.push(`${word} appears only in the last sentence`);
		}
	}
	const summaries = map.docs.filter(doc => picks.docs.includes(doc.name));
	const checked = await checkSetting(askAboutRiskySetting(answer, description, catalogue), description, catalogue, complete, pages, summaries);
	// A prompt the writer wrote for a question about omp becomes the explain template. A Spellbook re-land is a new object, so it is left alone.
	if (picks.about === "omp" && checked === answer && checked.kind === "prompt") {
		const asked = description.replace(/\s+/g, " ").trim().replace(/"/g, "'");
		const docs = picks.docs.slice(0, 2).map(name => `omp://${name}`);
		const where = docs.length ? `: which feature or setting covers it (see ${docs.join(", ")})` : ": which feature or setting covers it";
		return {
			kind: "prompt",
			text: `Explain how omp handles "${asked}"${where}, what it changes, and how I turn it on or off.`,
			explain: "This is about omp itself, so it asks omp to explain the feature instead of changing your project.",
			warnings: [...checked.warnings, "about omp: asking omp to explain"],
			picks,
		};
	}
	return { ...checked, picks };
}
