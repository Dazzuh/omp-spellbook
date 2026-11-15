import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** How the command arrives in the composer. */
export const MORPH_STYLES = ["diff", "decode", "rewind", "none"] as const;
export type MorphStyle = (typeof MORPH_STYLES)[number];

/** The letters the plan uses for the styles (D, B, C), accepted as aliases. */
const STYLE_ALIASES: Record<string, MorphStyle> = { d: "diff", b: "decode", c: "rewind", off: "none" };

export interface SpellbookSettings {
	/** Morph style: `diff` (D, default), `decode` (B), `rewind` (C) or `none`. */
	style: MorphStyle;
	/** Spellbook file; `~` expands to the home folder, relative paths resolve against the Spellbook folder. */
	bookPath: string;
	/** How many recent `!` commands go into the request as context. */
	recentCommands: number;
}

export interface SettingsLocation {
	/** `<omp agent dir>/spellbook` */
	dir: string;
	/** `<dir>/settings.json` */
	file: string;
}

export function settingsLocation(agentDir: string): SettingsLocation {
	const dir = path.join(agentDir, "spellbook");
	return { dir, file: path.join(dir, "settings.json") };
}

export function defaultSettings(): SpellbookSettings {
	return { style: "diff", bookPath: "book.json", recentCommands: 5 };
}

/** Canonical style name for a value, or undefined when it is none of the styles or their letters. */
export function parseStyle(value: unknown): MorphStyle | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim().toLowerCase();
	return (MORPH_STYLES as readonly string[]).includes(key) ? (key as MorphStyle) : STYLE_ALIASES[key];
}

/**
 * Read settings: defaults, then the settings file, then `SPELLBOOK_STYLE` / `SPELLBOOK_BOOK`.
 * Bad values fall back to the default and are reported in `problems`.
 */
export function readSettings(
	location: SettingsLocation,
	env: Record<string, string | undefined> = process.env,
): { settings: SpellbookSettings; problems: string[] } {
	const settings = defaultSettings();
	const problems: string[] = [];
	let raw: Record<string, unknown> = {};
	try {
		const text = fs.readFileSync(location.file, "utf8").replace(/^\uFEFF/, "");
		if (text.trim()) raw = JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			problems.push(`${location.file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const style = env.SPELLBOOK_STYLE ?? raw.style;
	if (style !== undefined) {
		const parsed = parseStyle(style);
		if (parsed) settings.style = parsed;
		else problems.push(`style ${JSON.stringify(style)} is not one of ${MORPH_STYLES.join(", ")}`);
	}
	const bookPath = env.SPELLBOOK_BOOK ?? raw.bookPath;
	if (typeof bookPath === "string" && bookPath.trim()) settings.bookPath = bookPath.trim();
	if (typeof raw.recentCommands === "number" && raw.recentCommands >= 0) {
		settings.recentCommands = Math.min(20, Math.floor(raw.recentCommands));
	}
	return { settings, problems };
}

/** Save one setting into the settings file, keeping the other keys. Throws rather than overwrite a file it can't parse. */
export function writeSetting(location: SettingsLocation, key: keyof SpellbookSettings, value: unknown): void {
	let raw: Record<string, unknown> = {};
	let text = "";
	try {
		text = fs.readFileSync(location.file, "utf8").replace(/^\uFEFF/, "");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (text.trim()) raw = JSON.parse(text) as Record<string, unknown>;
	raw[key] = value;
	fs.mkdirSync(location.dir, { recursive: true });
	fs.writeFileSync(location.file, `${JSON.stringify(raw, null, "\t")}\n`, "utf8");
}

/** Absolute spellbook path: `~` is the home folder, a relative path sits in the Spellbook folder. */
export function resolveBookPath(location: SettingsLocation, bookPath: string, home: string = os.homedir()): string {
	let expanded = bookPath;
	if (expanded === "~") expanded = home;
	else if (/^~[\\/]/.test(expanded)) expanded = path.join(home, expanded.slice(2));
	return path.resolve(location.dir, expanded);
}
