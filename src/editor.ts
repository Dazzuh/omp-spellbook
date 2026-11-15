import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { Mark } from "./morph";

/** Shared between the morph player and the patched editor. */
export interface MorphDisplay {
	/** The frame on screen while a morph runs, with its coloured ranges; undefined otherwise. */
	frame: { text: string; marks: Mark[] } | undefined;
	/** Tern asked for reduced motion, read from the editor's last native describe. */
	ternReduceMotion: boolean;
	/** The live editor carrying Spellbook's hooks, once installed. */
	editor: { invalidate(): void } | undefined;
}

/** Theme colour per mark kind; the same names serve ANSI (`theme.fg`) and Tern decorations. */
export const MARK_COLOR: Record<Mark["kind"], string> = {
	gone: "toolDiffRemoved",
	new: "toolDiffAdded",
	noise: "accent",
};

interface DecorationContext {
	line: number;
	startCol: number;
	endCol: number;
}

/** The editor fields Spellbook wraps; all are public on omp's `Editor`. */
export interface HookableEditor {
	invalidate(): void;
	decorateText: ((text: string, context: DecorationContext) => string) | undefined;
	describeDecorations: ((lines: readonly string[]) => readonly { from: number; to: number; s: string }[]) | undefined;
	describe(cx: { reduceMotion?: boolean }): unknown;
}

/** ANSI paint for one segment: wrap the marked parts of `text` (source columns `startCol..endCol`). */
export function paintSegment(
	frameText: string,
	marks: readonly Mark[],
	text: string,
	context: DecorationContext,
	paint: (color: string, text: string) => string,
): string {
	let lineStart = 0;
	for (let i = 0; i < context.line; i++) {
		const nl = frameText.indexOf("\n", lineStart);
		if (nl === -1) return text;
		lineStart = nl + 1;
	}
	const segStart = lineStart + context.startCol;
	const segEnd = segStart + text.length;
	let out = "";
	let pos = segStart;
	for (const mark of marks) {
		const from = Math.max(mark.from, segStart);
		const to = Math.min(mark.to, segEnd);
		if (from >= to || from < pos) continue;
		out += text.slice(pos - segStart, from - segStart);
		out += paint(MARK_COLOR[mark.kind], text.slice(from - segStart, to - segStart));
		pos = to;
	}
	return out + text.slice(pos - segStart);
}

/**
 * Wrap an editor's decoration hooks so a running morph paints its marks (ANSI and Tern), and its
 * native describe so Tern's Reduce Motion is read. Outside a morph the editor's own hooks run.
 */
export function hookEditor(
	editor: HookableEditor,
	display: MorphDisplay,
	paint: (color: string, text: string) => string,
): void {
	const baseAnsi = editor.decorateText;
	editor.decorateText = (text, context) => {
		const frame = display.frame;
		if (frame && frame.marks.length > 0) return paintSegment(frame.text, frame.marks, text, context, paint);
		if (frame) return text;
		return baseAnsi ? baseAnsi.call(editor, text, context) : text;
	};
	const baseTsp = editor.describeDecorations;
	editor.describeDecorations = lines => {
		const frame = display.frame;
		if (!frame) return baseTsp ? baseTsp.call(editor, lines) : [];
		const decor = frame.marks.map(mark => ({ from: mark.from, to: mark.to, s: MARK_COLOR[mark.kind] }));
		// Like omp's own shell mode: the `!`/`!!` sigil hides behind the bash pill.
		const sigil = /^!!?/.exec(frame.text)?.[0].length ?? 0;
		return sigil > 0 ? [{ from: 0, to: sigil, s: "hide" }, ...decor] : decor;
	};
	const baseDescribe = editor.describe;
	editor.describe = function (this: HookableEditor, cx) {
		display.ternReduceMotion = cx.reduceMotion === true;
		return baseDescribe.call(this, cx);
	};
	display.editor = editor;
}

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

/**
 * Install Spellbook's editor hooks: wrap another extension's editor when one is set, else build
 * omp's own `CustomEditor` (the class `setEditorComponent` requires). Returns false when neither is
 * possible; the morph then plays as plain text.
 */
export async function installEditorHooks(
	ui: Pick<ExtensionUIContext, "getEditorComponent" | "setEditorComponent">,
	display: MorphDisplay,
	paint: (color: string, text: string) => string,
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
		// CustomEditor extends Editor, whose decoration hooks and describe are public.
		hookEditor(editor as unknown as HookableEditor, display, paint);
		return editor;
	});
	return true;
}
