import type { SpellMatch } from "./book";
import { castQuery } from "./parse";

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

export interface SpellPick {
	/** The `?` line as typed. */
	from: string;
	sigil: "!" | "!!";
	words: string;
	command: string;
}

export interface SpellCompletionDeps {
	find(query: string): SpellMatch[];
	/** Called once the editor applied a pick; puts the command in the composer. */
	onPick(pick: SpellPick): void;
}

const VALUE_PREFIX = "spellbook:";

/** The whole composer text when the composer is a single `?` line with the cursor on it. */
function castLine(lines: string[], cursorLine: number): string | undefined {
	if (lines.length !== 1 || cursorLine !== 0) return undefined;
	const text = lines[0]!;
	return castQuery(text) ? text : undefined;
}

/** Providers this module already wrapped, so a factory re-added on session_start doesn't stack. */
const wrapped = new WeakSet<object>();

/**
 * Wrap omp's autocomplete provider: Tab on a `?` line lists saved spells matching the words typed so
 * far; picking one hands it to `onPick` with no model call. Anything else goes to `current`.
 */
export function wrapAutocomplete<P extends CompletionProvider>(current: P, deps: SpellCompletionDeps): P {
	if (wrapped.has(current)) return current;
	let shown = new Map<string, SpellPick>();
	const overrides: Partial<CompletionProvider> = {
		async getForceFileSuggestions(lines, cursorLine, cursorCol, signal) {
			const text = castLine(lines, cursorLine);
			if (text === undefined) {
				return current.getForceFileSuggestions
					? current.getForceFileSuggestions(lines, cursorLine, cursorCol, signal)
					: null;
			}
			const cast = castQuery(text)!;
			const matches = deps.find(cast.query);
			shown = new Map();
			const items = matches.map((match, index) => {
				const value = `${VALUE_PREFIX}${index}`;
				shown.set(value, { from: text, sigil: cast.sigil, words: match.spell.words, command: match.spell.command });
				return { value, label: match.spell.words, description: match.spell.command };
			});
			return items.length > 0 ? { items, prefix: text.slice(0, cursorCol) } : null;
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
