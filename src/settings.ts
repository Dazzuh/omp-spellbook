/**
 * Spellbook's settings. Declared under `omp.settings` in package.json, so they show on the plugin's
 * Configure page (`/settings` → Plugins); omp returns only what the user configured, so every default lives here.
 */
import * as os from "node:os";
import * as path from "node:path";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";

/** Plugin id: the key the Configure page and `omp plugin config` keep `omp.settings` values under. */
export const PLUGIN_NAME = "omp-spellbook";

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
	/** Model or role the cast runs on, in omp's selector form: `@smol`, `anthropic/claude-haiku-5-5:low`. */
	model: string;
}

export function defaultSettings(): SpellbookSettings {
	return { style: "diff", bookPath: "book.json", model: "@smol" };
}

/** Canonical style name for a value, or undefined when it is none of the styles or their letters. */
export function parseStyle(value: unknown): MorphStyle | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim().toLowerCase();
	return (MORPH_STYLES as readonly string[]).includes(key) ? (key as MorphStyle) : STYLE_ALIASES[key];
}

export interface SettingsRead {
	settings: SpellbookSettings;
	/** Values that were ignored, each with why. */
	problems: string[];
}

/**
 * Settings from omp's configured values: defaults, then `values`, then `SPELLBOOK_STYLE` /
 * `SPELLBOOK_BOOK`. Bad values fall back to the default and are reported in `problems`.
 */
export function settingsFrom(
	values: Record<string, unknown>,
	env: Record<string, string | undefined> = process.env,
): SettingsRead {
	const settings = defaultSettings();
	const problems: string[] = [];
	const style = env.SPELLBOOK_STYLE ?? values.style;
	if (style !== undefined) {
		const parsed = parseStyle(style);
		if (parsed) settings.style = parsed;
		else problems.push(`style ${JSON.stringify(style)} is not one of ${MORPH_STYLES.join(", ")}`);
	}
	const bookPath = env.SPELLBOOK_BOOK ?? values.bookPath;
	if (typeof bookPath === "string" && bookPath.trim()) settings.bookPath = bookPath.trim();
	else if (bookPath !== undefined) problems.push(`bookPath ${JSON.stringify(bookPath)} is not a path`);
	const model = values.model;
	if (typeof model === "string" && model.trim()) settings.model = model.trim();
	else if (model !== undefined) problems.push(`model ${JSON.stringify(model)} is not a model or role`);
	return { settings, problems };
}

/** The values omp holds for this plugin (global, then the project's overrides for `cwd`). */
export type PluginSettingsReader = (pluginName: string, cwd: string) => Promise<Record<string, unknown>>;

/**
 * Read the settings now, from omp's plugin settings store. omp reads its lockfile on every call, so a
 * change on the Configure page shows up on the next read. An unreadable store falls back to the defaults.
 */
export async function loadSettings(
	cwd: string,
	env: Record<string, string | undefined> = process.env,
	read: PluginSettingsReader = getPluginSettings,
): Promise<SettingsRead> {
	let values: Record<string, unknown> = {};
	const problems: string[] = [];
	try {
		values = await read(PLUGIN_NAME, cwd);
	} catch (error) {
		problems.push(`omp's plugin settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	const parsed = settingsFrom(values, env);
	return { settings: parsed.settings, problems: [...problems, ...parsed.problems] };
}

/** `<omp agent dir>/spellbook`: where a relative `bookPath` sits. */
export function spellbookDir(agentDir: string): string {
	return path.join(agentDir, "spellbook");
}

/** Absolute spellbook path: `~` is the home folder, a relative path sits in the Spellbook folder `dir`. */
export function resolveBookPath(dir: string, bookPath: string, home: string = os.homedir()): string {
	let expanded = bookPath;
	if (expanded === "~") expanded = home;
	else if (/^~[\\/]/.test(expanded)) expanded = path.join(home, expanded.slice(2));
	return path.resolve(dir, expanded);
}
