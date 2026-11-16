import { describe, expect, test } from "bun:test";
import { align, morphFrames } from "../src/morph";
import { MORPH_STYLES } from "../src/settings";

const FROM = "?! restart wings and show its last 50 log lines";
const TO = "!ssh donnager-root 'systemctl restart wings && journalctl -u wings -n 50'";

function seeded(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) % 2147483648;
		return s / 2147483648;
	};
}

describe("morphFrames", () => {
	for (const style of MORPH_STYLES) {
		test(`${style} ends on exactly the command, uncoloured`, () => {
			for (const [from, to] of [
				[FROM, TO],
				["?!! list files here", "!!ls -la"],
				["?! 列出文件 😀", "!ls 😀"],
				["?!x", "!a-much-longer-command --with flags | and pipes > out.txt"],
				["? review this repo", "please review this repo"],
			] as const) {
				const frames = morphFrames(style, from, to, seeded(7));
				expect(frames.at(-1)).toEqual({ text: to, marks: [] });
				for (const frame of frames) {
					for (const mark of frame.marks) {
						expect(mark.from).toBeGreaterThanOrEqual(0);
						expect(mark.to).toBeGreaterThan(mark.from);
						expect(mark.to).toBeLessThanOrEqual(frame.text.length);
					}
				}
			}
		});
	}

	test("none is a single frame", () => {
		expect(morphFrames("none", FROM, TO)).toEqual([{ text: TO, marks: [] }]);
	});

	test("diff (D) starts from the words, shows red leaving and green arriving letters", () => {
		const frames = morphFrames("diff", FROM, TO);
		expect(frames[0]!.text).toBe(FROM);
		expect(frames.length).toBeGreaterThan(10);
		const kinds = new Set(frames.flatMap(f => f.marks.map(m => m.kind)));
		expect(kinds).toEqual(new Set(["gone", "new"]));
		// The ?! stays whole until the final frame, so omp's bash mode can't repaint the colours mid-morph.
		expect(frames.slice(0, -1).every(f => f.text.startsWith("?! "))).toBe(true);
		const quiet = morphFrames("diff", "?!! list files here", "!!ls -la");
		expect(quiet.slice(0, -1).every(f => f.text.startsWith("?!! "))).toBe(true);
		expect(quiet.slice(0, -1).every(f => f.marks.every(m => m.from >= 4))).toBe(true);
	});

	test("decode (B) sweeps noise glyphs; rewind (C) erases then types", () => {
		const decode = morphFrames("decode", FROM, TO, seeded(1));
		expect(decode.some(f => f.marks.some(m => m.kind === "noise"))).toBe(true);
		const rewind = morphFrames("rewind", FROM, TO);
		const lengths = rewind.map(f => f.text.length);
		const shortest = Math.min(...lengths);
		expect(lengths.indexOf(shortest)).toBeGreaterThan(0);
		expect(rewind.every(f => f.marks.length === 0)).toBe(true);
	});

	test("frames cover about a second at 30 fps", () => {
		for (const style of ["diff", "decode", "rewind"] as const) {
			const n = morphFrames(style, FROM, TO).length;
			expect(n).toBeGreaterThan(15);
			expect(n).toBeLessThan(60);
		}
	});
});

describe("align", () => {
	test("keeps the longest common subsequence", () => {
		const ops = align(Array.from("kitten"), Array.from("sitting"));
		expect(ops.filter(o => o.k === "keep").map(o => o.c).join("")).toBe("ittn");
		expect(
			ops
				.filter(o => o.k !== "del")
				.map(o => o.c)
				.join(""),
		).toBe("sitting");
	});
});
