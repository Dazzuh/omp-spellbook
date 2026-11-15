import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readBook } from "../src/book";
import { type CompletionProvider, wrapAutocomplete } from "../src/autocomplete";
import { type HookableEditor, hookEditor, type MorphDisplay } from "../src/editor";
import type { CastAnswer, ContextPacket } from "../src/prompt";
import type { MorphStyle } from "../src/settings";
import { Spellbook } from "../src/spellbook";

/** A fake composer plus a manual clock, so frames can be counted and stepped. */
function harness(options: { answer?: CastAnswer; style?: MorphStyle; reduceMotion?: boolean } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spellbook-flow-"));
	const state = {
		text: "",
		line: undefined as string | undefined,
		history: [] as string[],
		notes: [] as string[],
		asked: [] as ContextPacket[],
		timers: [] as (() => void)[],
	};
	const display: MorphDisplay = { frame: undefined, ternReduceMotion: false, editor: undefined };
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
		expect(readBook(path.join(h.dir, "book.json")).spells).toMatchObject([
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
		const display: MorphDisplay = { frame: undefined, ternReduceMotion: false, editor: undefined };
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
		expect(editor.describeDecorations!(["? ab", "cdef"])).toEqual([
			{ from: 2, to: 3, s: "toolDiffRemoved" },
			{ from: 6, to: 8, s: "toolDiffAdded" },
		]);
		expect(invalidated).toBe(0);
	});
});
