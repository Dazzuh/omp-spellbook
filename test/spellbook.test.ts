import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readBook } from "../src/book";
import { type CompletionProvider, wrapAutocomplete } from "../src/autocomplete";
import { type HookableEditor, hookEditor, type MorphDisplay, SHIMMER_PERIOD_MS, SPELL_SIGIL_TOKENS, type SpellLook } from "../src/editor";
import type { CastAnswer, ContextPacket } from "../src/prompt";
import type { MorphStyle } from "../src/settings";
import { Spellbook } from "../src/spellbook";

/** A fake composer plus a manual clock, so frames can be counted and stepped. */
function harness(options: { answer?: CastAnswer; style?: MorphStyle; reduceMotion?: boolean; gate?: Promise<void> } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spellbook-flow-"));
	const state = {
		text: "",
		line: undefined as string | undefined,
		history: [] as string[],
		notes: [] as string[],
		asked: [] as ContextPacket[],
		timers: [] as (() => void)[],
	};
	const display: MorphDisplay = { frame: undefined, ternReduceMotion: false, editor: undefined, casting: undefined };
	const answer: CastAnswer = options.answer ?? { command: "ls -la", explain: "Lists every file here.", destructive: false };
	const book = new Spellbook({
		ui: {
			getText: () => state.text,
			setText: text => {
				state.text = text;
				state.history.push(text);
			},
			setLine: line => {
				state.line = line;
			},
			notify: message => {
				state.notes.push(message);
			},
		},
		display,
		settings: () => ({ style: options.style ?? "diff", bookPath: "book.json", recentCommands: 5 }),
		bookFile: () => path.join(dir, "book.json"),
		reduceMotion: () => options.reduceMotion === true || display.ternReduceMotion,
		context: () => ({
			cwd: dir,
			os: "Test OS",
			shell: { platform: "linux", shell: "/bin/bash", family: "bash", notes: [] },
			sshHosts: [],
			recentCommands: [],
		}),
		ask: async packet => {
			state.asked.push(packet);
			await options.gate;
			return { answer, model: "test/model" };
		},
		setTimeout: fn => {
			state.timers.push(fn);
			return state.timers.length;
		},
		clearTimeout: () => {
			state.timers = [];
		},
		paint: (color, text) => `<${color}>${text}</${color}>`,
	});
	/** Submit like omp: the editor resets, then the input hook runs. */
	const submit = (text: string) => {
		state.text = "";
		return book.onInput(text);
	};
	const flush = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
		while (state.timers.length) state.timers.shift()!();
	};
	return { dir, state, book, display, submit, flush };
}

let h: ReturnType<typeof harness>;
afterEach(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe("? and ??", () => {
	beforeEach(() => {
		h = harness();
	});

	test("? <desc> is taken from omp and ends as !<command> in the composer, never run", async () => {
		expect(h.submit("? list files here")).toEqual({ handled: true });
		await h.flush();
		expect(h.state.text).toBe("!ls -la");
		expect(h.state.history[0]).toBe("? list files here");
		expect(h.state.history.length).toBeGreaterThan(10);
		expect(h.state.line).toContain("Lists every file here.");
		expect(h.display.frame).toBeUndefined();
		expect(h.state.asked[0]!.description).toBe("list files here");
	});

	test("?? <desc> ends as !!<command>", async () => {
		h.submit("?? list files here");
		await h.flush();
		expect(h.state.text).toBe("!!ls -la");
	});

	test("ordinary prompts and ! lines pass through to omp", () => {
		expect(h.submit("explain this code")).toBeUndefined();
		expect(h.submit("!ls")).toBeUndefined();
	});

	test("typing over the composer mid-morph stops the morph and keeps the user's text", async () => {
		h.submit("? list files here");
		for (let i = 0; i < 5; i++) await Promise.resolve();
		h.state.timers.shift()!();
		h.state.text = "my own text";
		while (h.state.timers.length) h.state.timers.shift()!();
		expect(h.state.text).toBe("my own text");
		expect(h.display.frame).toBeUndefined();
	});

	test("Enter mid-morph never sends a half-drawn command: it finishes the morph and waits", async () => {
		h.submit("? list files here");
		for (let i = 0; i < 5; i++) await Promise.resolve();
		for (let i = 0; i < 3; i++) h.state.timers.shift()!();
		const halfDrawn = h.state.text;
		expect(halfDrawn).not.toBe("!ls -la");
		// omp clears the editor, then asks the input hook; handled means nothing is sent or run.
		expect(h.submit(halfDrawn)).toEqual({ handled: true });
		expect(h.state.text).toBe("!ls -la");
		expect(h.state.timers).toHaveLength(0);
		expect(h.display.frame).toBeUndefined();
		// The next Enter is the user's: the full command passes through to omp.
		expect(h.submit("!ls -la")).toBeUndefined();
	});
});

describe("destructive commands", () => {
	test("the plain-words line carries a warning (local check, even if the model says safe)", async () => {
		h = harness({ answer: { command: "rm -rf build", explain: "Deletes the build folder.", destructive: false } });
		h.submit("? delete the build folder");
		await h.flush();
		expect(h.state.text).toBe("!rm -rf build");
		expect(h.state.line).toContain("⚠ Destructive: deletes files.");
		expect(h.state.line).toContain("Deletes the build folder.");
	});

	test("the model's own destructive flag also warns", async () => {
		h = harness({ answer: { command: "my-tool --purge", explain: "Purges the cache.", destructive: true } });
		h.submit("? purge the tool cache");
		await h.flush();
		expect(h.state.line).toContain("⚠ Destructive");
	});
});

describe("reduce motion", () => {
	test("motion off: the command appears in one step, no frames", async () => {
		h = harness({ reduceMotion: true });
		h.submit("? list files here");
		await h.flush();
		expect(h.state.history).toEqual(["? list files here", "!ls -la"]);
	});

	test("Tern's Reduce Motion, read from the editor's describe, also stops the animation", async () => {
		h = harness();
		const editor: HookableEditor = {
			invalidate() {},
			decorateText: undefined,
			describeDecorations: undefined,
			describe: (_cx: { reduceMotion?: boolean }) => "node",
		};
		hookEditor(editor, h.display, (_c, t) => t);
		editor.describe({ reduceMotion: true });
		h.submit("? list files here");
		await h.flush();
		expect(h.state.history).toEqual(["? list files here", "!ls -la"]);
	});

	for (const style of ["diff", "decode", "rewind"] as const) {
		test(`${style}: animates when motion is on`, async () => {
			h = harness({ style });
			h.submit("? list files here");
			await h.flush();
			expect(h.state.history.length).toBeGreaterThan(10);
			expect(h.state.text).toBe("!ls -la");
		});
	}
});

describe("spellbook file and Tab", () => {
	beforeEach(() => {
		h = harness();
	});

	test("a sent ? command is saved under the words, and Tab on a new ? line offers it", async () => {
		h.submit("? list files here");
		await h.flush();
		// The user edits the command before sending; the edited one is what gets saved.
		expect(h.submit("!ls -la --color")).toBeUndefined();
		h.book.onUserBash("ls -la --color");
		expect(readBook(path.join(h.dir, "book.json")).entries).toMatchObject([
			{ words: "list files here", command: "ls -la --color", uses: 1 },
		]);

		const base: CompletionProvider & { extra(): string } = {
			applyCompletion: () => ({ lines: ["base"], cursorLine: 0, cursorCol: 4 }),
			getForceFileSuggestions: async () => ({ items: [{ value: "file", label: "file" }], prefix: "" }),
			extra: () => "kept",
		};
		const picks: string[] = [];
		const provider = wrapAutocomplete(base, {
			find: q => h.book.find(q),
			onPick: pick => {
				picks.push(pick.command);
				h.book.pick(pick);
			},
		});
		expect(provider.extra()).toBe("kept");
		expect(provider.shouldTriggerFileCompletion!(["? list"], 0, 6)).toBe(true);
		const suggestions = await provider.getForceFileSuggestions!(["? list"], 0, 6);
		expect(suggestions?.items).toEqual([
			{ value: "spellbook:0", label: "list files here", description: "ls -la --color" },
		]);
		// Non-? lines still get omp's own completion.
		expect((await provider.getForceFileSuggestions!(["src/"], 0, 4))?.items[0]!.value).toBe("file");

		// Picking needs no model call and lands as !<command>.
		const asked = h.state.asked.length;
		h.state.text = "? list";
		const applied = provider.applyCompletion(["? list"], 0, 6, suggestions!.items[0]!, "? list");
		applied.onApplied!();
		await h.flush();
		expect(picks).toEqual(["ls -la --color"]);
		expect(h.state.asked.length).toBe(asked);
		expect(h.state.text).toBe("!ls -la --color");
	});

	test("a ? command replaced by a normal prompt is not saved", async () => {
		h.submit("? list files here");
		await h.flush();
		h.submit("never mind, explain the repo");
		h.book.onUserBash("ls");
		expect(fs.existsSync(path.join(h.dir, "book.json"))).toBe(false);
	});

	test("an edited command is saved as sent; a command for another program is not", async () => {
		h.submit("? list files here");
		await h.flush();
		h.submit("!ls -la src");
		h.book.onUserBash("ls -la src");
		h.submit("? list files here");
		await h.flush();
		h.submit("!git status");
		h.book.onUserBash("git status");
		const book = JSON.parse(fs.readFileSync(path.join(h.dir, "book.json"), "utf8"));
		expect(book.entries.map((s: { command: string }) => s.command)).toEqual(["ls -la src"]);
	});

	test("an unreadable spellbook is reported and never overwritten", async () => {
		fs.writeFileSync(path.join(h.dir, "book.json"), "{ broken");
		h.submit("? list files here");
		await h.flush();
		h.book.onUserBash("ls -la");
		expect(fs.readFileSync(path.join(h.dir, "book.json"), "utf8")).toBe("{ broken");
		expect(h.state.notes.join("\n")).toContain("not valid");
	});
});

describe("editor hooks", () => {
	test("during a morph the editor paints marks (ANSI and Tern); otherwise its own hooks run", () => {
		const display: MorphDisplay = { frame: undefined, ternReduceMotion: false, editor: undefined, casting: undefined };
		let invalidated = 0;
		const editor: HookableEditor = {
			invalidate: () => {
				invalidated++;
			},
			decorateText: (text: string) => `own(${text})`,
			describeDecorations: (_lines: readonly string[]) => [{ from: 0, to: 1, s: "hide" }],
			describe: (_cx: { reduceMotion?: boolean }) => "node",
		};
		hookEditor(editor, display, (color, text) => `<${color}>${text}</${color}>`);
		expect(display.editor).toBe(editor);
		expect(editor.decorateText!("abc", { line: 0, startCol: 0, endCol: 3 })).toBe("own(abc)");
		expect(editor.describeDecorations!(["!ls"])).toEqual([{ from: 0, to: 1, s: "hide" }]);

		display.frame = {
			text: "? ab\ncdef",
			marks: [
				{ from: 2, to: 3, kind: "gone" },
				{ from: 6, to: 8, kind: "new" },
			],
		};
		expect(editor.decorateText!("ab", { line: 0, startCol: 2, endCol: 4 })).toBe("<toolDiffRemoved>a</toolDiffRemoved>b");
		expect(editor.decorateText!("def", { line: 1, startCol: 1, endCol: 4 })).toBe(
			"<toolDiffAdded>de</toolDiffAdded>f",
		);
		// The `?` keeps the spell's mark through the morph, so Tern's chip and glow last until `!` lands.
		expect(editor.describeDecorations!(["? ab", "cdef"])).toEqual([
			{ from: 0, to: 1, s: SPELL_SIGIL_TOKENS },
			{ from: 2, to: 3, s: "toolDiffRemoved" },
			{ from: 6, to: 8, s: "toolDiffAdded" },
		]);
		expect(invalidated).toBe(0);
	});

	/** A hooked editor holding `text`, with a plain-terminal look whose hues print as `<h…>`. */
	function spellEditor(text: string, options: { motion?: boolean; native?: boolean; now?: number } = {}) {
		const display: MorphDisplay = { frame: undefined, ternReduceMotion: false, editor: undefined, casting: undefined };
		const own = [{ from: 0, to: 1, s: "own" }];
		const editor: HookableEditor = {
			invalidate() {},
			decorateText: (t: string) => `own(${t})`,
			describeDecorations: () => own,
			describe: () => "node",
			getText: () => text,
			focused: true,
		};
		const look: SpellLook = {
			motion: () => options.motion ?? true,
			hue: degrees => `<h${Math.round(degrees)}>`,
			native: () => options.native ?? false,
			now: () => options.now ?? 0,
		};
		hookEditor(editor, display, (color, t) => `<${color}>${t}</${color}>`, look);
		return { editor, display, own, lines: text.split("\n") };
	}

	test("a ? line in Tern: the sigil carries the plugin's marker pair, the description shimmers like a magic keyword", () => {
		const { editor, display, lines } = spellEditor("? find big files");
		expect(editor.describeDecorations!(lines)).toEqual([
			{ from: 0, to: 1, s: "accent mono" },
			{ from: 2, to: 16, s: "accent", fx: "shimmer" },
		]);
		display.casting = "? find big files";
		expect(editor.describeDecorations!(lines)).toEqual([
			{ from: 0, to: 1, s: "accent mono", fx: "pulse" },
			{ from: 2, to: 16, s: "accent", fx: "pulse" },
		]);
		// Only the line being cast pulses: a spell typed over it while the model answers shimmers.
		display.casting = "? find big file";
		expect(editor.describeDecorations!(lines)[1]!.fx).toBe("shimmer");
		expect(spellEditor("  ??list it").editor.describeDecorations!(["  ??list it"])).toEqual([
			{ from: 2, to: 4, s: "accent mono" },
			{ from: 4, to: 11, s: "accent", fx: "shimmer" },
		]);
	});

	test("the ? never hides: without Tern's plugin it is the only mark of a spell", () => {
		expect(SPELL_SIGIL_TOKENS.split(" ")).toContain("accent");
		expect(SPELL_SIGIL_TOKENS.split(" ")).not.toContain("hide");
	});

	test("reduced motion: no shimmer, no pulse; the look stays", () => {
		const { editor, display, lines } = spellEditor("? find big files", { motion: false });
		display.casting = "? find big files";
		expect(editor.describeDecorations!(lines)).toEqual([
			{ from: 0, to: 1, s: "accent mono" },
			{ from: 2, to: 16, s: "accent" },
		]);
	});

	test("a bare ? or ?? is already a spell: the sigil is marked before any words are typed", () => {
		for (const [text, from, to] of [["?", 0, 1], ["?? ", 0, 2], ["  ?", 2, 3]] as const) {
			const { editor, lines } = spellEditor(text);
			expect(editor.describeDecorations!(lines)).toEqual([{ from, to, s: "accent mono" }]);
			expect(editor.decorateText!(text, { line: 0, startCol: 0, endCol: text.length })).toBe(
				`${text.slice(0, from)}<accent>${text.slice(from, to)}</accent>${text.slice(to)}`,
			);
		}
	});

	for (const text of ["please orchestrate this", "look at @src/index.ts", "/skill:kata do it", "!ls", "???", "what? no", "?\nnot a spell"]) {
		test(`not a spell, omp's own decorations: ${JSON.stringify(text)}`, () => {
			const { editor, own, lines } = spellEditor(text);
			expect(editor.describeDecorations!(lines)).toBe(own);
			expect(editor.decorateText!(text, { line: 0, startCol: 0, endCol: text.length })).toBe(`own(${text})`);
		});
	}

	test("a ? line in a plain terminal: the ? in accent, the description in the keyword hue sweep", () => {
		const text = "? ab\ncd";
		const still = spellEditor(text, { motion: false }).editor;
		// Five description characters ("ab\ncd") over 14 stops of 265°→325°: a 0, b 2, c 8, d 11.
		expect(still.decorateText!("? ab", { line: 0, startCol: 0, endCol: 4 })).toBe(
			"<accent>?</accent> <h265>a<h274>b\x1b[39m",
		);
		expect(still.decorateText!("cd", { line: 1, startCol: 0, endCol: 2 })).toBe("<h299>c<h312>d\x1b[39m");
		// With motion the sweep rotates with the clock, as omp's keyword shimmer does: half a period on, c 1, d 4.
		const moving = spellEditor(text, { now: SHIMMER_PERIOD_MS / 2 }).editor;
		expect(moving.decorateText!("cd", { line: 1, startCol: 0, endCol: 2 })).toBe("<h269>c<h282>d\x1b[39m");
	});

	test("the hue sweep never splits a character outside the BMP", () => {
		const text = "? a🔥b";
		const painted = spellEditor(text, { motion: false }).editor.decorateText!(text, { line: 0, startCol: 0, endCol: text.length });
		expect(painted).toContain("🔥");
		expect(painted.replace(/<[^>]*>|\x1b\[39m/g, "")).toBe(text);
	});
});

describe("casting state", () => {
	test("the spell line is marked as casting while the model answers, and not once the command lands", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		h = harness({ gate });
		let repaints = 0;
		h.display.repaint = () => repaints++;
		h.submit("? list files here");
		await Promise.resolve();
		expect(h.display.casting).toBe("? list files here");
		expect(repaints).toBeGreaterThan(0);
		release();
		await h.flush();
		expect(h.display.casting).toBeUndefined();
		expect(h.state.text).toBe("!ls -la");
	});

	test("an abandoned cast stops casting too", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		h = harness({ gate });
		h.submit("? list files here");
		await Promise.resolve();
		h.submit("never mind");
		release();
		await h.flush();
		expect(h.display.casting).toBeUndefined();
		expect(h.state.text).toBe("");
	});
});
