import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { Mark } from "./morph";
import { spellRanges } from "./parse";

/** Shared between the morph player, the cast and the patched editor. */
export interface MorphDisplay {
	/** The frame on screen while a morph runs, with its coloured ranges; undefined otherwise. */
	frame: { text: string; marks: Mark[] } | undefined;
	/** Tern asked for reduced motion, read from the editor's last native describe. */
	ternReduceMotion: boolean;
	/** The live editor carrying Spellbook's hooks, once installed. */
	editor: { invalidate(): void } | undefined;
	/** The composer text of the cast waiting on the model; that line pulses and Tern's glow breathes. */
	casting: string | undefined;
	/** Ask omp for a new frame, once the editor is installed. */
	repaint?: () => void;
}

/** Theme colour per mark kind; the same names serve ANSI (`theme.fg`) and Tern decorations. */
export const MARK_COLOR: Record<Mark["kind"], string> = {
	gone: "toolDiffRemoved",
	new: "toolDiffAdded",
	noise: "accent",
};

/**
 * Span tokens on the `?` sigil: accent, plus `mono`, which omp never puts on a composer decoration
 * and which draws nothing visible on its own (tabular figures). The Tern half's sheet finds a spell
 * in the composer by this pair; without the plugin the `?` still shows in accent.
 */
export const SPELL_SIGIL_TOKENS = "accent mono";

/** omp's magic-keyword gradient cadence (`CustomEditor.SHIMMER_FRAME_MS` / `SHIMMER_PERIOD_MS`). */
export const SHIMMER_FRAME_MS = 70;
export const SHIMMER_PERIOD_MS = 1800;
/** Gradient stops across the description, as omp paints each magic keyword. */
export const SHIMMER_STOPS = 14;
/** Spellbook's hue sweep in degrees, purple into magenta, in the style of omp's keyword gradients. */
export const SPELL_HUE: readonly [number, number] = [265, 325];

/** A TSP editor decoration as omp's `describeDecorations` returns it. */
export interface Decoration {
	from: number;
	to: number;
	s: string;
	fx?: "shimmer" | "pulse";
}

interface DecorationContext {
	line: number;
	startCol: number;
	endCol: number;
}

/** The editor fields Spellbook wraps; all are public on omp's `Editor`. */
export interface HookableEditor {
	invalidate(): void;
	decorateText: ((text: string, context: DecorationContext) => string) | undefined;
	describeDecorations: ((lines: readonly string[]) => readonly Decoration[]) | undefined;
	describe(cx: { reduceMotion?: boolean }): unknown;
	getText?(): string;
	focused?: boolean;
}

/** How the spell line is drawn in a plain terminal and whether it may move. */
export interface SpellLook {
	/** Whether decorative motion is on (omp `tui.motion` and Tern's Reduce Motion). */
	motion(): boolean;
	/** ANSI foreground escape for an HSL hue at omp's keyword saturation and lightness. */
	hue(degrees: number): string;
	/** Whether Tern draws the composer (then the terminal clocks the shimmer, not a timer). */
	native(): boolean;
	now(): number;
}

/**
 * Tern decorations for a spell line: the sigil marked for the plugin's sheet, the description in
 * accent shimmering like a magic keyword; while this line is being cast both pulse. Undefined for
 * any other line.
 */
export function spellDecorations(text: string, state: { casting: boolean; motion: boolean }): Decoration[] | undefined {
	const spell = spellRanges(text);
	if (!spell) return undefined;
	const fx = !state.motion ? undefined : state.casting ? "pulse" : "shimmer";
	const sigil: Decoration = { ...spell.sigil, s: SPELL_SIGIL_TOKENS };
	if (fx === "pulse") sigil.fx = fx;
	if (!spell.description) return [sigil];
	const description: Decoration = { ...spell.description, s: "accent" };
	if (fx) description.fx = fx;
	return [sigil, description];
}

/** The `?`/`??` sigil leading a morph frame, so the chip stays until the line turns into `!`. */
function frameSigil(text: string): { from: number; to: number } | undefined {
	const match = /^(\s*)(\?\??)(?!\?)/.exec(text);
	if (!match) return undefined;
	const from = match[1]!.length;
	return { from, to: from + match[2]!.length };
}

/** One painted range: `paint` gets the covered slice and its offset into the whole text. */
interface PaintRange {
	from: number;
	to: number;
	paint(slice: string, offset: number): string;
}

/** ANSI paint for one segment: wrap the ranged parts of `text` (source columns `startCol..endCol`). */
function paintRanges(fullText: string, ranges: readonly PaintRange[], text: string, context: DecorationContext): string {
	let lineStart = 0;
	for (let i = 0; i < context.line; i++) {
		const nl = fullText.indexOf("\n", lineStart);
		if (nl === -1) return text;
		lineStart = nl + 1;
	}
	const segStart = lineStart + context.startCol;
	const segEnd = segStart + text.length;
	let out = "";
	let pos = segStart;
	for (const range of ranges) {
		const from = Math.max(range.from, segStart);
		const to = Math.min(range.to, segEnd);
		if (from >= to || from < pos) continue;
		out += text.slice(pos - segStart, from - segStart);
		out += range.paint(text.slice(from - segStart, to - segStart), from);
		pos = to;
	}
	return out + text.slice(pos - segStart);
}

/** ANSI paint for one segment of a morph frame: its marks in their colours. */
export function paintSegment(
	frameText: string,
	marks: readonly Mark[],
	text: string,
	context: DecorationContext,
	paint: (color: string, text: string) => string,
): string {
	const ranges = marks.map(mark => ({ from: mark.from, to: mark.to, paint: (slice: string) => paint(MARK_COLOR[mark.kind], slice) }));
	return paintRanges(frameText, ranges, text, context);
}

/**
 * omp's keyword gradient over `slice` (starting `offset` into a range `from..to`): each character
 * takes one of {@link SHIMMER_STOPS} stops across {@link SPELL_HUE}, rotated by `phase` ∈ [0, 1).
 */
export function hueSweep(
	slice: string,
	offset: number,
	range: { from: number; to: number },
	phase: number,
	hue: (degrees: number) => string,
): string {
	const n = range.to - range.from;
	const [from, to] = SPELL_HUE;
	let out = "";
	let prev = -1;
	// By code point, so an escape never lands between the halves of a surrogate pair.
	let i = 0;
	for (const ch of slice) {
		const t = ((offset + i - range.from) / n + phase) % 1;
		const stop = Math.floor(t * SHIMMER_STOPS) % SHIMMER_STOPS;
		if (stop !== prev) {
			out += hue((from + (stop / SHIMMER_STOPS) * (to - from)) % 360);
			prev = stop;
		}
		out += ch;
		i += ch.length;
	}
	return `${out}\x1b[39m`;
}

/**
 * Wrap an editor's decoration hooks: a running morph paints its marks (ANSI and Tern); a spell line
 * (`? <description>`) gets its look; otherwise the editor's own hooks run. Its native describe is
 * wrapped too, so Tern's Reduce Motion is read.
 */
export function hookEditor(
	editor: HookableEditor,
	display: MorphDisplay,
	paint: (color: string, text: string) => string,
	look?: SpellLook,
): void {
	const motion = () => (look ? look.motion() : !display.ternReduceMotion);
	let shimmerTimer: Timer | undefined;
	const scheduleShimmer = () => {
		if (shimmerTimer || !display.repaint) return;
		shimmerTimer = setTimeout(() => {
			shimmerTimer = undefined;
			display.repaint?.();
		}, SHIMMER_FRAME_MS);
		shimmerTimer.unref();
	};

	const baseAnsi = editor.decorateText;
	editor.decorateText = (text, context) => {
		const frame = display.frame;
		if (frame) {
			const ranges: PaintRange[] = frame.marks.map(mark => ({
				from: mark.from,
				to: mark.to,
				paint: slice => paint(MARK_COLOR[mark.kind], slice),
			}));
			const sigil = frameSigil(frame.text);
			if (sigil && !ranges.some(r => r.from < sigil.to && r.to > sigil.from)) {
				ranges.unshift({ ...sigil, paint: slice => paint("accent", slice) });
			}
			return ranges.length > 0 ? paintRanges(frame.text, ranges, text, context) : text;
		}
		const full = editor.getText?.();
		const spell = full === undefined ? undefined : spellRanges(full);
		if (full === undefined || !spell || !look) return baseAnsi ? baseAnsi.call(editor, text, context) : text;
		const ranges: PaintRange[] = [{ ...spell.sigil, paint: slice => paint("accent", slice) }];
		const words = spell.description;
		if (words) {
			const animated = motion() && !look.native() && editor.focused !== false;
			const phase = animated ? (look.now() % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS : 0;
			if (animated) scheduleShimmer();
			ranges.push({ ...words, paint: (slice, offset) => hueSweep(slice, offset, words, phase, look.hue) });
		}
		return paintRanges(full, ranges, text, context);
	};
	const baseTsp = editor.describeDecorations;
	editor.describeDecorations = lines => {
		const frame = display.frame;
		if (!frame) {
			const text = lines.join("\n");
			const spell = spellDecorations(text, { casting: display.casting === text, motion: motion() });
			if (spell) return spell;
			return baseTsp ? baseTsp.call(editor, lines) : [];
		}
		const decor: Decoration[] = frame.marks.map(mark => ({ from: mark.from, to: mark.to, s: MARK_COLOR[mark.kind] }));
		// Like omp's own shell mode: the `!`/`!!` sigil hides behind the bash pill.
		const bang = /^!!?/.exec(frame.text)?.[0].length ?? 0;
		if (bang > 0) return [{ from: 0, to: bang, s: "hide" }, ...decor];
		// The `?` keeps its mark through the morph, so the spell's look lasts until the command lands.
		const sigil = frameSigil(frame.text);
		if (sigil && !decor.some(d => d.from < sigil.to && d.to > sigil.from)) {
			return [{ ...sigil, s: SPELL_SIGIL_TOKENS }, ...decor];
		}
		return decor;
	};
	const baseDescribe = editor.describe;
	editor.describe = function (this: HookableEditor, cx) {
		const reduce = cx.reduceMotion === true;
		if (reduce !== display.ternReduceMotion) {
			display.ternReduceMotion = reduce;
			// Decorations are memoized per text; the spell line's effects follow the switch.
			editor.invalidate();
		}
		return baseDescribe.call(this, cx);
	};
	display.editor = editor;
}

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

/**
 * Install Spellbook's editor hooks: wrap another extension's editor when one is set, else build
 * omp's own `CustomEditor` (the class `setEditorComponent` requires). Returns false when neither is
 * possible; the morph then plays as plain text and the spell line goes unstyled.
 */
export async function installEditorHooks(
	ui: Pick<ExtensionUIContext, "getEditorComponent" | "setEditorComponent">,
	display: MorphDisplay,
	paint: (color: string, text: string) => string,
	look: SpellLook,
): Promise<boolean> {
	let make: EditorFactory | undefined = ui.getEditorComponent();
	if (!make) {
		try {
			// Dynamic on purpose: `CustomEditor` is not a root export, only a package subpath of omp's
			// pi-tui that may move between omp releases; a failed import must cost only the colour.
			const { CustomEditor } = await import("@oh-my-pi/pi-tui/prompt/custom-editor");
			make = (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings);
		} catch {
			return false;
		}
	}
	const base = make;
	ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = base(tui, theme, keybindings);
		display.repaint = () => tui.requestRender();
		// CustomEditor extends Editor, whose decoration hooks and describe are public.
		hookEditor(editor as unknown as HookableEditor, display, paint, look);
		return editor;
	});
	return true;
}
