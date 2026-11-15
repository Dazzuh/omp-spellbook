import { describe, expect, test } from "bun:test";
import { castPrefix, castQuery, parseCast, parseShellLine, spellRanges } from "../src/parse";

describe("parseCast", () => {
	test("? is a prompt spell, ?! a ! command, ?!! a !! command", () => {
		expect(parseCast("? review this repo")).toEqual({ kind: "prompt", description: "review this repo" });
		expect(parseCast("?! list files here")).toEqual({ kind: "shell", sigil: "!", description: "list files here" });
		expect(parseCast("?!! list files here")).toEqual({ kind: "shell", sigil: "!!", description: "list files here" });
	});

	test("space after the prefix is optional; surrounding space is trimmed", () => {
		expect(parseCast("  ?!list files  ")).toEqual({ kind: "shell", sigil: "!", description: "list files" });
		expect(parseCast("?review")).toEqual({ kind: "prompt", description: "review" });
		// After a space, a ! starts the description.
		expect(parseCast("? !important")).toEqual({ kind: "prompt", description: "!important" });
	});

	test("CRLF inside a multi-line description becomes LF", () => {
		expect(parseCast("?! first\r\nsecond")?.description).toBe("first\nsecond");
	});

	test("not a cast: bare prefixes, ??, ???, ?!!!, ?!?, text without the prefix", () => {
		for (const text of ["?", "?!", "?!!  ", "?? list files", "??  ", "??? huh", "?!!! list", "?!? x", "what is this?", "!ls"]) {
			expect(parseCast(text)).toBeUndefined();
		}
	});
});

describe("parseShellLine", () => {
	test("reads ! and !! lines", () => {
		expect(parseShellLine("!ls -la")).toEqual({ sigil: "!", command: "ls -la" });
		expect(parseShellLine("!! git status")).toEqual({ sigil: "!!", command: "git status" });
		expect(parseShellLine("!!!x")).toBeUndefined();
		expect(parseShellLine("hello")).toBeUndefined();
	});
});

describe("castQuery", () => {
	test("gives the kind and the words typed so far, including none", () => {
		expect(castQuery("?! lis")).toEqual({ kind: "shell", sigil: "!", query: "lis" });
		expect(castQuery("?!!")).toEqual({ kind: "shell", sigil: "!!", query: "" });
		expect(castQuery("? rev")).toEqual({ kind: "prompt", query: "rev" });
		expect(castQuery("?? lis")).toBeUndefined();
		expect(castQuery("ls")).toBeUndefined();
	});
});

describe("castPrefix", () => {
	test("is the prefix that asks for the request's kind", () => {
		expect(castPrefix({ kind: "prompt" })).toBe("?");
		expect(castPrefix({ kind: "shell", sigil: "!" })).toBe("?!");
		expect(castPrefix({ kind: "shell", sigil: "!!" })).toBe("?!!");
	});
});

describe("spellRanges", () => {
	test("reports the kind, the prefix, the prefix with its spaces, and the description", () => {
		expect(spellRanges(" ?!!  find it ")).toEqual({
			kind: "shell",
			bang: "!!",
			sigil: { from: 1, to: 4 },
			lead: { from: 1, to: 6 },
			description: { from: 6, to: 13 },
		});
		expect(spellRanges("?")).toEqual({
			kind: "prompt",
			sigil: { from: 0, to: 1 },
			lead: { from: 0, to: 1 },
			description: undefined,
		});
		expect(spellRanges("?? x")).toBeUndefined();
		expect(spellRanges("?!!!")).toBeUndefined();
	});
});
