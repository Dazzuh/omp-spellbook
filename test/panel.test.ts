import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { type CompletionProvider, wrapAutocomplete } from "../src/autocomplete";
import { addPromptSpell, addSpell, type Book, emptyBook, findSpells, forgetSpell, type Spell } from "../src/book";
import type { CastSummary } from "../src/castlog";
import { age, castDetail, castLine, nowRows, panelSpells, SpellbookPanel } from "../src/panel";

const KEY = { esc: "\x1b", tab: "\t", shiftTab: "\x1b[Z", up: "\x1b[A", down: "\x1b[B", enter: "\r", ctrlX: "\x18" };
const at = (iso: string) => new Date(iso);

function sampleBook(): Book {
	let book = emptyBook();
	book = addSpell(book, "git log recent commits", "git log --oneline -20", at("2026-11-10T00:00:00Z"));
	book = addSpell(book, "show disk usage", "du -sh .", at("2026-11-12T00:00:00Z"));
	book = addSpell(book, "show disk usage", "du -sh .", at("2026-11-13T00:00:00Z"));
	book = addPromptSpell(book, "review my diff", "Review the staged diff with skill://reviewer", at("2026-11-11T00:00:00Z"));
	return book;
}

const CAST: CastSummary = {
	file: "C:/agent/spellbook/casts/2026-11-16T16-00-00-000Z_x.jsonl",
	at: "2026-11-16T16:00:00.000Z",
	kind: "prompt",
	description: "make settings appear on the configure page",
	model: "anthropic/claude-haiku-5-5",
	thinkingLevel: "low",
	outcome: "landed",
	landed: "Move Spellbook's settings to omp.settings",
	lookups: ["read omp://marketplace.md", "grep getPluginSettings"],
	totalMs: 8240,
	cost: 0.0123,
	totalTokens: 4100,
};

/** A panel over `book`, recording what it was asked to do. */
function panel(initial: Book, casts: CastSummary[] = [CAST]) {
	const state = { book: initial, landed: [] as Spell[], closed: 0, renders: 0 };
	const component = new SpellbookPanel({
		find: (query, kind) => findSpells(state.book, query, 50, kind).map(match => match.spell),
		now: () => nowRows({
			style: "diff",
			bookFile: "C:/agent/spellbook/book.json",
			modelSetting: "@smol",
			model: "anthropic/claude-haiku-5-5:low",
			fallback: undefined,
			shell: "C:/Program Files/Git/bin/bash.exe",
			castsDir: "C:/agent/spellbook/casts",
			problems: [],
			overrides: [],
		}),
		casts: () => casts,
		land: spell => state.landed.push(spell),
		forget: spell => {
			const text = spell.kind === "command" ? spell.command : spell.prompt;
			const before = state.book.entries.length;
			state.book = forgetSpell(state.book, spell.kind, spell.words, text);
			return state.book.entries.length < before;
		},
		close: () => state.closed++,
		requestRender: () => state.renders++,
		paint: (_color, text) => text,
	});
	const type = (text: string) => {
		for (const char of text) component.handleInput(char);
	};
	return { component, state, type };
}

describe("panel state", () => {
	test("Spells lists commands then prompts, each kind in findSpells' order", () => {
		const book = sampleBook();
		const find = (query: string, kind: Spell["kind"]) => findSpells(book, query, 50, kind).map(match => match.spell);
		expect(panelSpells(find, "").map(entry => entry.spell.words)).toEqual([
			"show disk usage",
			"git log recent commits",
			"review my diff",
		]);
		expect(panelSpells(find, "gti").map(entry => entry.spell.words)).toEqual(["git log recent commits"]);
	});

	test("the Tab menu and the panel give the same order for the same query", async () => {
		let book = emptyBook();
		for (const [words, command, uses] of [
			["show disk usage", "du -sh .", 3],
			["disk free", "df -h", 1],
			["usage of the disks by folder", "du -h --max-depth=1", 2],
			["list files", "ls -la", 5],
		] as const) {
			for (let i = 0; i < uses; i++) book = addSpell(book, words, command, at("2026-11-10T00:00:00Z"));
		}
		const provider: CompletionProvider = {
			getForceFileSuggestions: async () => null,
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		};
		const tab = wrapAutocomplete(provider, { find: (query, kind) => findSpells(book, query, 8, kind), onPick() {} });
		const find = (query: string, kind: Spell["kind"]) => findSpells(book, query, 50, kind).map(match => match.spell);
		for (const query of ["disk", "dsik", "usage", "du", ""]) {
			const line = `?! ${query}`;
			const listed = await tab.getForceFileSuggestions!([line], 0, line.length);
			expect((listed?.items ?? []).map(item => item.label)).toEqual(panelSpells(find, query).map(entry => entry.spell.words));
		}
	});

	test("Now names each setting's value, the model in use, the shell, the logs and where to change settings", () => {
		const rows = nowRows({
			style: "decode",
			bookFile: "/home/u/.omp/agent/spellbook/book.json",
			modelSetting: "@smol",
			model: "anthropic/claude-sonnet-5-5:medium",
			fallback: "no API key for anthropic/claude-haiku-5-5",
			shell: "/bin/bash",
			castsDir: "/home/u/.omp/agent/spellbook/casts",
			problems: ['style "x" is not one of diff, decode, rewind, none; using diff'],
			overrides: ["SPELLBOOK_STYLE=decode"],
		});
		expect(rows.map(row => [row.label, row.value])).toEqual([
			["Style", "decode"],
			["Spellbook file", "/home/u/.omp/agent/spellbook/book.json"],
			["Model", "@smol not usable (no API key for anthropic/claude-haiku-5-5); casts use the session's anthropic/claude-sonnet-5-5:medium"],
			["Shell", "/bin/bash"],
			["Cast logs", "/home/u/.omp/agent/spellbook/casts"],
			["Change settings", "/plugins → omp-spellbook → Configure"],
			["Set by environment", "SPELLBOOK_STYLE=decode"],
			["Settings problem", 'style "x" is not one of diff, decode, rewind, none; using diff'],
		]);
		expect(rows.filter(row => row.warn).map(row => row.label)).toEqual(["Model", "Settings problem"]);
		expect(nowRows({ ...{ style: "diff", bookFile: "b", shell: "s", castsDir: "c", problems: [], overrides: [] }, modelSetting: "@smol", model: "a/haiku:low", fallback: undefined })[2]).toEqual({
			label: "Model",
			value: "@smol → a/haiku:low",
		});
	});

	test("a recent cast shows what was asked, model, time, outcome, each lookup and its log", () => {
		expect(castLine(CAST)).toEqual({
			label: "? make settings appear on the configure page",
			detail: "anthropic/claude-haiku-5-5:low · 8.2s · landed · 2 lookups",
		});
		expect(castDetail(CAST)).toEqual([
			["Asked", "? make settings appear on the configure page"],
			["Model", "anthropic/claude-haiku-5-5:low"],
			["Outcome", "landed"],
			["Landed", "Move Spellbook's settings to omp.settings"],
			["Took", "8.2s"],
			["Tokens", "4100"],
			["Cost", "$0.0123"],
			["Started", "2026-11-16T16:00:00.000Z"],
			["Looked up", "read omp://marketplace.md"],
			["", "grep getPluginSettings"],
			["Log", CAST.file],
		]);
		const failed: CastSummary = { ...CAST, kind: "shell", sigil: "!!", outcome: "model error", reason: "rate limited", landed: undefined, lookups: [] };
		expect(castLine(failed).label).toBe("?!! make settings appear on the configure page");
		expect(castDetail(failed)).toContainEqual(["Outcome", "model error: rate limited"]);
	});

	test("ages are compact", () => {
		const now = Date.parse("2026-11-16T12:00:00Z");
		expect(age("2026-11-16T11:59:30Z", now)).toBe("now");
		expect(age("2026-11-16T11:55:00Z", now)).toBe("5m");
		expect(age("2026-11-16T09:00:00Z", now)).toBe("3h");
		expect(age("2026-11-13T12:00:00Z", now)).toBe("3d");
	});
});

describe("the panel", () => {
	test("typing searches Spells; Enter lands the selected spell and closes", () => {
		const { component, state, type } = panel(sampleBook());
		type("gti");
		component.handleInput(KEY.enter);
		expect(state.landed.map(spell => spell.words)).toEqual(["git log recent commits"]);
		expect(state.closed).toBe(1);
	});

	test("Ctrl+X asks, a second Ctrl+X forgets; Esc first cancels the question, then closes", () => {
		const { component, state } = panel(sampleBook());
		component.handleInput(KEY.ctrlX);
		expect(component.render(100).join("\n")).toContain('Forget "show disk usage"?');
		component.handleInput(KEY.esc);
		expect(state.closed).toBe(0);
		expect(state.book.entries).toHaveLength(3);
		component.handleInput(KEY.ctrlX);
		component.handleInput(KEY.ctrlX);
		expect(state.book.entries.map(spell => spell.words)).toEqual(["git log recent commits", "review my diff"]);
		expect(component.render(100).join("\n")).toContain('Forgot "show disk usage".');
		component.handleInput(KEY.esc);
		expect(state.closed).toBe(1);
	});

	test("Tab moves through Spells, Now and Recent casts; each renders within the width", () => {
		const { component } = panel(sampleBook());
		const width = 60;
		const seen: string[] = [];
		for (let i = 0; i < 3; i++) {
			const rows = component.render(width);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			seen.push(rows.join("\n"));
			component.handleInput(KEY.tab);
		}
		expect(seen[0]).toContain("Search:");
		expect(seen[1]).toContain("/plugins → omp-spellbook → Configure");
		expect(seen[2]).toContain("? make settings appear");
		expect(component.render(200).join("\n")).toContain("Search:");
		component.handleInput(KEY.shiftTab);
		expect(component.section).toBe("casts");
	});

	test("Recent casts shows the selected cast's lookups and log; no casts says so", () => {
		const { component } = panel(sampleBook());
		component.handleInput(KEY.shiftTab);
		const text = component.render(200).join("\n");
		expect(text).toContain("read omp://marketplace.md");
		expect(text).toContain("grep getPluginSettings");
		expect(text).toContain(CAST.file);
		const empty = panel(emptyBook(), []);
		empty.component.handleInput(KEY.shiftTab);
		expect(empty.component.render(80).join("\n")).toContain("No casts logged yet.");
	});

	test("in Tern it is a picker sheet whose tabs, rows and buttons drive the same actions", () => {
		const { component, state } = panel(sampleBook());
		const cx = { cols: 100, reduceMotion: false, dark: true, supports: (kind: string) => kind === "picker", feature: () => false };
		expect(component.nativeSheet(cx)).toBe(true);
		const props = () => {
			const described = component.describe(cx);
			if (described?.k !== "picker" || !described.p) throw new Error("not a picker");
			return described.p;
		};
		const sheet = props();
		expect(sheet.tab).toBe("spells");
		expect((sheet.items ?? []).map(item => item.label)).toEqual(["show disk usage", "git log recent commits", "review my diff"]);
		// Unchanged state: the same node, as the describe contract asks.
		expect(component.describe(cx)).toBe(component.describe(cx));
		component.handleNativeEvent({ type: "action", key: "", act: "tab", value: "casts", mods: [] });
		expect(props().tab).toBe("casts");
		component.handleNativeEvent({ type: "action", key: "", act: "tab", value: "spells", mods: [] });
		component.handleNativeEvent({ type: "activate", key: "", item: "command:1" });
		expect(state.landed.map(spell => spell.words)).toEqual(["git log recent commits"]);
		component.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
		expect(state.closed).toBe(2);
		// A terminal without the picker kind gets the rows.
		expect(component.describe({ ...cx, supports: () => false })).toBeNull();
	});
});
