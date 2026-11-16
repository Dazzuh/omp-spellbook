import type { Spell, SpellKind, SpellMatch } from "./book";
import { type CastQuery, castQuery } from "./parse";

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

/** The parts of omp's `AutocompleteProvider` Spellbook takes over; every other member passes through. */
export interface CompletionProvider {
	getForceFileSuggestions?(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: CompletionItem[]; prefix: string } | null>;
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: CompletionItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number; onApplied?: () => void };
}

/** A saved spell picked from the Tab list: a command for a `?!`/`?!!` line, a prompt for a `?` line. */
export type SpellPick =
	| {
			kind: "command";
			/** The `?!`/`?!!` line as typed. */
			from: string;
			sigil: "!" | "!!";
			words: string;
			command: string;
	  }
	| {
			kind: "prompt";
			/** The `?` line as typed. */
			from: string;
			words: string;
			prompt: string;
	  };

export interface SpellCompletionDeps {
	/** Saved spells of `kind` matching `query`: commands for `?!`/`?!!`, prompts for `?`. May read settings first. */
	find(query: string, kind: SpellKind): SpellMatch<Spell>[] | Promise<SpellMatch<Spell>[]>;
	/** Called once the editor applied a pick; puts the spell in the composer. */
	onPick(pick: SpellPick): void;
}

const VALUE_PREFIX = "spellbook:";
/** A saved prompt shows this many characters of its first line beside its words. */
const PROMPT_PREVIEW = 80;

/** A single-line spell composer with the cursor on it: its text, kind and the words typed so far. */
function castLine(lines: string[], cursorLine: number): { text: string; cast: CastQuery } | undefined {
	if (lines.length !== 1 || cursorLine !== 0) return undefined;
	const text = lines[0]!;
	const cast = castQuery(text);
	return cast ? { text, cast } : undefined;
}

/** The Tab row and the pick for one saved spell offered on `line`. */
function offer(text: string, cast: CastQuery, spell: Spell): { description: string; pick: SpellPick } | undefined {
	if (cast.kind === "shell" && spell.kind === "command") {
		return {
			description: spell.command,
			pick: { kind: "command", from: text, sigil: cast.sigil, words: spell.words, command: spell.command },
		};
	}
	if (cast.kind === "prompt" && spell.kind === "prompt") {
		const first = spell.prompt.split(/\r?\n/, 1)[0]!;
		const chars = Array.from(first);
		const description = chars.length > PROMPT_PREVIEW ? `${chars.slice(0, PROMPT_PREVIEW - 1).join("")}…` : first;
		return { description, pick: { kind: "prompt", from: text, words: spell.words, prompt: spell.prompt } };
	}
	return undefined;
}

/** Providers this module already wrapped, so a factory re-added on session_start doesn't stack. */
const wrapped = new WeakSet<object>();

/**
 * Wrap omp's autocomplete provider: Tab on a `?!`/`?!!` line lists saved commands, Tab on a `?`
 * line saved prompt spells, matching the words typed so far; picking one hands it to `onPick`
 * with no model call. Anything else goes to `current`.
 */
export function wrapAutocomplete<P extends CompletionProvider>(current: P, deps: SpellCompletionDeps): P {
	if (wrapped.has(current)) return current;
	let shown = new Map<string, SpellPick>();
	const overrides: Partial<CompletionProvider> = {
		async getForceFileSuggestions(lines, cursorLine, cursorCol, signal) {
			const line = castLine(lines, cursorLine);
			if (line === undefined) {
				return current.getForceFileSuggestions
					? current.getForceFileSuggestions(lines, cursorLine, cursorCol, signal)
					: null;
			}
			const { text, cast } = line;
			const picks = new Map<string, SpellPick>();
			const items: CompletionItem[] = [];
			for (const match of await deps.find(cast.query, cast.kind === "shell" ? "command" : "prompt")) {
				// Each kind only ever offers its own: a saved command never lands on a `?` line.
				const row = offer(text, cast, match.spell);
				if (!row) continue;
				const value = `${VALUE_PREFIX}${items.length}`;
				picks.set(value, row.pick);
				items.push({ value, label: match.spell.words, description: row.description });
			}
			if (items.length === 0) return null;
			shown = picks;
			return { items, prefix: text.slice(0, cursorCol) };
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			if (castLine(lines, cursorLine) !== undefined) return true;
			return current.shouldTriggerFileCompletion
				? current.shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
				: true;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const pick = shown.get(item.value);
			// A spell row from an older list: insert nothing rather than the internal `spellbook:N` value.
			if (!pick && item.value.startsWith(VALUE_PREFIX)) return { lines, cursorLine, cursorCol };
			if (!pick) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			return { lines, cursorLine, cursorCol, onApplied: () => deps.onPick(pick) };
		},
	};
	const proxy = new Proxy(current, {
		get(target, prop, receiver) {
			if (Object.hasOwn(overrides, prop)) return overrides[prop as keyof CompletionProvider];
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	wrapped.add(proxy);
	return proxy;
}
