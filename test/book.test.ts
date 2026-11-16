import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	addPromptSpell,
	addSpell,
	BookReadError,
	emptyBook,
	findSpells,
	forgetSpell,
	readBook,
	typoQueries,
	writeBook,
} from "../src/book";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "spellbook-book-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const at = new Date("2026-11-15T00:00:00Z");

describe("spellbook file", () => {
	test("a missing file is an empty book; write creates folders and reads back", () => {
		const file = path.join(dir, "nested", "deeper", "book.json");
		expect(readBook(file)).toEqual(emptyBook());
		writeBook(file, addSpell(emptyBook(), "list files here", "ls -la", at));
		expect(readBook(file).entries).toEqual([
			{ kind: "command", words: "list files here", command: "ls -la", uses: 1, lastUsed: "2026-11-15T00:00:00.000Z" },
		]);
		expect(fs.readdirSync(path.dirname(file))).toEqual(["book.json"]);
	});

	test("command and prompt spells are saved as v2 with no spells key, and read back with their kind", () => {
		const file = path.join(dir, "book.json");
		const book = addPromptSpell(addSpell(emptyBook(), "disk usage", "du -sh .", at), "review my diff", "Review the staged diff", at);
		writeBook(file, book);
		const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(Object.keys(onDisk).sort()).toEqual(["entries", "version"]);
		expect(onDisk.version).toBe(2);
		expect(readBook(file)).toEqual(book);
	});

	test("a v1 book (0.1.x) reads as commands and is written back as v2", () => {
		const file = path.join(dir, "book.json");
		const v1 = {
			version: 1,
			spells: [
				{ words: "disk usage", command: "du -sh .", uses: 3, lastUsed: "2026-11-01T00:00:00.000Z" },
				{ words: "list files", command: "ls -la" },
			],
		};
		fs.writeFileSync(file, JSON.stringify(v1));
		const book = readBook(file);
		expect(book.entries).toEqual([
			{ kind: "command", words: "disk usage", command: "du -sh .", uses: 3, lastUsed: "2026-11-01T00:00:00.000Z" },
			{ kind: "command", words: "list files", command: "ls -la", uses: 1, lastUsed: "1970-01-01T00:00:00.000Z" },
		]);
		writeBook(file, addPromptSpell(book, "explain repo", "Explain this repo", at));
		const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(onDisk.version).toBe(2);
		expect(onDisk.spells).toBeUndefined();
		expect(onDisk.entries.map((e: { kind: string }) => e.kind)).toEqual(["command", "command", "prompt"]);
	});

	test("reads a hand-edited v1 file with a BOM and CRLF line endings", () => {
		const file = path.join(dir, "book.json");
		fs.writeFileSync(
			file,
			'\uFEFF{\r\n  "spells": [\r\n    { "words": "disk usage", "command": "du -sh ." }\r\n  ]\r\n}\r\n',
		);
		const book = readBook(file);
		expect(book.entries).toHaveLength(1);
		expect(book.entries[0]).toMatchObject({ kind: "command", words: "disk usage", command: "du -sh .", uses: 1 });
	});

	test.each([
		["bad JSON", "{ not json"],
		["no entries", '{ "version": 2 }'],
		["v2 holding a v1 spells list", '{ "version": 2, "spells": [{ "words": "a", "command": "ls" }] }'],
		["an entry without a kind", '{ "version": 2, "entries": [{ "words": "a", "command": "ls" }] }'],
		["an unknown kind", '{ "version": 2, "entries": [{ "kind": "macro", "words": "a", "command": "ls" }] }'],
		["a prompt spell without its prompt", '{ "version": 2, "entries": [{ "kind": "prompt", "words": "a", "command": "ls" }] }'],
		["a newer version", '{ "version": 3, "entries": [] }'],
		["a v1 spell without its command", '{ "spells": [{ "words": "a" }] }'],
		["an array", "[]"],
	])("a malformed file (%s) throws and is never overwritten", (_name, content) => {
		const file = path.join(dir, "book.json");
		fs.writeFileSync(file, content);
		expect(() => readBook(file)).toThrow(BookReadError);
		expect(fs.readFileSync(file, "utf8")).toBe(content);
	});
});

describe("addSpell and addPromptSpell", () => {
	test("the same words and command again bumps uses instead of duplicating", () => {
		const book = emptyBook();
		addSpell(book, "list files here", "ls -la");
		addSpell(book, "List files, here", "ls -la");
		addSpell(book, "list files here", "ls -1");
		expect(book.entries.map(s => [s.kind === "command" && s.command, s.uses])).toEqual([
			["ls -la", 2],
			["ls -1", 1],
		]);
	});

	test("a prompt with the same words and text as a command is its own spell", () => {
		const book = emptyBook();
		addSpell(book, "status", "git status");
		addPromptSpell(book, "status", "git status");
		addPromptSpell(book, "Status!", "git status");
		expect(book.entries.map(s => [s.kind, s.uses])).toEqual([
			["command", 1],
			["prompt", 2],
		]);
	});

	test("empty words or text are not saved", () => {
		expect(addSpell(emptyBook(), " ", "ls").entries).toEqual([]);
		expect(addSpell(emptyBook(), "x", " ").entries).toEqual([]);
		expect(addPromptSpell(emptyBook(), "x", " ").entries).toEqual([]);
	});
});

describe("findSpells", () => {
	const book = emptyBook();
	addSpell(book, "list files here", "ls -la");
	addSpell(book, "restart wings and show its logs", "ssh donnager 'systemctl restart wings'");
	addSpell(book, "show disk usage", "du -sh .");
	addSpell(book, "show disk usage", "du -sh .");
	addPromptSpell(book, "list files here", "List the files here and say what each is for");
	addPromptSpell(book, "review donnager setup", "Review the donnager deploy scripts");
	addPromptSpell(book, "review donnager setup", "Review the donnager deploy scripts");

	test("matches whole words, word prefixes and command text; every query word must hit", () => {
		expect(findSpells(book, "list files").map(m => m.spell.command)).toEqual(["ls -la"]);
		expect(findSpells(book, "rest wing").map(m => m.spell.command)).toEqual(["ssh donnager 'systemctl restart wings'"]);
		expect(findSpells(book, "donnager").map(m => m.spell.words)).toEqual(["restart wings and show its logs"]);
		expect(findSpells(book, "list nothing")).toEqual([]);
	});

	test("an empty query lists everything of the kind, most used first", () => {
		expect(findSpells(book, "")[0]!.spell.command).toBe("du -sh .");
		expect(findSpells(book, "", 8, "prompt")[0]!.spell.prompt).toBe("Review the donnager deploy scripts");
	});

	test("finding by kind never mixes kinds; commands are the default", () => {
		for (const query of ["", "list", "donnager", "files here"]) {
			expect(findSpells(book, query).every(m => m.spell.kind === "command")).toBe(true);
			expect(findSpells(book, query, 8, "command").every(m => m.spell.kind === "command")).toBe(true);
			expect(findSpells(book, query, 8, "prompt").every(m => m.spell.kind === "prompt")).toBe(true);
		}
		expect(findSpells(book, "list files", 8, "prompt").map(m => m.spell.prompt)).toEqual([
			"List the files here and say what each is for",
		]);
		// Prompt text matches like command text does.
		expect(findSpells(book, "scripts", 8, "prompt").map(m => m.spell.words)).toEqual(["review donnager setup"]);
		expect(findSpells(book, "scripts")).toEqual([]);
	});
});

describe("fuzzy matching (omp's fuzzyRank)", () => {
	const at = (iso: string) => new Date(iso);
	const book = emptyBook();
	addSpell(book, "git log recent commits", "git log --oneline -20", at("2026-11-10T00:00:00Z"));
	addSpell(book, "show disk usage", "du -sh .", at("2026-11-10T00:00:00Z"));
	addSpell(book, "list big files", "find . -size +10M", at("2026-11-10T00:00:00Z"));

	test("a typo finds the spell: two letters swapped in a word", () => {
		expect(findSpells(book, "gti log").map(m => m.spell.command)).toEqual(["git log --oneline -20"]);
		expect(findSpells(book, "dsik").map(m => m.spell.command)).toEqual(["du -sh ."]);
		expect(typoQueries("gti log")).toContain("git log");
		// Short words are left alone: "ls" swapped is "sl".
		expect(typoQueries("ls")).toEqual([]);
	});

	test("a partial word and words out of order find the spell", () => {
		expect(findSpells(book, "comm").map(m => m.spell.command)).toEqual(["git log --oneline -20"]);
		expect(findSpells(book, "usage disk").map(m => m.spell.command)).toEqual(["du -sh ."]);
		expect(findSpells(book, "files big").map(m => m.spell.command)).toEqual(["find . -size +10M"]);
	});

	test("a match in the spell's words outranks one in its command, whatever the uses", () => {
		const ranked = emptyBook();
		addSpell(ranked, "count lines", "wc -l size.txt", at("2026-11-10T00:00:00Z"));
		for (let i = 0; i < 5; i++) addSpell(ranked, "biggest folders", "du -h --max-depth=1 | sort -h", at("2026-11-11T00:00:00Z"));
		addSpell(ranked, "folder size", "du -sh .", at("2026-11-10T00:00:00Z"));
		expect(findSpells(ranked, "size").map(m => m.spell.words)).toEqual(["folder size", "count lines"]);
		// A typo in the words still beats an exact hit in the command.
		const typo = emptyBook();
		addSpell(typo, "release notes", "git log --oneline v0.2..HEAD", at("2026-11-10T00:00:00Z"));
		for (let i = 0; i < 5; i++) addSpell(typo, "tag it", "git tag relaese-candidate", at("2026-11-11T00:00:00Z"));
		expect(findSpells(typo, "relaese").map(m => m.spell.words)).toEqual(["release notes", "tag it"]);
	});

	test("equal matches sort by uses, then by last used", () => {
		const ties = emptyBook();
		addSpell(ties, "deploy staging", "make deploy-a", at("2026-11-01T00:00:00Z"));
		addSpell(ties, "deploy staging", "make deploy-b", at("2026-11-05T00:00:00Z"));
		addSpell(ties, "deploy staging", "make deploy-c", at("2026-11-02T00:00:00Z"));
		addSpell(ties, "deploy staging", "make deploy-c", at("2026-11-03T00:00:00Z"));
		expect(findSpells(ties, "deploy").map(m => m.spell.command)).toEqual(["make deploy-c", "make deploy-b", "make deploy-a"]);
	});

	test("forgetting a spell takes out exactly that kind, words and text", () => {
		const both = addPromptSpell(addSpell(emptyBook(), "list files", "ls"), "list files", "List the files");
		const kept = forgetSpell(both, "command", "list files", "ls");
		expect(kept.entries.map(spell => spell.kind)).toEqual(["prompt"]);
		expect(forgetSpell(both, "command", "list files", "ls -la")).toEqual(both);
	});
});
