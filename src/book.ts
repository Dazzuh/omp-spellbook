import * as fs from "node:fs";
import * as path from "node:path";

/** One saved command, filed under the words that asked for it. */
export interface Spell {
	words: string;
	command: string;
	uses: number;
	/** ISO-8601 time of the last save. */
	lastUsed: string;
}

export interface Book {
	version: 1;
	spells: Spell[];
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
	return { version: 1, spells: [] };
}

/**
 * Read the spellbook. A missing file is an empty book; an unreadable one throws {@link BookReadError}
 * so a hand-edited file with a typo is never overwritten.
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
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new BookReadError(file, error);
	}
	const spells = Array.isArray((parsed as Book | undefined)?.spells) ? (parsed as Book).spells : undefined;
	if (!spells) throw new BookReadError(file, new Error('expected { "spells": [...] }'));
	return {
		version: 1,
		spells: spells
			.filter(s => s && typeof s.words === "string" && typeof s.command === "string")
			.map(s => ({
				words: s.words,
				command: s.command,
				uses: Number.isFinite(s.uses) && s.uses > 0 ? Math.floor(s.uses) : 1,
				lastUsed: typeof s.lastUsed === "string" ? s.lastUsed : new Date(0).toISOString(),
			})),
	};
}

/** Write the spellbook atomically (temp file + rename), creating its folder. */
export function writeBook(file: string, book: Book): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(book, null, "\t")}\n`, "utf8");
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

/** File `command` under `words`; the same pair again only bumps its use count. Returns the updated book. */
export function addSpell(book: Book, words: string, command: string, now: Date = new Date()): Book {
	const trimmedWords = words.trim();
	const trimmedCommand = command.trim();
	if (!trimmedWords || !trimmedCommand) return book;
	const key = tokens(trimmedWords).join(" ");
	const existing = book.spells.find(s => s.command === trimmedCommand && tokens(s.words).join(" ") === key);
	if (existing) {
		existing.uses += 1;
		existing.lastUsed = now.toISOString();
		existing.words = trimmedWords;
	} else {
		book.spells.push({ words: trimmedWords, command: trimmedCommand, uses: 1, lastUsed: now.toISOString() });
	}
	return book;
}

export interface SpellMatch {
	spell: Spell;
	score: number;
}

/**
 * Spells whose words (or command) match `query`, best first. Each query token must prefix-match a
 * token of the spell's words or appear in its command; an empty query lists the most used spells.
 */
export function findSpells(book: Book, query: string, limit = 8): SpellMatch[] {
	const queryTokens = tokens(query);
	const matches: SpellMatch[] = [];
	for (const spell of book.spells) {
		const wordTokens = tokens(spell.words);
		const command = spell.command.toLowerCase();
		let score = 0;
		let missed = false;
		for (const q of queryTokens) {
			if (wordTokens.includes(q)) score += 3;
			else if (wordTokens.some(w => w.startsWith(q))) score += 2;
			else if (command.includes(q)) score += 1;
			else {
				missed = true;
				break;
			}
		}
		if (missed) continue;
		matches.push({ spell, score });
	}
	matches.sort(
		(a, b) =>
			b.score - a.score || b.spell.uses - a.spell.uses || b.spell.lastUsed.localeCompare(a.spell.lastUsed),
	);
	return matches.slice(0, limit);
}
