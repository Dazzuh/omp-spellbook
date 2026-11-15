import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addSpell, BookReadError, emptyBook, findSpells, readBook, writeBook } from "../src/book";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "spellbook-book-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("spellbook file", () => {
	test("a missing file is an empty book; write creates folders and reads back", () => {
		const file = path.join(dir, "nested", "deeper", "book.json");
		expect(readBook(file)).toEqual(emptyBook());
		writeBook(file, addSpell(emptyBook(), "list files here", "ls -la", new Date("2026-11-15T00:00:00Z")));
		expect(readBook(file).spells).toEqual([
			{ words: "list files here", command: "ls -la", uses: 1, lastUsed: "2026-11-15T00:00:00.000Z" },
		]);
		expect(fs.readdirSync(path.dirname(file))).toEqual(["book.json"]);
	});

	test("reads a hand-edited file with a BOM and CRLF line endings", () => {
		const file = path.join(dir, "book.json");
		fs.writeFileSync(
			file,
			'\uFEFF{\r\n  "spells": [\r\n    { "words": "disk usage", "command": "du -sh ." }\r\n  ]\r\n}\r\n',
		);
		const book = readBook(file);
		expect(book.spells).toHaveLength(1);
		expect(book.spells[0]).toMatchObject({ words: "disk usage", command: "du -sh .", uses: 1 });
	});

	test("an unreadable file throws and is left untouched", () => {
		const file = path.join(dir, "book.json");
		fs.writeFileSync(file, "{ not json");
		expect(() => readBook(file)).toThrow(BookReadError);
		expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
	});
});

describe("addSpell", () => {
	test("the same words and command again bumps uses instead of duplicating", () => {
		const book = emptyBook();
		addSpell(book, "list files here", "ls -la");
		addSpell(book, "List files, here", "ls -la");
		addSpell(book, "list files here", "ls -1");
		expect(book.spells.map(s => [s.command, s.uses])).toEqual([
			["ls -la", 2],
			["ls -1", 1],
		]);
	});

	test("empty words or command are not saved", () => {
		expect(addSpell(emptyBook(), " ", "ls").spells).toEqual([]);
		expect(addSpell(emptyBook(), "x", " ").spells).toEqual([]);
	});
});

describe("findSpells", () => {
	const book = emptyBook();
	addSpell(book, "list files here", "ls -la");
	addSpell(book, "restart wings and show its logs", "ssh donnager 'systemctl restart wings'");
	addSpell(book, "show disk usage", "du -sh .");
	addSpell(book, "show disk usage", "du -sh .");

	test("matches whole words, word prefixes and command text; every query word must hit", () => {
		expect(findSpells(book, "list files").map(m => m.spell.command)).toEqual(["ls -la"]);
		expect(findSpells(book, "rest wing").map(m => m.spell.command)).toEqual(["ssh donnager 'systemctl restart wings'"]);
		expect(findSpells(book, "donnager").map(m => m.spell.words)).toEqual(["restart wings and show its logs"]);
		expect(findSpells(book, "list nothing")).toEqual([]);
	});

	test("an empty query lists everything, most used first", () => {
		expect(findSpells(book, "")[0]!.spell.command).toBe("du -sh .");
	});
});
