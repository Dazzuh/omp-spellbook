import { addSpell, BookReadError, findSpells, readBook, type SpellMatch, writeBook } from "./book";
import { destructiveReason } from "./danger";
import type { MorphDisplay } from "./editor";
import { FRAME_MS, morphFrames } from "./morph";
import { type CastRequest, parseCast, parseShellLine } from "./parse";
import type { CastAnswer, ContextPacket } from "./prompt";
import type { SpellbookSettings } from "./settings";
import type { SpellPick } from "./autocomplete";

/** The composer and the line under it, as Spellbook uses them. */
export interface SpellbookUi {
	getText(): string;
	setText(text: string): void;
	/** Show (or with undefined, clear) the plain-words line under the composer. */
	setLine(line: string | undefined): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface SpellbookDeps {
	ui: SpellbookUi;
	display: MorphDisplay;
	settings(): SpellbookSettings;
	bookFile(): string;
	/** Whether motion is off (omp `tui.motion` or Tern's Reduce Motion). */
	reduceMotion(): boolean;
	/** The context packet minus the description and spells. */
	context(): Omit<ContextPacket, "description" | "spells">;
	/** Ask the model; resolves with its answer and the model's name. */
	ask(packet: ContextPacket, signal: AbortSignal): Promise<{ answer: CastAnswer; model: string }>;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	paint(color: string, text: string): string;
}

/** A command Spellbook put in the composer, waiting to be sent so it can be saved. */
interface Pending {
	words: string;
	sigil: "!" | "!!";
	command: string;
}

/** The plain-words line under the composer: what the command does, with a warning first when it destroys data. */
export function plainWordsLine(answer: CastAnswer, paint: (color: string, text: string) => string): string {
	const reason = destructiveReason(answer.command) ?? (answer.destructive ? "changes or deletes data" : undefined);
	const explain = answer.explain || "No explanation from the model; read the command before sending it.";
	if (!reason) return `${paint("accent", "✦")} ${explain}`;
	return `${paint("error", `⚠ Destructive: ${reason}.`)} ${explain}`;
}

export class Spellbook {
	#pending: Pending | undefined;
	#morphTimer: unknown;
	#castAbort: AbortController | undefined;

	constructor(readonly deps: SpellbookDeps) {}

	/** Saved spells matching `query`; an unreadable book reports once and matches nothing. */
	find(query: string, limit?: number): SpellMatch[] {
		try {
			return findSpells(readBook(this.deps.bookFile()), query, limit);
		} catch (error) {
			if (error instanceof BookReadError) this.deps.ui.notify(error.message, "warning");
			return [];
		}
	}

	/**
	 * The `input` hook: a `?`/`??` line is taken (returns `{ handled: true }`); a `!` line keeps a
	 * pending spell for `user_bash` to save; anything else drops it.
	 */
	onInput(text: string): { handled: true } | undefined {
		const cast = parseCast(text);
		if (cast) {
			void this.cast(cast);
			return { handled: true };
		}
		if (!parseShellLine(text)) this.#pending = undefined;
		this.deps.ui.setLine(undefined);
		return undefined;
	}

	/** The `user_bash` hook: save the command that was sent under the words that asked for it. */
	onUserBash(command: string): void {
		const pending = this.#pending;
		this.#pending = undefined;
		if (!pending || !command.trim()) return;
		const file = this.deps.bookFile();
		try {
			writeBook(file, addSpell(readBook(file), pending.words, command));
		} catch (error) {
			this.deps.ui.notify(
				`Spellbook could not save "${pending.words}": ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	/** Turn a description into a command and morph it into the composer. Never runs anything. */
	async cast(request: CastRequest): Promise<void> {
		const { ui } = this.deps;
		this.#castAbort?.abort();
		this.#stopMorph();
		const abort = new AbortController();
		this.#castAbort = abort;
		const typed = `${request.sigil === "!!" ? "??" : "?"} ${request.description}`;
		ui.setText(typed);
		ui.setLine(`${this.deps.paint("dim", "✦ Spellbook is finding the command…")}`);
		const spells = this.find(request.description, 5).map(m => ({ words: m.spell.words, command: m.spell.command }));
		let result: { answer: CastAnswer; model: string };
		try {
			result = await this.deps.ask({ ...this.deps.context(), description: request.description, spells }, abort.signal);
		} catch (error) {
			if (abort.signal.aborted) return;
			ui.setLine(undefined);
			ui.notify(`Spellbook: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		} finally {
			if (this.#castAbort === abort) this.#castAbort = undefined;
		}
		if (abort.signal.aborted) return;
		const { answer } = result;
		const target = `${request.sigil}${answer.command}`;
		const line = plainWordsLine(answer, this.deps.paint);
		if (ui.getText() !== typed) {
			// The user moved on while the model answered: offer the command without clobbering their text.
			ui.setLine(`${line} ${this.deps.paint("dim", `(not inserted: ${target})`)}`);
			return;
		}
		ui.setLine(line);
		this.#pending = { words: request.description, sigil: request.sigil, command: answer.command };
		this.morph(typed, target);
	}

	/** A spell picked from the Tab list: into the composer with no model call. */
	pick(pick: SpellPick): void {
		this.#castAbort?.abort();
		this.#pending = { words: pick.words, sigil: pick.sigil, command: pick.command };
		this.deps.ui.setLine(plainWordsLine({ command: pick.command, explain: `Saved for "${pick.words}".`, destructive: false }, this.deps.paint));
		this.morph(pick.from, `${pick.sigil}${pick.command}`);
	}

	/** Play the configured morph from `from` to `to`; with motion off, jump straight to `to`. */
	morph(from: string, to: string): void {
		this.#stopMorph();
		const { ui, display } = this.deps;
		const style = this.deps.reduceMotion() ? "none" : this.deps.settings().style;
		const frames = morphFrames(style, from, to);
		let index = 0;
		let shown = ui.getText();
		const step = (): void => {
			this.#morphTimer = undefined;
			if (ui.getText() !== shown) {
				// Typed over mid-morph: stop and leave the user's text alone.
				this.#endFrame();
				return;
			}
			const frame = frames[index++]!;
			const last = index >= frames.length;
			display.frame = last ? undefined : frame;
			display.editor?.invalidate();
			ui.setText(frame.text);
			shown = frame.text;
			if (!last) this.#morphTimer = this.deps.setTimeout(step, FRAME_MS);
		};
		step();
	}

	#endFrame(): void {
		this.deps.display.frame = undefined;
		this.deps.display.editor?.invalidate();
	}

	#stopMorph(): void {
		if (this.#morphTimer !== undefined) this.deps.clearTimeout(this.#morphTimer);
		this.#morphTimer = undefined;
		this.#endFrame();
	}

	/** Stop timers and requests (session shutdown). */
	dispose(): void {
		this.#castAbort?.abort();
		this.#stopMorph();
	}
}
