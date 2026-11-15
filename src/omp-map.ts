/**
 * A plain-words map of the running omp, built once per session: one line per doc page (title and
 * first sentence), the settings, the enabled magic keywords with omp's own descriptions, skills and
 * slash commands. The pick call reads it to choose what a prompt needs; nothing here is hand-written
 * glossing, so omp's own words stay the source of truth.
 */
import type { Catalogue, CatalogueEntry, KeywordEntry, SettingEntry } from "./catalogue";

export interface DocSummary {
	name: string;
	title: string;
	sentence: string;
}

export interface OmpMap {
	docs: readonly DocSummary[];
	settings: readonly SettingEntry[];
	keywords: readonly KeywordEntry[];
	skills: readonly CatalogueEntry[];
	commands: readonly CatalogueEntry[];
}

/** A doc page's first sentence is cut to this many code points in the full map. */
export const MAP_SENTENCE_CHARS = 160;
/** A setting's description is cut to this many code points in the full map. */
export const MAP_SETTING_CHARS = 100;
/** A keyword's notice is cut to this many code points in the map. */
const KEYWORD_NOTICE_CHARS = 300;

/** A notice as one plain line: wrapper tags (`<system-notice>` and such) removed, whitespace collapsed, cut. */
function noticeText(notice: string): string {
	return cutChars(notice.replace(/<\/?[A-Za-z][^<>]*>/g, " ").replace(/\s+/g, " ").trim(), KEYWORD_NOTICE_CHARS);
}

const COMMAND_CHARS = 120;
const TIGHT_SETTING_CHARS = 50;
const TIGHT_SENTENCE_CHARS = 60;
const ELLIPSIS = "…";

/** Lines that are never prose: headings, lists, tables, quotes, HTML, images, rules. */
const NON_PROSE = /^\s*(?:#|[>|<]|!\[|[-*+]\s|\d+[.)]\s|([-*_])(?:\s*\1){2,}\s*$)/;

/** Cut to `max` code points, the cut marked with an ellipsis that counts toward `max`. */
function cutChars(text: string, max: number): string {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	return `${chars
		.slice(0, max - 1)
		.join("")
		.trimEnd()}${ELLIPSIS}`;
}

/**
 * The first sentence: text up to a `.`, `!` or `?` followed by a space or the end. Abbreviations
 * such as `e.g.` may cut early; that is accepted.
 */
function firstSentence(paragraph: string): string {
	const match = /^.*?[.!?](?=\s|$)/.exec(paragraph);
	return (match ? match[0] : paragraph).trim();
}

/** The page name without `omp://` or `.md`, its last path segment: the title when a page has no `# ` heading. */
function nameStem(name: string): string {
	const bare = name.trim().replace(/^omp:\/\//, "").replace(/\.md$/, "");
	return bare.split("/").pop() || bare;
}

/** Title (first `# ` heading) and first sentence of the first prose paragraph of one doc page. */
export function docSummary(name: string, text: string): DocSummary {
	let lines = text.split(/\r?\n/);
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((line, i) => i > 0 && (line.trim() === "---" || line.trim() === "..."));
		if (end > 0) lines = lines.slice(end + 1);
	}
	const found: { title?: string; sentence?: string } = {};
	let fence: string | undefined;
	let para: string[] = [];
	const endParagraph = (): void => {
		if (found.sentence === undefined && para.length) {
			found.sentence = firstSentence(para.join(" ").replace(/\s+/g, " "));
		}
		para = [];
	};
	for (const line of lines) {
		if (fence !== undefined) {
			const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
			if (close && close[1]!.startsWith(fence[0]!) && close[1]!.length >= fence.length) fence = undefined;
			continue;
		}
		const open = /^\s*(`{3,}|~{3,})/.exec(line);
		if (open) {
			endParagraph();
			fence = open[1];
			continue;
		}
		if (line.trim() === "") {
			endParagraph();
			continue;
		}
		if (/^\s*=+\s*$/.test(line) && para.length) {
			// Setext heading: the paragraph above is a heading, not prose.
			if (found.title === undefined) found.title = para.join(" ").replace(/\s+/g, " ");
			para = [];
			continue;
		}
		if (/^\s*-{2,}\s*$/.test(line) && para.length) {
			para = [];
			continue;
		}
		const heading = /^(#{1,6})\s+(.*\S)/.exec(line);
		if (heading) {
			if (found.title === undefined && heading[1] === "#") {
				found.title = heading[2]!.replace(/\s+#+\s*$/, "").trim();
			}
			endParagraph();
			continue;
		}
		if (para.length === 0 && /^(?: {4}|\t)/.test(line)) continue; // indented code block
		if (NON_PROSE.test(line)) {
			endParagraph();
			continue;
		}
		para.push(line.trim());
	}
	endParagraph();
	return {
		name,
		title: found.title?.trim() || nameStem(name),
		sentence: cutChars(found.sentence ?? "", MAP_SENTENCE_CHARS),
	};
}

/** Every listed doc page summarised, plus settings, enabled keywords, skills and commands. */
export async function buildOmpMap(catalogue: Catalogue): Promise<OmpMap> {
	const docs = await Promise.all(
		catalogue.docs.map(async name => {
			const text = await catalogue.readDocText(name);
			return text === undefined ? undefined : docSummary(name, text);
		}),
	);
	return {
		docs: docs.filter((doc): doc is DocSummary => doc !== undefined),
		settings: catalogue.settings,
		keywords: catalogue.keywordInfo,
		skills: catalogue.skills,
		commands: catalogue.commands,
	};
}

interface Line {
	text: string;
	header: boolean;
}

/** The map as lines, with the descriptions cut to the given lengths. */
function layout(map: OmpMap, settingChars: number, sentenceChars: number): Line[] {
	const section = (title: string, items: string[]): Line[] =>
		items.length ? [{ text: title, header: true }, ...items.map(text => ({ text, header: false }))] : [];
	return [
		...section(
			"Magic keywords (switched on; a standalone lowercase word in the prompt turns one on):",
			map.keywords.map(k => {
				const head = k.description ? `- ${k.word}: ${k.description}` : `- ${k.word}`;
				const notice = k.notice ? noticeText(k.notice) : "";
				return notice ? `${head} It tells the agent: ${notice}` : head;
			}),
		),
		...section(
			"omp doc pages (omp://<name>):",
			map.docs.map(d => {
				const sentence = d.sentence ? cutChars(d.sentence, sentenceChars) : "";
				return sentence ? `- ${d.name}: ${d.title}. ${sentence}` : `- ${d.name}: ${d.title}`;
			}),
		),
		...section(
			"omp settings (omp config set <id> <value>):",
			map.settings.map(s => {
				const type = s.values.length ? `${s.type} one of ${s.values.join("|")}` : s.type;
				const description = cutChars(s.description, settingChars);
				const tag = s.experimental ? " [experimental]" : "";
				const head = `- ${s.id} (${type})${tag}`;
				const risk = s.warning ? ` Risk: ${s.warning}` : "";
				return `${description ? `${head}: ${description}` : head}${risk}`;
			}),
		),
		...section(
			"Skills (skill://<name>):",
			map.skills.map(e => (e.description ? `- ${e.name}: ${cutChars(e.description, COMMAND_CHARS)}` : `- ${e.name}`)),
		),
		...section(
			"Slash commands:",
			map.commands.map(e => (e.description ? `- /${e.name}: ${cutChars(e.description, COMMAND_CHARS)}` : `- /${e.name}`)),
		),
	];
}

/** The whole lines that fit in `budget` UTF-8 bytes, a section header never left without items. */
function fit(lines: Line[], budget: number): string {
	const kept: Line[] = [];
	let bytes = 0;
	for (const line of lines) {
		const size = Buffer.byteLength(line.text) + (kept.length ? 1 : 0);
		if (bytes + size > budget) break;
		kept.push(line);
		bytes += size;
	}
	while (kept.length && kept[kept.length - 1]!.header) kept.pop();
	return kept.map(l => l.text).join("\n");
}

/**
 * The map as prompt text within `budget` UTF-8 bytes. Over budget, setting descriptions are cut
 * first, then doc sentences, then whole lines go from the end. Never splits a character.
 */
export function renderMap(map: OmpMap, budget: number): string {
	const stages: Array<[number, number]> = [
		[MAP_SETTING_CHARS, MAP_SENTENCE_CHARS],
		[TIGHT_SETTING_CHARS, MAP_SENTENCE_CHARS],
		[TIGHT_SETTING_CHARS, TIGHT_SENTENCE_CHARS],
	];
	let lines: Line[] = [];
	for (const [settingChars, sentenceChars] of stages) {
		lines = layout(map, settingChars, sentenceChars);
		const whole = lines.map(l => l.text).join("\n");
		if (Buffer.byteLength(whole) <= budget) return whole;
	}
	return fit(lines, budget);
}
