import { describe, expect, test } from "bun:test";
import { castQuery, parseCast, parseShellLine } from "../src/parse";

describe("parseCast", () => {
	test("? maps to !, ?? maps to !!", () => {
		expect(parseCast("? list files here")).toEqual({ sigil: "!", description: "list files here" });
		expect(parseCast("?? list files here")).toEqual({ sigil: "!!", description: "list files here" });
	});

	test("space after the prefix is optional; surrounding space is trimmed", () => {
		expect(parseCast("  ?list files  ")).toEqual({ sigil: "!", description: "list files" });
	});

	test("CRLF inside a multi-line description becomes LF", () => {
		expect(parseCast("? first\r\nsecond")?.description).toBe("first\nsecond");
	});

	test("not a cast: bare ?, ???, text without the prefix", () => {
		expect(parseCast("?")).toBeUndefined();
		expect(parseCast("??  ")).toBeUndefined();
		expect(parseCast("??? huh")).toBeUndefined();
		expect(parseCast("what is this?")).toBeUndefined();
		expect(parseCast("!ls")).toBeUndefined();
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
	test("gives the words typed so far, including none", () => {
		expect(castQuery("? lis")).toEqual({ sigil: "!", query: "lis" });
		expect(castQuery("??")).toEqual({ sigil: "!!", query: "" });
		expect(castQuery("ls")).toBeUndefined();
	});
});
