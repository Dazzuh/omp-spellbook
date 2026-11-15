/** A `?!` or `?!!` line asking Spellbook for a shell command. */
export interface ShellCast {
	kind: "shell";
	/** `!` for `?!`, `!!` for `?!!` (output kept out of the model's context). */
	sigil: "!" | "!!";
	/** The user's own words, trimmed. */
	description: string;
}

/** A `?` line asking Spellbook for an omp prompt. */
export interface PromptCast {
	kind: "prompt";
	/** The user's own words, trimmed. */
	description: string;
}

/** A spell line one Enter would cast. */
export type CastRequest = PromptCast | ShellCast;

/** A composer line holding a shell command, as omp's `!`/`!!` reads it. */
export interface ShellLine {
	sigil: "!" | "!!";
	command: string;
}

/**
 * The spell prefix: `?`, `?!` or `?!!`, never followed by another `?` or `!` (so `??`, `???` and
 * `?!!!` are not spells). Group 1 is the bangs after the `?`.
 */
const PREFIX = String.raw`\?(!{0,2})(?![?!])`;

const CAST_RE = new RegExp(String.raw`^\s*${PREFIX}[ \t]*(\S[\s\S]*?)\s*$`);
const SHELL_RE = /^\s*(!!?)(?!!)[ \t]*(\S[\s\S]*?)\s*$/;

/** Parse `? <description>`, `?! <description>` or `?!! <description>`; anything else is not a cast. */
export function parseCast(text: string): CastRequest | undefined {
	const match = CAST_RE.exec(text);
	if (!match) return undefined;
	const bangs = match[1]!;
	const description = match[2]!.replace(/\r\n?/g, "\n");
	return bangs ? { kind: "shell", sigil: bangs as "!" | "!!", description } : { kind: "prompt", description };
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

/** The spell prefix that asks for `request`'s kind: `?`, `?!` or `?!!`. */
export function castPrefix(request: { kind: "prompt" } | { kind: "shell"; sigil: "!" | "!!" }): string {
	return request.kind === "prompt" ? "?" : `?${request.sigil}`;
}

/** A spell line's words typed so far (possibly none), for matching while the user types. */
export type CastQuery = { kind: "prompt"; query: string } | { kind: "shell"; sigil: "!" | "!!"; query: string };

const QUERY_RE = new RegExp(String.raw`^\s*${PREFIX}[ \t]*([\s\S]*)$`);

/** The kind of a spell line and the text after its prefix (and its spaces). */
export function castQuery(text: string): CastQuery | undefined {
	const match = QUERY_RE.exec(text);
	if (!match) return undefined;
	const query = match[2]!.trim();
	const bangs = match[1]!;
	return bangs ? { kind: "shell", sigil: bangs as "!" | "!!", query } : { kind: "prompt", query };
}

/** A UTF-16 range into the composer text. */
export interface TextRange {
	from: number;
	to: number;
}

/** Where the parts of a spell line sit, as UTF-16 offsets into the composer text. */
export type SpellRanges = {
	/** The `?`/`?!`/`?!!` prefix. */
	sigil: TextRange;
	/** The prefix plus the spaces after it: what the chip stands in for. */
	lead: TextRange;
	/** The description, trimmed; undefined while only the prefix is typed. */
	description: TextRange | undefined;
} & ({ kind: "prompt" } | { kind: "shell"; bang: "!" | "!!" });

/** {@link CAST_RE} with the spacing captured and the description optional, so a bare `?` is a spell too. */
const SPELL_RE = new RegExp(String.raw`^(\s*)${PREFIX}([ \t]*)(\S[\s\S]*?)?\s*$`);

/**
 * The prefix and description of a spell line: one Enter would cast (as {@link parseCast} reads it),
 * or a prefix still waiting for its words. Undefined for anything else.
 */
export function spellRanges(text: string): SpellRanges | undefined {
	const match = SPELL_RE.exec(text);
	if (!match) return undefined;
	const sigilFrom = match[1]!.length;
	const bangs = match[2]!;
	const sigilTo = sigilFrom + 1 + bangs.length;
	const descFrom = sigilTo + match[3]!.length;
	const words = match[4];
	const ranges = {
		sigil: { from: sigilFrom, to: sigilTo },
		lead: { from: sigilFrom, to: descFrom },
		description: words ? { from: descFrom, to: descFrom + words.length } : undefined,
	};
	return bangs ? { ...ranges, kind: "shell", bang: bangs as "!" | "!!" } : { ...ranges, kind: "prompt" };
}
