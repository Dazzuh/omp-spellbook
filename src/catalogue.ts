/**
 * The omp catalogue a prompt spell hands the model in place of the conversation: skills, slash
 * commands, enabled magic keywords and omp doc page names from the live setup, plus the text of at
 * most two doc pages when the description needs them.
 *
 * {@link buildCatalogue} is pure over injected {@link CatalogueSources}; {@link readOmpCatalogue}
 * fills those sources from the running omp.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** One skill or slash command as the model sees it. */
export interface CatalogueEntry {
	name: string;
	description: string;
}

/** What the builder reads, shaped like omp's own exports so the real reader passes them through. */
export interface CatalogueSources {
	/** omp's built-in slash commands (`BUILTIN_SLASH_COMMAND_DEFS`). */
	builtins: ReadonlyArray<{ name: string; description?: string }>;
	/** The extension API's `getCommands()`: extension, prompt and `skill:<name>` commands. */
	commands: ReadonlyArray<{ name: string; description?: string; source: string }>;
	/** `MAGIC_KEYWORDS`: `id` is the `magicKeywords.<id>` settings suffix, `word` the trigger. */
	keywords: ReadonlyArray<{ id: string; word: string }>;
	/** An omp setting's current value by id (`magicKeywords.enabled`); `undefined` when unknown. */
	setting: (id: string) => unknown;
	/** omp doc page names relative to `docs/` (`getDocFilenames()`). */
	docNames: readonly string[];
	/** A doc page's text (`getEmbeddedDoc`), `undefined` when missing. */
	readDoc: (name: string) => Promise<string | undefined>;
	/** omp's setting definitions (the config registry's `all()`), for `omp config set` lines; optional. */
	settings?: ReadonlyArray<SettingSource>;
}

/** One omp setting definition, as the config registry holds it. */
export interface SettingSource {
	id: string;
	type: string;
	values?: readonly string[];
	default?: unknown;
	/** Credentials are never offered to the model. */
	credential?: boolean;
	ui?: { label?: string; description?: string };
}

/** One omp setting as the model sees it. */
export interface SettingEntry {
	id: string;
	type: string;
	values: readonly string[];
	/** The default as JSON text, or empty when there is none. */
	default: string;
	description: string;
}

/** Each description is cut to this many characters (code points) in the full render. */
export const DESCRIPTION_CHARS = 120;
/** Default render budget, in UTF-8 bytes: Darryn's setup renders in full at about 11.5k. */
export const CATALOGUE_BUDGET = 16_000;
/** At most this many doc pages per request. */
export const MAX_DOC_PAGES = 2;
/** Each doc page's text is capped to this many UTF-8 bytes. */
export const DOC_PAGE_BYTES = 6_000;

const SKILL_PREFIX = "skill:";
const ELLIPSIS = "…";

/** Cut to `max` code points, the cut marked with an ellipsis that counts toward `max`. */
function cutChars(text: string, max: number): string {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	return `${chars
		.slice(0, max - 1)
		.join("")
		.trimEnd()}${ELLIPSIS}`;
}

/** Cut to `maxBytes` of UTF-8 on a code-point boundary, marking the cut with an ellipsis. */
function clipBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let out = "";
	let used = Buffer.byteLength(ELLIPSIS);
	for (const char of text) {
		const size = Buffer.byteLength(char);
		if (used + size > maxBytes) break;
		out += char;
		used += size;
	}
	return `${out}${ELLIPSIS}`;
}

/** Keep the first entry per name, in source order. */
function uniqueByName(entries: CatalogueEntry[]): CatalogueEntry[] {
	const seen = new Set<string>();
	return entries.filter(entry => {
		if (!entry.name || seen.has(entry.name)) return false;
		seen.add(entry.name);
		return true;
	});
}

/** Doc page name as `getDocFilenames()` lists it: `omp://` and a missing `.md` tolerated. */
function docKey(name: string): string {
	const bare = name.trim().replace(/^omp:\/\//, "");
	return bare.endsWith(".md") ? bare : `${bare}.md`;
}

export interface DocPage {
	name: string;
	text: string;
}

export class Catalogue {
	constructor(
		/** Skill names without `skill:`. */
		readonly skills: readonly CatalogueEntry[],
		/** Built-in, then extension and prompt commands, names without `/`. */
		readonly commands: readonly CatalogueEntry[],
		/** Trigger words of the enabled magic keywords. */
		readonly keywords: readonly string[],
		readonly docs: readonly string[],
		private readonly readDoc: CatalogueSources["readDoc"],
		/** Trigger words of the magic keywords that are switched off: a prompt spell never writes them. */
		readonly disabledKeywords: readonly string[] = [],
		/** omp settings a `!omp config set` line may name; never credentials. */
		readonly settings: readonly SettingEntry[] = [],
	) {}

	/**
	 * The catalogue as prompt text within `budget` UTF-8 bytes: descriptions cut to
	 * {@link DESCRIPTION_CHARS}, or names only when that is over budget. A names-only render still over
	 * budget loses whole lines from the end.
	 */
	render(budget: number = CATALOGUE_BUDGET): string {
		const full = this.lines(true).join("\n");
		if (Buffer.byteLength(full) <= budget) return full;
		const lines = this.lines(false);
		let out = "";
		for (const line of lines) {
			const next = out ? `${out}\n${line}` : line;
			if (Buffer.byteLength(next) > budget) break;
			out = next;
		}
		return out;
	}

	/**
	 * Text of at most {@link MAX_DOC_PAGES} doc pages, each capped to `maxBytes`. Names not in
	 * {@link docs} are skipped, duplicates read once.
	 */
	async readDocs(names: readonly string[], maxBytes: number = DOC_PAGE_BYTES): Promise<DocPage[]> {
		const known = new Set(this.docs);
		const wanted = [...new Set(names.map(docKey))].filter(name => known.has(name)).slice(0, MAX_DOC_PAGES);
		const pages: DocPage[] = [];
		for (const name of wanted) {
			const text = await this.readDoc(name);
			if (text !== undefined) pages.push({ name, text: clipBytes(text, maxBytes) });
		}
		return pages;
	}

	private lines(withDescriptions: boolean): string[] {
		const section = (title: string, prefix: string, entries: readonly CatalogueEntry[]): string[] => {
			if (!entries.length) return [];
			if (!withDescriptions) return [title, entries.map(e => `${prefix}${e.name}`).join(", ")];
			return [
				title,
				...entries.map(e =>
					e.description
						? `- ${prefix}${e.name}: ${cutChars(e.description, DESCRIPTION_CHARS)}`
						: `- ${prefix}${e.name}`,
				),
			];
		};
		return [
			...section("Skills (load with skill://<name>):", "", this.skills),
			...section("Slash commands:", "/", this.commands),
			...(this.keywords.length
				? ["Magic keywords (a standalone word in the prompt turns one on):", this.keywords.join(", ")]
				: []),
			...(this.docs.length ? ["omp doc pages (omp://<name>):", this.docs.join(", ")] : []),
		];
	}
}

/** The catalogue from injected sources; no omp needed. */
export function buildCatalogue(sources: CatalogueSources): Catalogue {
	const describe = (d: string | undefined) => (d ?? "").replace(/\s+/g, " ").trim();
	const skills = uniqueByName(
		sources.commands
			.filter(c => c.source === "skill")
			.map(c => ({
				name: c.name.startsWith(SKILL_PREFIX) ? c.name.slice(SKILL_PREFIX.length) : c.name,
				description: describe(c.description),
			})),
	);
	const commands = uniqueByName([
		...sources.builtins.map(c => ({ name: c.name, description: describe(c.description) })),
		...sources.commands
			.filter(c => c.source !== "skill")
			.map(c => ({ name: c.name, description: describe(c.description) })),
	]);
	const on = (id: string) => sources.setting(id) !== false;
	const master = on("magicKeywords.enabled");
	const keywords = sources.keywords.filter(k => master && on(`magicKeywords.${k.id}`)).map(k => k.word);
	const disabledKeywords = sources.keywords.map(k => k.word).filter(word => !keywords.includes(word));
	const settings = (sources.settings ?? [])
		.filter(s => !s.credential)
		.map(s => ({
			id: s.id,
			type: s.type,
			values: [...(s.values ?? [])],
			default: s.default === undefined ? "" : JSON.stringify(s.default),
			description: describe([s.ui?.label, s.ui?.description].filter(Boolean).join(": ")),
		}));
	return new Catalogue(
		skills,
		commands,
		keywords,
		[...sources.docNames],
		sources.readDoc,
		disabledKeywords,
		settings,
	);
}

/**
 * The catalogue from the running omp: built-in commands, `pi.getCommands()` (call it from a handler
 * or event, not during extension load), magic keywords with their settings, and the doc index.
 */
export async function readOmpCatalogue(pi: Pick<ExtensionAPI, "getCommands">): Promise<Catalogue> {
	const [{ BUILTIN_SLASH_COMMAND_DEFS }, { MAGIC_KEYWORDS }, { getDocFilenames, getEmbeddedDoc }, { lookup, all }, omp] =
		await Promise.all([
			import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry"),
			import("@oh-my-pi/pi-coding-agent/modes/magic-keywords"),
			import("@oh-my-pi/pi-coding-agent/internal-urls/docs-index"),
			import("@oh-my-pi/pi-coding-agent/config/registry"),
			import("@oh-my-pi/pi-coding-agent"),
		]);
	return buildCatalogue({
		builtins: BUILTIN_SLASH_COMMAND_DEFS,
		commands: pi.getCommands(),
		keywords: MAGIC_KEYWORDS,
		// Before omp's settings load (tests, early events) every keyword counts as on, its default.
		setting: id => {
			try {
				return lookup(id)?.get(omp.settings);
			} catch {
				return undefined;
			}
		},
		docNames: getDocFilenames(),
		readDoc: getEmbeddedDoc,
		settings: all().map(s => s.definition as SettingSource),
	});
}
