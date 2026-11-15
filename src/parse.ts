/** A `?` or `??` line asking Spellbook for a command. */
export interface CastRequest {
	/** `!` for `?`, `!!` for `??` (output kept out of the model's context). */
	sigil: "!" | "!!";
	/** The user's own words, trimmed. */
	description: string;
}

/** A composer line holding a shell command, as omp's `!`/`!!` reads it. */
export interface ShellLine {
	sigil: "!" | "!!";
	command: string;
}

const CAST_RE = /^\s*(\?\??)(?![?])[ \t]*(\S[\s\S]*?)\s*$/;
const SHELL_RE = /^\s*(!!?)(?!!)[ \t]*(\S[\s\S]*?)\s*$/;

/** Parse `? <description>` / `?? <description>`; anything else is not a cast. */
export function parseCast(text: string): CastRequest | undefined {
	const match = CAST_RE.exec(text);
	if (!match) return undefined;
	return { sigil: match[1] === "??" ? "!!" : "!", description: match[2]!.replace(/\r\n?/g, "\n") };
}

/** Parse a `!cmd` / `!!cmd` composer line. */
export function parseShellLine(text: string): ShellLine | undefined {
	const match = SHELL_RE.exec(text);
	if (!match) return undefined;
	return { sigil: match[1] as "!" | "!!", command: match[2]! };
}

/** The composer text for a command: `!<command>` or `!!<command>`. */
export function shellText(sigil: "!" | "!!", command: string): string {
	return `${sigil}${command}`;
}

/** The text after a leading `?`/`??` (and its spaces), for matching while the user types. */
export function castQuery(text: string): { sigil: "!" | "!!"; query: string } | undefined {
	const match = /^\s*(\?\??)(?![?])[ \t]*([\s\S]*)$/.exec(text);
	if (!match) return undefined;
	return { sigil: match[1] === "??" ? "!!" : "!", query: match[2]!.trim() };
}

/** Where the parts of a spell line sit, as UTF-16 offsets into the composer text. */
export interface SpellRanges {
	/** The `?`/`??` sigil. */
	sigil: { from: number; to: number };
	/** The description, trimmed; undefined while only the sigil is typed. */
	description: { from: number; to: number } | undefined;
}

/** {@link CAST_RE} with the spacing captured and the description optional, so a bare `?` is a spell too. */
const SPELL_RE = /^(\s*)(\?\??)(?![?])([ \t]*)(\S[\s\S]*?)?\s*$/;

/**
 * The sigil and description of a spell line: one Enter would cast (as {@link parseCast} reads it), or a
 * `?`/`??` still waiting for its words. Undefined for anything else.
 */
export function spellRanges(text: string): SpellRanges | undefined {
	const match = SPELL_RE.exec(text);
	if (!match) return undefined;
	const sigilFrom = match[1]!.length;
	const sigilTo = sigilFrom + match[2]!.length;
	const descFrom = sigilTo + match[3]!.length;
	const words = match[4];
	return {
		sigil: { from: sigilFrom, to: sigilTo },
		description: words ? { from: descFrom, to: descFrom + words.length } : undefined,
	};
}
