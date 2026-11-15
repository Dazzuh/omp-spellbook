/**
 * The omp catalogue a prompt spell hands the model in place of the conversation: skills, slash
 * commands, enabled magic keywords and omp doc page names from the live setup, plus the text of at
 * most three doc pages when the description needs them.
 *
 * {@link buildCatalogue} is pure over injected {@link CatalogueSources}; {@link readOmpCatalogue}
 * fills those sources from the running omp.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
	keywords: ReadonlyArray<{ id: string; word: string; description?: string; notice?: (...args: never[]) => string }>;
	/** An omp setting's current value by id (`magicKeywords.enabled`); `undefined` when unknown. */
	setting: (id: string) => unknown;
	/** omp doc page names relative to `docs/` (`getDocFilenames()`). */
	docNames: readonly string[];
	/** A doc page's text (`getEmbeddedDoc`), `undefined` when missing. */
	readDoc: (name: string) => Promise<string | undefined>;
	/** omp's setting definitions (the config registry's `all()`), for `omp config set` lines; optional. */
	settings?: ReadonlyArray<SettingSource>;
	/** The session's live tool names: orchestrate's notice renders only when this is given. */
	noticeContext?: { tools: readonly string[] };
	/** omp's delegation guidance text (`readOmpCatalogue` builds it); empty when not given. */
	guidance?: string;
}

/** One omp setting definition, as the config registry holds it. */
export interface SettingSource {
	id: string;
	type: string;
	values?: readonly string[];
	default?: unknown;
	/** Credentials are never offered to the model. */
	credential?: boolean;
	ui?: {
		label?: string;
		description?: string;
		warning?: string;
		options?: ReadonlyArray<{ value: string; label?: string; description?: string }>;
	};
}

/** One omp setting as the model sees it. */
export interface SettingEntry {
	id: string;
	type: string;
	values: readonly string[];
	/** The default as JSON text, or empty when there is none. */
	default: string;
	description: string;
	/** Whether omp marks the setting experimental: its id, label or description says so. */
	experimental: boolean;
	/** omp's risk note (`ui.warning`), or empty. */
	warning: string;
	/** The values omp describes in its UI, with their descriptions; empty when omp gives none. */
	options: ReadonlyArray<{ value: string; description: string }>;
	/** The current value as JSON text, or empty when undefined. */
	current: string;
}

/** One enabled magic keyword as the model sees it: its trigger, omp's description, and its notice if it takes no context. */
export interface KeywordEntry {
	word: string;
	description: string;
	notice?: string;
}

/** Each description is cut to this many characters (code points) in the full render. */
export const DESCRIPTION_CHARS = 120;
/** Default render budget, in UTF-8 bytes: Darryn's setup renders in full at about 11.5k. */
export const CATALOGUE_BUDGET = 16_000;
/** At most this many doc pages per request. */
export const MAX_DOC_PAGES = 3;
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
		/** Enabled magic keywords with omp's own descriptions, in {@link keywords} order. */
		readonly keywordInfo: readonly KeywordEntry[] = [],
		/** omp's own delegation guidance: the eager-task template and the orchestrate notice, as plain text. */
		readonly guidance: string = "",
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

	/** Uncapped text of one listed doc page; `undefined` when it is not listed or missing. */
	async readDocText(name: string): Promise<string | undefined> {
		const key = docKey(name);
		return this.docs.includes(key) ? this.readDoc(key) : undefined;
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

/** A setting's value as JSON text, or empty when it has none. */
function valueText(value: unknown): string {
	if (value === undefined) return "";
	return JSON.stringify(value) ?? "";
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
	// A zero-argument notice renders as it is. orchestrate's notice reads only `tools` (omp's
	// renderOrchestrateNotice), so it renders from the session's live tool list when one is given: a
	// notice guessed from no session would be wrong. workflowz's notice needs task/eval flags and is
	// never rendered here.
	const noticeFor = (k: (typeof sources.keywords)[number]): string => {
		if (typeof k.notice !== "function") return "";
		try {
			if (k.notice.length === 0) return k.notice().trim();
			if (k.id === "orchestrate" && sources.noticeContext) {
				const render = k.notice as (context: { tools: readonly string[] }) => string;
				return render({ tools: sources.noticeContext.tools }).trim();
			}
			return "";
		} catch {
			return "";
		}
	};
	const keywordInfo: KeywordEntry[] = sources.keywords
		.filter(k => master && on(`magicKeywords.${k.id}`))
		.map(k => {
			const notice = noticeFor(k);
			const description = describe(k.description);
			return notice ? { word: k.word, description, notice } : { word: k.word, description };
		});
	const disabledKeywords = sources.keywords.map(k => k.word).filter(word => !keywords.includes(word));
	const settings = (sources.settings ?? [])
		.filter(s => !s.credential)
		.map(s => ({
			id: s.id,
			type: s.type,
			values: [...(s.values ?? [])],
			default: s.default === undefined ? "" : JSON.stringify(s.default),
			description: describe([s.ui?.label, s.ui?.description].filter(Boolean).join(": ")),
			experimental:
				/experiment/i.test(s.id) ||
				/\bexperimental\b/i.test(s.ui?.label ?? "") ||
				/\bexperimental\b/i.test(s.ui?.description ?? ""),
			warning: s.ui?.warning ?? "",
			// Some settings' `ui.options` is not a list (a submenu or an option source): those offer none here.
			options: (Array.isArray(s.ui?.options) ? s.ui.options : [])
				.filter(o => typeof o?.value === "string")
				.map(o => ({ value: o.value, description: describe(o.description || o.label) })),
			current: valueText(sources.setting(s.id)),
		}));
	return new Catalogue(
		skills,
		commands,
		keywords,
		[...sources.docNames],
		sources.readDoc,
		disabledKeywords,
		settings,
		keywordInfo,
		sources.guidance ?? "",
	);
}

/** omp's eager-task template, rendered as omp renders it; `undefined` when the file cannot be read (a compiled binary, say). */
async function readEagerTask(taskBatch: boolean): Promise<string | undefined> {
	try {
		const { prompt } = await import("@oh-my-pi/pi-utils");
		// Package exports map `./*` to source, so the package dir comes from a module it does export. The
		// import is dynamic so a missing package drops only this part; the reader already loads omp this way.
		const modes = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/modes/magic-keywords"));
		const template = await readFile(join(dirname(modes), "..", "prompts", "system", "eager-task.md"), "utf8");
		return prompt.render(template, { toolRefs: { task: "task" }, taskBatch });
	} catch {
		return undefined;
	}
}

/**
 * The catalogue from the running omp: built-in commands, `pi.getCommands()` (call it from a handler
 * or event, not during extension load), magic keywords with their settings, and the doc index.
 */
export async function readOmpCatalogue(
	pi: Pick<ExtensionAPI, "getCommands"> & Partial<Pick<ExtensionAPI, "getActiveTools">>,
): Promise<Catalogue> {
	const [{ BUILTIN_SLASH_COMMAND_DEFS }, { MAGIC_KEYWORDS, renderOrchestrateNotice }, { getDocFilenames, getEmbeddedDoc }, { lookup, all }, omp] =
		await Promise.all([
			import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry"),
			import("@oh-my-pi/pi-coding-agent/modes/magic-keywords"),
			import("@oh-my-pi/pi-coding-agent/internal-urls/docs-index"),
			import("@oh-my-pi/pi-coding-agent/config/registry"),
			import("@oh-my-pi/pi-coding-agent"),
		]);
	// The session's live tool names, read only when omp offers them: orchestrate's notice names them.
	let tools: string[] | undefined;
	try {
		tools = pi.getActiveTools?.();
	} catch {
		tools = undefined;
	}
	// `task.batch` decides whether the eager-task template offers batched `task` calls; omp's default is on.
	let taskBatch = true;
	try {
		const batch = lookup("task.batch")?.get(omp.settings);
		if (typeof batch === "boolean") taskBatch = batch;
	} catch {
		taskBatch = true;
	}
	// Both texts are what omp's agent reads when it decides to work alone or split work, so the writer
	// gets the same judgement text. Rendered whether or not the orchestrate keyword is on: it is guidance,
	// not a keyword. Either part is left out when it cannot be read or rendered.
	let orchestrate: string | undefined;
	if (tools) {
		try {
			orchestrate = renderOrchestrateNotice({ tools });
		} catch {
			orchestrate = undefined;
		}
	}
	const guidance = [await readEagerTask(taskBatch), orchestrate]
		.map(part => (part === undefined ? "" : part.replace(/<\/?[A-Za-z][^<>]*>/g, "").trim()))
		.filter(part => part !== "")
		.join("\n\n");
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
		...(tools ? { noticeContext: { tools } } : {}),
		guidance,
	});
}
