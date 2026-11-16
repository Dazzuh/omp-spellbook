import * as fs from "node:fs";
import * as path from "node:path";

/** One saved shell command, filed under the words that asked for it. */
export interface CommandSpell {
	kind: "command";
	words: string;
	command: string;
	uses: number;
	/** ISO-8601 time of the last save. */
	lastUsed: string;
}

/** One saved prompt, filed under the words that asked for it. */
export interface PromptSpell {
	kind: "prompt";
	words: string;
	prompt: string;
	uses: number;
	/** ISO-8601 time of the last save. */
	lastUsed: string;
}

export type Spell = CommandSpell | PromptSpell;
export type SpellKind = Spell["kind"];
/** The spell type of one kind: `SpellOf<"prompt">` is {@link PromptSpell}. */
export type SpellOf<K extends SpellKind> = Extract<Spell, { kind: K }>;

/**
 * The book in memory and on disk. The entries live under `entries`, never `spells`: 0.1.x reads
 * `spells` as commands only and would save a mixed book back without its prompt spells' kind, so a
 * v2 file has no `spells` key and 0.1.x refuses it instead.
 */
export interface Book {
	version: 2;
	entries: Spell[];
}

export class BookReadError extends Error {
	constructor(
		readonly file: string,
		cause: unknown,
	) {
		super(`Spellbook file ${file} is not valid: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "BookReadError";
	}
}

export function emptyBook(): Book {
	return { version: 2, entries: [] };
}

function uses(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function lastUsed(value: unknown): string {
	return typeof value === "string" ? value : new Date(0).toISOString();
}

type Raw = Record<string, unknown>;

/** A v2 entry, or a message saying what it lacks. */
function readEntry(raw: unknown): Spell | string {
	if (!raw || typeof raw !== "object") return "is not an object";
	const e = raw as Raw;
	if (typeof e.words !== "string") return 'needs a "words" string';
	if (e.kind === "command") {
		if (typeof e.command !== "string") return 'is a command spell without a "command" string';
		return { kind: "command", words: e.words, command: e.command, uses: uses(e.uses), lastUsed: lastUsed(e.lastUsed) };
	}
	if (e.kind === "prompt") {
		if (typeof e.prompt !== "string") return 'is a prompt spell without a "prompt" string';
		return { kind: "prompt", words: e.words, prompt: e.prompt, uses: uses(e.uses), lastUsed: lastUsed(e.lastUsed) };
	}
	return 'needs "kind": "command" or "prompt"';
}

/** The entries of a parsed file: v1 (`spells`, every one a command) or v2 (`entries`). Throws on anything else. */
function readEntries(parsed: unknown): Spell[] {
	const top = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined) as Raw | undefined;
	if (!top) throw new Error('expected { "version": 2, "entries": [...] }');
	const version = top.version;
	if (typeof version === "number" && version > 2) {
		throw new Error(`version ${version} is from a newer Spellbook; update Spellbook to read it`);
	}
	// One bad entry makes the whole file unreadable: dropping it here would delete it on the next save.
	if (version === 2) {
		if (!Array.isArray(top.entries)) throw new Error('version 2 expects { "entries": [...] }');
		return top.entries.map((raw, index) => {
			const entry = readEntry(raw);
			if (typeof entry === "string") throw new Error(`entry ${index + 1} ${entry}`);
			return entry;
		});
	}
	if (version !== undefined && version !== 1) throw new Error(`unknown version ${JSON.stringify(version)}`);
	if (!Array.isArray(top.spells)) throw new Error('expected { "spells": [...] }');
	return top.spells.map((raw, index) => {
		const s = raw as Raw | null;
		if (!s || typeof s !== "object" || typeof s.words !== "string" || typeof s.command !== "string") {
			throw new Error(`spell ${index + 1} needs "words" and "command" strings`);
		}
		return { kind: "command", words: s.words, command: s.command, uses: uses(s.uses), lastUsed: lastUsed(s.lastUsed) };
	});
}

/**
 * Read the spellbook. A missing file is an empty book; a v1 file (0.1.x) reads as all commands and
 * is saved back as v2; an unreadable one throws {@link BookReadError} so a hand-edited file with a
 * typo is never overwritten.
 */
export function readBook(file: string): Book {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyBook();
		throw new BookReadError(file, error);
	}
	// Tolerate a BOM and CRLF from editors on Windows.
	raw = raw.replace(/^\uFEFF/, "");
	if (raw.trim() === "") return emptyBook();
	try {
		return { version: 2, entries: readEntries(JSON.parse(raw)) };
	} catch (error) {
		throw new BookReadError(file, error);
	}
}

/** Write the spellbook as v2 atomically (temp file + rename), creating its folder. */
export function writeBook(file: string, book: Book): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	const onDisk: Book = { version: 2, entries: book.entries };
	fs.writeFileSync(tmp, `${JSON.stringify(onDisk, null, "\t")}\n`, "utf8");
	try {
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

/** Lowercased word tokens, punctuation dropped. */
export function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

/** File a spell of `kind` under `words`; the same kind, words and text again only bumps its use count. */
function add(book: Book, kind: SpellKind, words: string, text: string, now: Date): Book {
	const trimmedWords = words.trim();
	const trimmedText = text.trim();
	if (!trimmedWords || !trimmedText) return book;
	const key = tokens(trimmedWords).join(" ");
	const existing = book.entries.find(
		s => s.kind === kind && (s.kind === "command" ? s.command : s.prompt) === trimmedText && tokens(s.words).join(" ") === key,
	);
	if (existing) {
		existing.uses += 1;
		existing.lastUsed = now.toISOString();
		existing.words = trimmedWords;
	} else if (kind === "command") {
		book.entries.push({ kind, words: trimmedWords, command: trimmedText, uses: 1, lastUsed: now.toISOString() });
	} else {
		book.entries.push({ kind, words: trimmedWords, prompt: trimmedText, uses: 1, lastUsed: now.toISOString() });
	}
	return book;
}

/** File `command` under `words` as a command spell; the same pair again only bumps its use count. Returns the updated book. */
export function addSpell(book: Book, words: string, command: string, now: Date = new Date()): Book {
	return add(book, "command", words, command, now);
}

/** File `prompt` under `words` as a prompt spell; the same pair again only bumps its use count. Returns the updated book. */
export function addPromptSpell(book: Book, words: string, prompt: string, now: Date = new Date()): Book {
	return add(book, "prompt", words, prompt, now);
}

/** A found spell; command spells unless a kind is named, so `match.spell.command` reads need no narrowing. */
export interface SpellMatch<S extends Spell = CommandSpell> {
	spell: S;
	score: number;
}

/**
 * Spells of `kind` (commands by default) whose words or text match `query`, best first. Each query
 * token must prefix-match a token of the spell's words or appear in its command or prompt; an empty
 * query lists the most used spells of that kind.
 */
export function findSpells<K extends SpellKind = "command">(
	book: Book,
	query: string,
	limit = 8,
	kind: K = "command" as K,
): SpellMatch<SpellOf<K>>[] {
	const queryTokens = tokens(query);
	const matches: SpellMatch<SpellOf<K>>[] = [];
	for (const spell of book.entries) {
		if (spell.kind !== kind) continue;
		const wordTokens = tokens(spell.words);
		const text = (spell.kind === "command" ? spell.command : spell.prompt).toLowerCase();
		let score = 0;
		let missed = false;
		for (const q of queryTokens) {
			if (wordTokens.includes(q)) score += 3;
			else if (wordTokens.some(w => w.startsWith(q))) score += 2;
			else if (text.includes(q)) score += 1;
			else {
				missed = true;
				break;
			}
		}
		if (missed) continue;
		matches.push({ spell: spell as SpellOf<K>, score });
	}
	matches.sort(
		(a, b) =>
			b.score - a.score || b.spell.uses - a.spell.uses || b.spell.lastUsed.localeCompare(a.spell.lastUsed),
	);
	return matches.slice(0, limit);
}
