import type { MorphStyle } from "./settings";

/** A coloured range in a frame, as UTF-16 offsets into its text. */
export interface Mark {
	from: number;
	to: number;
	/** `gone`: leaving letters (red); `new`: just-arrived letters (green); `noise`: decode glyphs. */
	kind: "gone" | "new" | "noise";
}

export interface Frame {
	text: string;
	marks: Mark[];
}

/** Time between frames: about 30 a second, like the reference mockup. */
export const FRAME_MS = 33;

const NOISE = "!#$%&*+-/<=>?@^_~abcdefghijklmnopqrstuvwxyz0123456789";

type Op = { k: "keep" | "del" | "ins"; c: string };

/** Split a composer text into its leading sigil (`? `, `?? `, `!`, `!!`) and the rest. */
function splitSigil(text: string): [string, string] {
	const match = /^\s*(?:\?\??[ \t]*|!!?)/.exec(text);
	const sigil = match?.[0] ?? "";
	return [sigil, text.slice(sigil.length)];
}

/** Longest-common-subsequence alignment over code points, so shared letters stay put. */
export function align(a: readonly string[], b: readonly string[]): Op[] {
	const n = a.length;
	const m = b.length;
	if (n * m > 500_000) {
		return [...a.map(c => ({ k: "del" as const, c })), ...b.map(c => ({ k: "ins" as const, c }))];
	}
	const width = m + 1;
	const dp = new Uint16Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] =
				a[i] === b[j]
					? dp[(i + 1) * width + j + 1]! + 1
					: Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
		}
	}
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ k: "keep", c: a[i]! });
			i++;
			j++;
		} else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) ops.push({ k: "del", c: a[i++]! });
		else ops.push({ k: "ins", c: b[j++]! });
	}
	while (i < n) ops.push({ k: "del", c: a[i++]! });
	while (j < m) ops.push({ k: "ins", c: b[j++]! });
	return ops;
}

/** Builds a frame's text and marks piece by piece. */
class FrameBuilder {
	text = "";
	marks: Mark[] = [];

	push(piece: string, kind?: Mark["kind"]): void {
		if (!piece) return;
		const from = this.text.length;
		this.text += piece;
		if (!kind) return;
		const last = this.marks.at(-1);
		if (last && last.kind === kind && last.to === from) last.to = this.text.length;
		else this.marks.push({ from, to: this.text.length, kind });
	}

	frame(): Frame {
		return { text: this.text, marks: this.marks };
	}
}

/** D: diff morph with colour. Leaving letters go red and dissolve, arriving ones grow in green. */
function diffFrames(from: string, to: string): Frame[] {
	const [fromSigil, fromBody] = splitSigil(from);
	const [toSigil, toBody] = splitSigil(to);
	const ops = align(Array.from(fromBody), Array.from(toBody));
	const dels = ops.filter(o => o.k === "del").length;
	const ins = ops.filter(o => o.k === "ins").length;
	const steps = 24;
	const frames: Frame[] = [];
	for (let s = 0; s <= steps; s++) {
		const dCut = Math.round(dels * Math.min(1, s / (steps * 0.55)));
		const iCut = Math.round(ins * Math.max(0, (s - steps * 0.35) / (steps * 0.65)));
		const out = new FrameBuilder();
		out.push(s < steps / 2 ? fromSigil : toSigil);
		let d = 0;
		let k = 0;
		for (const op of ops) {
			if (op.k === "keep") out.push(op.c);
			else if (op.k === "del") {
				if (d++ >= dCut) out.push(op.c, "gone");
			} else {
				if (k < iCut) out.push(op.c, k > iCut - 4 && s < steps ? "new" : undefined);
				k++;
			}
		}
		frames.push(out.frame());
	}
	return frames;
}

/** B: decode. Scrambled glyphs sweep left to right and settle into the command. */
function decodeFrames(from: string, to: string, random: () => number): Frame[] {
	const [fromSigil, fromBody] = splitSigil(from);
	const [toSigil, toBody] = splitSigil(to);
	const source = Array.from(fromBody);
	const target = Array.from(toBody);
	const len = Math.max(source.length, target.length);
	const steps = 28;
	const band = 8;
	const frames: Frame[] = [];
	for (let s = 0; s <= steps; s++) {
		const front = (s / steps) * (len + band);
		const out = new FrameBuilder();
		out.push(s < steps / 2 ? fromSigil : toSigil);
		for (let p = 0; p < len; p++) {
			if (p < front - band) out.push(target[p] ?? "");
			else if (p < front) {
				if (p < target.length) out.push(NOISE[Math.floor(random() * NOISE.length)]!, "noise");
			} else out.push(source[p] ?? "");
		}
		frames.push(out.frame());
	}
	return frames;
}

/** C: rewind and type. The words erase backwards, then the command types itself out. */
function rewindFrames(from: string, to: string): Frame[] {
	const [fromSigil, fromBody] = splitSigil(from);
	const [toSigil, toBody] = splitSigil(to);
	const source = Array.from(fromBody);
	const target = Array.from(toBody);
	const eraseStep = Math.max(1, Math.ceil(source.length / 14));
	const typeStep = Math.max(1, Math.ceil(target.length / 24));
	const frames: Frame[] = [];
	for (let i = source.length; i >= 0; i -= eraseStep) {
		frames.push({ text: fromSigil + source.slice(0, i).join(""), marks: [] });
	}
	for (let i = 0; i <= target.length; i += typeStep) {
		frames.push({ text: toSigil + target.slice(0, i).join(""), marks: [] });
	}
	return frames;
}

/**
 * Frames that turn the composer text `from` into `to` in the given style. The last frame is always
 * exactly `to` with no marks, whatever the style; `none` is that frame alone.
 */
export function morphFrames(style: MorphStyle, from: string, to: string, random: () => number = Math.random): Frame[] {
	let frames: Frame[];
	switch (style) {
		case "diff":
			frames = diffFrames(from, to);
			break;
		case "decode":
			frames = decodeFrames(from, to, random);
			break;
		case "rewind":
			frames = rewindFrames(from, to);
			break;
		default:
			frames = [];
	}
	const last = frames.at(-1);
	if (!last || last.text !== to || last.marks.length > 0) frames.push({ text: to, marks: [] });
	return frames;
}
