import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readBook } from "../src/book";
import { type CompletionProvider, wrapAutocomplete } from "../src/autocomplete";
import {
	type HookableEditor,
	hookEditor,
	type MorphDisplay,
	SHELL_SIGIL_TOKENS,
	SHIMMER_PERIOD_MS,
	SPELL_SIGIL_TOKENS,
	type SpellLook,
} from "../src/editor";
import spellbook from "../src/index";
import type { CastAnswer, ContextPacket } from "../src/prompt";
import type { PromptAnswer } from "../src/prompt-spell";
import type { MorphStyle } from "../src/settings";
import { Spellbook } from "../src/spellbook";

const PROMPT: PromptAnswer = {
	kind: "prompt",
	text: "Review this repo with skill://reviewer; split the work across subagents. orchestrate",
	explain: "Asks omp's agent to review the repo with several subagents.",
	warnings: [],
};

/** A fake composer plus a manual clock, so frames can be counted and stepped. */
function harness(
	options: { answer?: CastAnswer; prompt?: PromptAnswer; style?: MorphStyle; reduceMotion?: boolean; gate?: Promise<void> } = {},
) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spellbook-flow-"));
	const state = {
		text: "",
		line: undefined as string | undefined,
		history: [] as string[],
		notes: [] as string[],
		asked: [] as ContextPacket[],
		askedPrompts: [] as string[],
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
		askPrompt: async description => {
			state.askedPrompts.push(description);
			await options.gate;
			return { answer: options.prompt ?? PROMPT, model: "test/model" };
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

describe("?! and ?!!", () => {
	beforeEach(() => {
		h = harness();
	});

	test("?! <desc> is taken from omp and ends as !<command> in the composer, never run", async () => {
		expect(h.submit("?! list files here")).toEqual({ handled: true });
		await h.flush();
		expect(h.state.text).toBe("!ls -la");
		expect(h.state.history[0]).toBe("?! list files here");
		expect(h.state.history.length).toBeGreaterThan(10);
		expect(h.state.line).toContain("Lists every file here.");
		expect(h.display.frame).toBeUndefined();
		expect(h.state.asked[0]!.description).toBe("list files here");
	});

	test("?!! <desc> ends as !!<command>", async () => {
		expect(h.submit("?!! list files here")).toEqual({ handled: true });
		await h.flush();
		expect(h.state.text).toBe("!!ls -la");
	});

	test("ordinary prompts and ! lines pass through to omp", () => {
		expect(h.submit("explain this code")).toBeUndefined();
		expect(h.submit("!ls")).toBeUndefined();
	});

	test("? <desc> is taken from omp and cast as a prompt: the description alone goes to the prompt model", async () => {
		expect(h.submit("? get a few agents to review this repo")).toEqual({ handled: true });
		await h.flush();
		expect(h.state.asked).toHaveLength(0);
		expect(h.state.askedPrompts).toEqual(["get a few agents to review this repo"]);
		expect(h.state.text).toBe(PROMPT.text);
	});

	test("?? and ?!!! are not spells", async () => {
		for (const text of ["?? list files here", "??? list", "?!!! list files here"]) {
			expect(h.submit(text)).toBeUndefined();
		}
		await h.flush();
		expect(h.state.asked).toHaveLength(0);
	});

	test("typing over the composer mid-morph stops the morph and keeps the user's text", async () => {
		h.submit("?! list files here");
		for (let i = 0; i < 5; i++) await Promise.resolve();
		h.state.timers.shift()!();
		h.state.text = "my own text";
		while (h.state.timers.length) h.state.timers.shift()!();
		expect(h.state.text).toBe("my own text");
		expect(h.display.frame).toBeUndefined();
	});

	test("Enter mid-morph never sends a half-drawn command: it finishes the morph and waits", async () => {
		h.submit("?! list files here");
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
		h.submit("?! delete the build folder");
		await h.flush();
		expect(h.state.text).toBe("!rm -rf build");
		expect(h.state.line).toContain("⚠ Destructive: deletes files.");
		expect(h.state.line).toContain("Deletes the build folder.");
	});

	test("the model's own destructive flag also warns", async () => {
		h = harness({ answer: { command: "my-tool --purge", explain: "Purges the cache.", destructive: true } });
		h.submit("?! purge the tool cache");
		await h.flush();
		expect(h.state.line).toContain("⚠ Destructive");
	});
});

describe("reduce motion", () => {
	test("motion off: the command appears in one step, no frames", async () => {
		h = harness({ reduceMotion: true });
		h.submit("?! list files here");
		await h.flush();
		expect(h.state.history).toEqual(["?! list files here", "!ls -la"]);
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
		h.submit("?! list files here");
		await h.flush();
		expect(h.state.history).toEqual(["?! list files here", "!ls -la"]);
	});

	for (const style of ["diff", "decode", "rewind"] as const) {
		test(`${style}: animates when motion is on`, async () => {
			h = harness({ style });
			h.submit("?! list files here");
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

	test("a sent ?! command is saved under the words, and Tab on a new ?! line offers it", async () => {
		h.submit("?! list files here");
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
			find: (q, kind) => h.book.find(q, undefined, kind),
			onPick: pick => {
				if (pick.kind === "command") picks.push(pick.command);
				h.book.pick(pick);
			},
		});
		expect(provider.extra()).toBe("kept");
		expect(provider.shouldTriggerFileCompletion!(["?! list"], 0, 7)).toBe(true);
		const suggestions = await provider.getForceFileSuggestions!(["?! list"], 0, 7);
		expect(suggestions?.items).toEqual([
			{ value: "spellbook:0", label: "list files here", description: "ls -la --color" },
		]);
		// Non-spell lines still get omp's own completion; a ? line never offers saved commands.
		expect((await provider.getForceFileSuggestions!(["src/"], 0, 4))?.items[0]!.value).toBe("file");
		expect(await provider.getForceFileSuggestions!(["? list"], 0, 6)).toBeNull();
		expect((await provider.getForceFileSuggestions!(["?? list"], 0, 7))?.items[0]!.value).toBe("file");

		// Picking needs no model call and lands as !<command>.
		const asked = h.state.asked.length;
		h.state.text = "?! list";
		const applied = provider.applyCompletion(["?! list"], 0, 7, suggestions!.items[0]!, "?! list");
		applied.onApplied!();
		await h.flush();
		expect(picks).toEqual(["ls -la --color"]);
		expect(h.state.asked.length).toBe(asked);
		expect(h.state.text).toBe("!ls -la --color");
	});

	test("Tab on ?!! lands the saved command as !!<command>", async () => {
		h.submit("?! list files here");
		await h.flush();
		h.submit("!ls -la");
		h.book.onUserBash("ls -la");
		const base: CompletionProvider = { applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }) };
		const provider = wrapAutocomplete(base, {
			find: (q, kind) => h.book.find(q, undefined, kind),
			onPick: pick => h.book.pick(pick),
		});
		const suggestions = await provider.getForceFileSuggestions!(["?!! list"], 0, 8);
		h.state.text = "?!! list";
		provider.applyCompletion(["?!! list"], 0, 8, suggestions!.items[0]!, "?!! list").onApplied!();
		await h.flush();
		expect(h.state.text).toBe("!!ls -la");
	});

	test("a ?! command replaced by a normal prompt is not saved", async () => {
		h.submit("?! list files here");
		await h.flush();
		h.submit("never mind, explain the repo");
		h.book.onUserBash("ls");
		expect(fs.existsSync(path.join(h.dir, "book.json"))).toBe(false);
	});

	test("an edited command is saved as sent; a command for another program is not", async () => {
		h.submit("?! list files here");
		await h.flush();
		h.submit("!ls -la src");
		h.book.onUserBash("ls -la src");
		h.submit("?! list files here");
		await h.flush();
		h.submit("!git status");
		h.book.onUserBash("git status");
		const book = JSON.parse(fs.readFileSync(path.join(h.dir, "book.json"), "utf8"));
		expect(book.entries.map((s: { command: string }) => s.command)).toEqual(["ls -la src"]);
	});

	test("an unreadable spellbook is reported and never overwritten", async () => {
		fs.writeFileSync(path.join(h.dir, "book.json"), "{ broken");
		h.submit("?! list files here");
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
		// The prefix keeps the spell's mark through the morph, so Tern's chip and glow last until `!` lands.
		expect(editor.describeDecorations!(["? ab", "cdef"])).toEqual([
			{ from: 0, to: 2, s: SPELL_SIGIL_TOKENS },
			{ from: 2, to: 3, s: "toolDiffRemoved" },
			{ from: 6, to: 8, s: "toolDiffAdded" },
		]);
		// A shell spell's frame keeps its own kind's mark, and paints its prefix green in a plain terminal.
		display.frame = { text: "?!! ab", marks: [{ from: 4, to: 5, kind: "gone" }] };
		expect(editor.describeDecorations!(["?!! ab"])).toEqual([
			{ from: 0, to: 4, s: SHELL_SIGIL_TOKENS["!!"] },
			{ from: 4, to: 5, s: "toolDiffRemoved" },
		]);
		expect(editor.decorateText!("?!! ab", { line: 0, startCol: 0, endCol: 6 })).toBe(
			"<success>?!!</success> <toolDiffRemoved>a</toolDiffRemoved>b",
		);
		// Once the line is `!…`, it hides behind omp's bash chip as omp's own shell mode does.
		display.frame = { text: "!!ls", marks: [] };
		expect(editor.describeDecorations!(["!!ls"])).toEqual([{ from: 0, to: 2, s: "hide" }]);
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

	test("a ? line in Tern: the prefix carries the plugin's marker pair, the description shimmers like a magic keyword", () => {
		const { editor, display, lines } = spellEditor("? find big files");
		// The marker covers the prefix and the space after it: the chip stands in for both.
		expect(editor.describeDecorations!(lines)).toEqual([
			{ from: 0, to: 2, s: "accent mono" },
			{ from: 2, to: 16, s: "accent", fx: "shimmer" },
		]);
		display.casting = "? find big files";
		expect(editor.describeDecorations!(lines)).toEqual([
			{ from: 0, to: 2, s: "accent mono", fx: "pulse" },
			{ from: 2, to: 16, s: "accent", fx: "pulse" },
		]);
		// Only the line being cast pulses: a spell typed over it while the model answers shimmers.
		display.casting = "? find big file";
		expect(editor.describeDecorations!(lines)[1]!.fx).toBe("shimmer");
	});

	test("?! and ?!! lines in Tern: each kind has its own marker, the description shimmers", () => {
		expect(spellEditor("?! find big files").editor.describeDecorations!(["?! find big files"])).toEqual([
			{ from: 0, to: 3, s: "success mono" },
			{ from: 3, to: 17, s: "accent", fx: "shimmer" },
		]);
		expect(spellEditor("  ?!!list it").editor.describeDecorations!(["  ?!!list it"])).toEqual([
			{ from: 2, to: 5, s: "success mono strong" },
			{ from: 5, to: 12, s: "accent", fx: "shimmer" },
		]);
		const { editor, display, lines } = spellEditor("?! find big files");
		display.casting = "?! find big files";
		expect(editor.describeDecorations!(lines)[0]).toEqual({ from: 0, to: 3, s: "success mono", fx: "pulse" });
	});

	test("the three markers are distinct, coloured, never hidden, and never a pair omp emits in the composer", () => {
		const markers = [SPELL_SIGIL_TOKENS, SHELL_SIGIL_TOKENS["!"], SHELL_SIGIL_TOKENS["!!"]];
		expect(new Set(markers).size).toBe(3);
		// omp 18.20.2's own composer decorations (custom-editor.ts).
		const omp = ["accent", "accent strong", "customMessageLabel strong", "statusLineModel strong", "dim", "typo", "hide"];
		for (const marker of markers) {
			const tokens = marker.split(" ");
			expect(tokens).not.toContain("hide");
			expect(tokens).toContain("mono");
			expect(tokens.some(t => t === "accent" || t === "success")).toBe(true);
			expect(omp).not.toContain(marker);
		}
		// The sheet tells ?!! from ?! by a token ?! lacks.
		expect(SHELL_SIGIL_TOKENS["!!"].split(" ").some(t => !SHELL_SIGIL_TOKENS["!"].split(" ").includes(t))).toBe(true);
	});

	test("the prefix never hides: without Tern's plugin it is the only mark of a spell", () => {
		expect(SPELL_SIGIL_TOKENS.split(" ")).toContain("accent");
		expect(SPELL_SIGIL_TOKENS.split(" ")).not.toContain("hide");
	});

	test("reduced motion: no shimmer, no pulse; the look stays", () => {
		const { editor, display, lines } = spellEditor("? find big files", { motion: false });
		display.casting = "? find big files";
		expect(editor.describeDecorations!(lines)).toEqual([
			{ from: 0, to: 2, s: "accent mono" },
			{ from: 2, to: 16, s: "accent" },
		]);
	});

	test("a bare ?, ?! or ?!! is already a spell: the prefix is marked before any words are typed", () => {
		const cases = [
			["?", 0, 1, 1, "accent mono", "accent"],
			["?! ", 0, 2, 3, "success mono", "success"],
			["  ?!!", 2, 5, 5, "success mono strong", "success"],
		] as const;
		for (const [text, from, to, lead, s, color] of cases) {
			const { editor, lines } = spellEditor(text);
			expect(editor.describeDecorations!(lines)).toEqual([{ from, to: lead, s }]);
			expect(editor.decorateText!(text, { line: 0, startCol: 0, endCol: text.length })).toBe(
				`${text.slice(0, from)}<${color}>${text.slice(from, to)}</${color}>${text.slice(to)}`,
			);
		}
	});

	for (const text of [
		"please orchestrate this",
		"look at @src/index.ts",
		"/skill:kata do it",
		"!ls",
		"??",
		"?? list files",
		"???",
		"?!!!",
		"?!!! list files",
		"what? no",
		"?\nnot a spell",
	]) {
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

	test("a ?! line in a plain terminal: the prefix in success green, the description in the hue sweep", () => {
		const still = spellEditor("?!! ab", { motion: false }).editor;
		expect(still.decorateText!("?!! ab", { line: 0, startCol: 0, endCol: 6 })).toBe(
			"<success>?!!</success> <h265>a<h295>b\x1b[39m",
		);
	});
});

describe("casting state", () => {
	test("the spell line is marked as casting while the model answers, and not once the command lands", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		h = harness({ gate });
		let repaints = 0;
		h.display.repaint = () => repaints++;
		h.submit("?! list files here");
		await Promise.resolve();
		expect(h.display.casting).toBe("?! list files here");
		expect(repaints).toBeGreaterThan(0);
		release();
		await h.flush();
		expect(h.display.casting).toBeUndefined();
		expect(h.state.text).toBe("!ls -la");
	});

	test("an abandoned cast stops casting too", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		h = harness({ gate });
		h.submit("?! list files here");
		await Promise.resolve();
		h.submit("never mind");
		release();
		await h.flush();
		expect(h.display.casting).toBeUndefined();
		expect(h.state.text).toBe("");
	});
});

describe("/spellbook cast", () => {
	test("casts its words as a ?! shell spell", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		spellbook({
			setLabel() {},
			on() {},
			registerCommand: (name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) => {
				commands.set(name, command);
			},
		} as never);
		const texts: string[] = [];
		const notes: string[] = [];
		let text = "";
		const ctx = {
			hasUI: true,
			cwd: os.tmpdir(),
			ui: {
				getEditorText: () => text,
				setEditorText: (t: string) => {
					text = t;
					texts.push(t);
				},
				setWidget() {},
				notify: (message: string) => notes.push(message),
			},
			// No model: the cast stops at the model call, after the spell line is in the composer.
			models: { resolve: () => undefined, current: () => undefined },
			sessionManager: { getBranch: () => [] },
		};
		await commands.get("spellbook")!.handler("cast list files here", ctx);
		expect(texts[0]).toBe("?! list files here");
		expect(notes.join("\n")).toContain("no model");
	});
});

describe("prompt spells", () => {
	/** omp's input hook for `text`, then (for a `!` line) its user_bash hook, as Enter does. */
	const send = (text: string) => {
		const result = h.submit(text);
		if (text.startsWith("!")) h.book.onUserBash(text.replace(/^!!?/, ""));
		return result;
	};
	const provider = () =>
		wrapAutocomplete<CompletionProvider>(
			{
				applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
				getForceFileSuggestions: async () => ({ items: [{ value: "file", label: "file" }], prefix: "" }),
			},
			{ find: (q, kind) => h.book.find(q, undefined, kind), onPick: pick => h.book.pick(pick) },
		);

	test("? <desc> morphs into the prompt and waits: nothing is sent until Enter", async () => {
		h = harness();
		expect(h.submit("? get a few agents to review this repo")).toEqual({ handled: true });
		await h.flush();
		expect(h.state.history[0]).toBe("? get a few agents to review this repo");
		// Played as a morph (frames between the spell line and the prompt), as commands are.
		expect(h.state.history.length).toBeGreaterThan(10);
		expect(h.state.text).toBe(PROMPT.text);
		expect(h.state.text.startsWith("!")).toBe(false);
		expect(h.state.line).toContain(PROMPT.explain);
		expect(h.display.frame).toBeUndefined();
	});

	test("motion off: the prompt appears in one step", async () => {
		h = harness({ reduceMotion: true });
		h.submit("? review this repo");
		await h.flush();
		expect(h.state.history).toEqual(["? review this repo", PROMPT.text]);
	});

	test("the line under the composer says what Spellbook changed", async () => {
		h = harness({ prompt: { ...PROMPT, warnings: ["skill nope is not installed"] } });
		h.submit("? review this repo");
		await h.flush();
		expect(h.state.line).toContain("<warning>⚠ skill nope is not installed.</warning>");
	});

	test("Enter mid-morph finishes the prompt instead of sending half of it", async () => {
		h = harness();
		h.submit("? review this repo");
		for (let i = 0; i < 5; i++) await Promise.resolve();
		for (let i = 0; i < 3; i++) h.state.timers.shift()!();
		expect(h.submit(h.state.text)).toEqual({ handled: true });
		expect(h.state.text).toBe(PROMPT.text);
	});

	test("a sent prompt spell is saved, and Tab on a new ? line offers it; ?! never does", async () => {
		h = harness();
		h.submit("? review this repo with agents");
		await h.flush();
		// Sent with an edit: saved as sent.
		const sent = `${PROMPT.text} Focus on src/.`;
		expect(send(sent)).toBeUndefined();
		expect(readBook(path.join(h.dir, "book.json")).entries).toMatchObject([
			{ kind: "prompt", words: "review this repo with agents", prompt: sent, uses: 1 },
		]);

		const tab = provider();
		const suggestions = await tab.getForceFileSuggestions!(["? review"], 0, 8);
		expect(suggestions?.items).toEqual([
			{ value: "spellbook:0", label: "review this repo with agents", description: `${sent.slice(0, 79)}…` },
		]);
		expect(await tab.getForceFileSuggestions!(["?! review"], 0, 9)).toBeNull();

		// Picking needs no model call and lands the prompt as saved.
		const asked = h.state.askedPrompts.length;
		h.state.text = "? review";
		tab.applyCompletion(["? review"], 0, 8, suggestions!.items[0]!, "? review").onApplied!();
		await h.flush();
		expect(h.state.askedPrompts).toHaveLength(asked);
		expect(h.state.text).toBe(sent);
		// Sending the picked prompt again bumps its use count.
		send(sent);
		expect(readBook(path.join(h.dir, "book.json")).entries).toMatchObject([{ kind: "prompt", uses: 2 }]);
	});

	test("a saved command is never offered on a ? line, a saved prompt never on ?!", async () => {
		h = harness();
		h.submit("?! list files here");
		await h.flush();
		send("!ls -la");
		h.submit("? list files here");
		await h.flush();
		send(PROMPT.text);
		const tab = provider();
		const onPrompt = await tab.getForceFileSuggestions!(["? list"], 0, 6);
		const onShell = await tab.getForceFileSuggestions!(["?! list"], 0, 7);
		expect(onPrompt?.items.map(i => i.description)).toEqual([`${PROMPT.text.slice(0, 79)}…`]);
		expect(onShell?.items.map(i => i.description)).toEqual(["ls -la"]);
	});

	test("a prompt replaced by something else is not saved", async () => {
		h = harness();
		h.submit("? review this repo");
		await h.flush();
		send("never mind, what time is it");
		expect(fs.existsSync(path.join(h.dir, "book.json"))).toBe(false);
	});

	test("slash commands and !omp config set lines are saved when sent, and land again from Tab", async () => {
		h = harness({ prompt: { kind: "command", text: "/compact", explain: "", warnings: [] } });
		h.submit("? compact the conversation");
		await h.flush();
		expect(h.state.text).toBe("/compact");
		expect(h.state.line).toContain("An omp command; read it before sending.");
		send("/compact");

		h.book.deps.askPrompt = async () => ({
			answer: { kind: "setting", text: "!omp config set tui.motion false", explain: "", warnings: [] },
			model: "test/model",
		});
		h.submit("? stop the animations");
		await h.flush();
		expect(h.state.text).toBe("!omp config set tui.motion false");
		send("!omp config set tui.motion false");
		expect(readBook(path.join(h.dir, "book.json")).entries).toMatchObject([
			{ kind: "prompt", words: "compact the conversation", prompt: "/compact" },
			{ kind: "prompt", words: "stop the animations", prompt: "!omp config set tui.motion false" },
		]);
	});

	test("/spellbook prompt casts its words as a ? spell", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		spellbook({
			setLabel() {},
			on() {},
			registerCommand: (name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) => {
				commands.set(name, command);
			},
			getCommands: () => [],
		} as never);
		const texts: string[] = [];
		const notes: string[] = [];
		let text = "";
		const ctx = {
			hasUI: true,
			cwd: os.tmpdir(),
			ui: {
				getEditorText: () => text,
				setEditorText: (t: string) => {
					text = t;
					texts.push(t);
				},
				setWidget() {},
				notify: (message: string) => notes.push(message),
			},
			models: { resolve: () => undefined, current: () => undefined },
			sessionManager: { getBranch: () => [] },
		};
		await commands.get("spellbook")!.handler("prompt review this repo", ctx);
		expect(texts[0]).toBe("? review this repo");
		expect(notes.join("\n")).toContain("no model");
	});
});
