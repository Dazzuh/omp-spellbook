import {
	addPromptSpell,
	addSpell,
	BookReadError,
	findSpells,
	readBook,
	type SpellKind,
	type SpellMatch,
	type SpellOf,
	tokens,
	writeBook,
} from "./book";
import { destructiveReason } from "./danger";
import type { MorphDisplay } from "./editor";
import { FRAME_MS, morphFrames } from "./morph";
import { type CastRequest, castPrefix, parseCast, parseShellLine, type PromptCast, type ShellCast } from "./parse";
import type { CastAnswer, PromptAnswer } from "./prompt";
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
	/** Ask the model for a command; resolves with its answer, the model's name and what it looked up. */
	ask(description: string, signal: AbortSignal): Promise<{ answer: CastAnswer; model: string; lookups?: string[] }>;
	/** Ask the model for a prompt for omp's agent; resolves with its answer, the model's name and what it looked up. */
	askPrompt(description: string, signal: AbortSignal): Promise<{ answer: PromptAnswer; model: string; lookups?: string[] }>;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	paint(color: string, text: string): string;
}

/**
 * What Spellbook put in the composer, waiting to be sent so it can be saved: a command (sent
 * through `user_bash`) or a prompt spell's text (sent through `input`).
 */
type Pending =
	| { kind: "command"; words: string; sigil: "!" | "!!"; command: string }
	| { kind: "prompt"; words: string; text: string };

/** What a cast lands: the composer text, the line under it, and what to save once it is sent. */
interface Landing {
	target: string;
	line: string;
	pending: Pending;
}

/** The plain-words line under the composer: what the command does, with a warning first when it destroys data. */
export function plainWordsLine(answer: CastAnswer, paint: (color: string, text: string) => string): string {
	const reason = destructiveReason(answer.text) ?? (answer.destructive ? "changes or deletes data" : undefined);
	const explain = answer.explain || "No explanation from the model; read the command before sending it.";
	if (!reason) return `${paint("accent", "✦")} ${explain}`;
	return `${paint("error", `⚠ Destructive: ${reason}.`)} ${explain}`;
}

/** The line under the composer for a prompt spell: what sending it does. */
export function promptWordsLine(answer: PromptAnswer, paint: (color: string, text: string) => string): string {
	return `${paint("accent", "✦")} ${answer.explain || "No explanation from the model; read the prompt before sending it."}`;
}

/** Whether `sent` is still the prompt Spellbook landed, edits allowed: at least half of the landed prompt's words. */
export function stillThePrompt(landed: string, sent: string): boolean {
	const want = new Set(tokens(landed));
	if (want.size === 0) return false;
	const have = new Set(tokens(sent));
	let shared = 0;
	for (const word of want) if (have.has(word)) shared++;
	return shared * 2 >= want.size;
}

export class Spellbook {
	#pending: Pending | undefined;
	#morphTimer: unknown;
	/** The text the running morph ends on; set only while frames are still to come. */
	#morphTarget: string | undefined;
	#castAbort: AbortController | undefined;
	/** The composer text the line under it describes (a landed or picked spell); undefined when it describes none. */
	#landed: string | undefined;

	constructor(readonly deps: SpellbookDeps) {}

	/**
	 * The composer changed (omp's editor onChange). Once the landed spell is no longer in it, wiped
	 * or replaced, the line under the composer goes too. Morph frames and the spell line waiting on
	 * the model are ignored. The spell stays pending, so sending it still saves it as before.
	 */
	onTextChange(text: string): void {
		const landed = this.#landed;
		if (landed === undefined || this.#morphTarget !== undefined || this.#castAbort) return;
		const sent = parseShellLine(text);
		const holds = landed.startsWith("!")
			? sent !== undefined && sent.command.split(/\s+/, 1)[0] === parseShellLine(landed)?.command.split(/\s+/, 1)[0]
			: text.trim() !== "" && stillThePrompt(landed, text);
		if (holds) return;
		this.#landed = undefined;
		this.deps.ui.setLine(undefined);
	}

	/** Saved spells of `kind` (commands by default) matching `query`; an unreadable book reports once and matches nothing. */
	find<K extends SpellKind = "command">(query: string, limit?: number, kind?: K): SpellMatch<SpellOf<K>>[] {
		try {
			return findSpells(readBook(this.deps.bookFile()), query, limit, kind);
		} catch (error) {
			if (error instanceof BookReadError) this.deps.ui.notify(error.message, "warning");
			return [];
		}
	}

	/**
	 * The `input` hook: a `?`, `?!` or `?!!` line is taken and cast (returns `{ handled: true }`).
	 * Enter during a morph is taken too and finishes the morph, so a half-drawn spell never goes
	 * out. A sent prompt spell is saved; a `!` line keeps a pending spell for `user_bash` to save;
	 * anything else drops it and any cast still in flight.
	 */
	onInput(text: string): { handled: true } | undefined {
		const target = this.#morphTarget;
		if (target !== undefined) {
			this.#stopMorph();
			this.deps.ui.setText(target);
			return { handled: true };
		}
		const cast = parseCast(text);
		if (cast) {
			void this.cast(cast);
			return { handled: true };
		}
		this.#castAbort?.abort();
		const pending = this.#pending;
		const shell = parseShellLine(text);
		if (pending?.kind === "prompt" && !shell && stillThePrompt(pending.text, text.trim())) {
			this.#save(pending.words, "prompt", text.trim());
		}
		if (!shell) this.#pending = undefined;
		this.#landed = undefined;
		this.deps.ui.setLine(undefined);
		return undefined;
	}

	/**
	 * The `user_bash` hook: save the command that was sent under the words that asked for it. An
	 * edited command is saved as sent; a command for another program is not the spell's answer.
	 */
	onUserBash(command: string): void {
		const pending = this.#pending;
		this.#pending = undefined;
		if (pending?.kind !== "command" || !command.trim()) return;
		const [sentProgram] = command.trim().split(/\s+/, 1);
		const [spellProgram] = pending.command.trim().split(/\s+/, 1);
		if (sentProgram === spellProgram) this.#save(pending.words, "command", command);
	}

	#save(words: string, kind: SpellKind, text: string): void {
		const file = this.deps.bookFile();
		try {
			const book = readBook(file);
			writeBook(file, kind === "command" ? addSpell(book, words, text) : addPromptSpell(book, words, text));
		} catch (error) {
			this.deps.ui.notify(
				`Spellbook could not save "${words}": ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	/**
	 * Turn a description into a command (`?!`/`?!!`) or an omp prompt (`?`) and morph it into the
	 * composer. Never sends or runs anything.
	 */
	async cast(request: CastRequest): Promise<void> {
		const { ui } = this.deps;
		this.#castAbort?.abort();
		this.#stopMorph();
		const abort = new AbortController();
		this.#castAbort = abort;
		const typed = `${castPrefix(request)} ${request.description}`;
		ui.setText(typed);
		const waiting = request.kind === "prompt" ? "✦ Spellbook is writing the prompt…" : "✦ Spellbook is finding the command…";
		ui.setLine(this.deps.paint("dim", waiting));
		this.#setCasting(typed);
		let landing: Landing;
		try {
			landing =
				request.kind === "prompt"
					? await this.#askPrompt(request, abort.signal)
					: await this.#askShell(request, abort.signal);
		} catch (error) {
			if (abort.signal.aborted) return;
			ui.setLine(undefined);
			ui.notify(`Spellbook: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		} finally {
			if (this.#castAbort === abort) {
				this.#castAbort = undefined;
				this.#setCasting(undefined);
			}
		}
		if (abort.signal.aborted) return;
		if (ui.getText() !== typed) {
			// The user moved on while the model answered: offer the answer without clobbering their text.
			const [head = "", ...more] = landing.target.split("\n");
			ui.setLine(`${landing.line} ${this.deps.paint("dim", `(not inserted: ${head}${more.length ? " …" : ""})`)}`);
			return;
		}
		ui.setLine(landing.line);
		this.#landed = landing.target;
		this.#pending = landing.pending;
		this.morph(typed, landing.target);
	}

	async #askShell(request: ShellCast, signal: AbortSignal): Promise<Landing> {
		const { answer } = await this.deps.ask(request.description, signal);
		return {
			target: `${request.sigil}${answer.text}`,
			line: plainWordsLine(answer, this.deps.paint),
			pending: { kind: "command", words: request.description, sigil: request.sigil, command: answer.text },
		};
	}

	async #askPrompt(request: PromptCast, signal: AbortSignal): Promise<Landing> {
		const { answer } = await this.deps.askPrompt(request.description, signal);
		return {
			target: answer.text,
			line: promptWordsLine(answer, this.deps.paint),
			pending: { kind: "prompt", words: request.description, text: answer.text },
		};
	}

	/** A spell picked from the Tab list: into the composer with no model call. */
	pick(pick: SpellPick): void {
		this.#castAbort?.abort();
		const { ui, paint } = this.deps;
		const saved = `Saved for "${pick.words}".`;
		if (pick.kind === "prompt") {
			this.#pending = { kind: "prompt", words: pick.words, text: pick.prompt };
			ui.setLine(`${paint("accent", "✦")} ${saved}`);
			this.#landed = pick.prompt;
			this.morph(ui.getText(), pick.prompt);
			return;
		}
		this.#pending = { kind: "command", words: pick.words, sigil: pick.sigil, command: pick.command };
		ui.setLine(plainWordsLine({ text: pick.command, explain: saved, destructive: false }, paint));
		this.#landed = `${pick.sigil}${pick.command}`;
		this.morph(ui.getText(), `${pick.sigil}${pick.command}`);
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
				this.#stopMorph();
				return;
			}
			const frame = frames[index++]!;
			const last = index >= frames.length;
			this.#morphTarget = last ? undefined : to;
			display.frame = last ? undefined : frame;
			display.editor?.invalidate();
			ui.setText(frame.text);
			shown = frame.text;
			if (!last) this.#morphTimer = this.deps.setTimeout(step, FRAME_MS);
		};
		step();
	}

	/** Mark `text` as the line waiting on the model (it pulses; Tern's glow breathes), or none, and redraw. */
	#setCasting(text: string | undefined): void {
		const { display } = this.deps;
		if (display.casting === text) return;
		display.casting = text;
		display.editor?.invalidate();
		display.repaint?.();
	}

	#endFrame(): void {
		this.deps.display.frame = undefined;
		this.deps.display.editor?.invalidate();
	}

	#stopMorph(): void {
		if (this.#morphTimer !== undefined) this.deps.clearTimeout(this.#morphTimer);
		this.#morphTimer = undefined;
		this.#morphTarget = undefined;
		this.#endFrame();
	}

	/** Stop timers and requests (session shutdown). */
	dispose(): void {
		this.#castAbort?.abort();
		this.#stopMorph();
	}
}
