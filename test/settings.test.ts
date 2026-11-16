import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { loadSettings, PLUGIN_NAME, resolveBookPath, settingsFrom, spellbookDir } from "../src/settings";

describe("settings come from omp's plugin settings store", () => {
	test("defaults live in Spellbook: omp returns only configured values", () => {
		expect(settingsFrom({}, {})).toEqual({
			settings: { style: "diff", bookPath: "book.json", model: "@smol" },
			problems: [],
		});
	});

	test("configured values are used; SPELLBOOK_STYLE and SPELLBOOK_BOOK override them", () => {
		const values = { style: "rewind" as const, bookPath: "~/notes/book.json", model: "anthropic/claude-haiku-5-5:low" };
		expect(settingsFrom(values, {}).settings).toEqual(values);
		expect(settingsFrom(values, { SPELLBOOK_STYLE: "B", SPELLBOOK_BOOK: "/tmp/b.json" }).settings).toEqual({
			style: "decode",
			bookPath: "/tmp/b.json",
			model: "anthropic/claude-haiku-5-5:low",
		});
	});

	test("style takes the letters and off, from the env or a hand-edited value", () => {
		expect(settingsFrom({ style: "C" }, {}).settings.style).toBe("rewind");
		expect(settingsFrom({ style: "off" }, {}).settings.style).toBe("none");
		expect(settingsFrom({}, { SPELLBOOK_STYLE: "d" }).settings.style).toBe("diff");
	});

	test("bad values fall back to the default and are reported", () => {
		const read = settingsFrom({ style: "sparkle", bookPath: "  ", model: 3 }, {});
		expect(read.settings).toEqual({ style: "diff", bookPath: "book.json", model: "@smol" });
		expect(read.problems).toHaveLength(3);
		expect(read.problems[0]).toContain('style "sparkle"');
	});

	test("each read asks omp again, so a Configure change shows on the next read", async () => {
		const stored: Record<string, unknown> = {};
		const asked: [string, string][] = [];
		const reader = async (name: string, cwd: string) => {
			asked.push([name, cwd]);
			return { ...stored };
		};
		expect((await loadSettings("/proj", {}, reader)).settings.style).toBe("diff");
		stored.style = "decode";
		stored.model = "@slow";
		expect((await loadSettings("/proj", {}, reader)).settings).toMatchObject({ style: "decode", model: "@slow" });
		expect(asked).toEqual([
			[PLUGIN_NAME, "/proj"],
			[PLUGIN_NAME, "/proj"],
		]);
	});

	test("an unreadable store gives the defaults and says why", async () => {
		const read = await loadSettings("/proj", {}, async () => {
			throw new Error("bad lockfile");
		});
		expect(read.settings.style).toBe("diff");
		expect(read.problems).toEqual(["omp's plugin settings could not be read: bad lockfile"]);
	});
});

describe("bookPath", () => {
	const agentDir = path.resolve("/agent");
	const dir = spellbookDir(agentDir);
	const home = path.resolve("/home/me");

	test("a relative path sits in <agent dir>/spellbook; ~ is home; an absolute path stays", () => {
		expect(resolveBookPath(dir, "book.json", home)).toBe(path.join(agentDir, "spellbook", "book.json"));
		expect(resolveBookPath(dir, "~/notes/b.json", home)).toBe(path.join(home, "notes", "b.json"));
		expect(resolveBookPath(dir, "~", home)).toBe(home);
		const absolute = path.resolve("/elsewhere/b.json");
		expect(resolveBookPath(dir, absolute, home)).toBe(absolute);
	});
});
