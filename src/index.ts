import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	AgentRegistry,
	createAgentSession,
	getAgentDir,
	SessionManager,
	Settings,
	theme,
} from "@oh-my-pi/pi-coding-agent";
import { getActiveRules, setActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getActiveSkills, type Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { isNativeRendering, motionEffectsEnabled } from "@oh-my-pi/pi-tui";
import { wrapAutocomplete } from "./autocomplete";
import { installEditorHooks, type MorphDisplay, type SpellLook } from "./editor";
import { type HelperSdk, runHelper } from "./helper";
import { pickModel } from "./model";
import { parseCast } from "./parse";
import { describeOs, detectShell, liveProbe, type ShellInfo } from "./platform";
import { type LookupPlaces, parsePromptReply, parseShellReply, promptSystemPrompt, shellSystemPrompt } from "./prompt";
import {
	MORPH_STYLES,
	parseStyle,
	readSettings,
	resolveBookPath,
	settingsLocation,
	type SpellbookSettings,
	writeSetting,
} from "./settings";
import { Spellbook } from "./spellbook";

const SDK: HelperSdk = {
	createAgentSession,
	inMemorySessionManager: cwd => SessionManager.inMemory(cwd),
	// Each cast gets its own registry, so its agent id never meets the user's session's.
	agentRegistry: () => new AgentRegistry(),
	// The same array, not a copy: omp tells whether the user's session still owns the snapshot by identity.
	activeSkills: () => getActiveSkills() as Skill[],
	activeRules: getActiveRules,
	restoreRules: setActiveRules,
};

function paint(color: string, text: string): string {
	try {
		return theme.fg(color as never, text);
	} catch {
		return text;
	}
}

/**
 * omp's keyword gradient colour (`createGradientHighlighter`: saturation 90%, lightness 62%) for a hue.
 * Before omp's theme loads, `getColorMode` throws: truecolor is assumed, as most terminals take it, and an
 * unconvertible colour paints nothing, leaving that letter in the default colour.
 */
function hueColor(degrees: number): string {
	let truecolor = true;
	try {
		truecolor = theme.getColorMode() === "truecolor";
	} catch {}
	return Bun.color(`hsl(${Math.round(degrees)}, 90%, 62%)`, truecolor ? "ansi-16m" : "ansi-256") ?? "";
}

/** The shell `!` runs in, from omp's own resolution where it is readable. */
function currentShell(): ShellInfo {
	let shellPath: string | undefined;
	let ompShell: string | undefined;
	try {
		const value = lookup("shellPath")?.get(Settings.instance);
		if (typeof value === "string" && value) shellPath = value;
	} catch {}
	try {
		ompShell = Settings.instance.getShellConfig().shell;
	} catch {}
	return detectShell(liveProbe({ shellPath, ompShell }));
}

export default function spellbook(pi: ExtensionAPI): void {
	pi.setLabel("Spellbook");
	const location = settingsLocation(getAgentDir());
	let current: { settings: SpellbookSettings; problems: string[] } = readSettings(location);
	const reload = () => {
		current = readSettings(location);
		return current.settings;
	};
	const display: MorphDisplay = { frame: undefined, ternReduceMotion: false, editor: undefined, casting: undefined };
	const reduceMotion = () => !motionEffectsEnabled() || display.ternReduceMotion;
	const look: SpellLook = {
		motion: () => !reduceMotion(),
		hue: hueColor,
		native: isNativeRendering,
		now: Date.now,
	};
	/** The context of the latest event; ctx objects differ per event, the Spellbook state must not. */
	let live: ExtensionContext | undefined;
	const ctxNow = (): ExtensionContext => {
		if (!live) throw new Error("Spellbook used before session start");
		return live;
	};
	/** The cast model as omp's roles configure it: role `spellbook`, else `smol`, else the session's model and thinking level. */
	const castModel = (ctx: ExtensionContext) =>
		pickModel({
			role: roles => {
				try {
					return resolveRoleSelection(roles, Settings.instance, ctx.modelRegistry.getAvailable());
				} catch {
					return undefined;
				}
			},
			session: () => (ctx.model ? { model: ctx.model, thinkingLevel: pi.getThinkingLevel() } : undefined),
		});
	/** Where the cast model can look things up: this session's log and the project. */
	const places = (ctx: ExtensionContext): LookupPlaces => ({
		sessionLog: ctx.sessionManager.getSessionFile(),
		cwd: ctx.cwd,
		// The folders omp found the user's skills in (its own discovery), not the skills themselves.
		skillFolders: [...new Set(getActiveSkills().filter(skill => !skill.hide).map(skill => path.dirname(skill.baseDir)))],
	});
	/** One cast: a read-only helper session on the cast model answers `description` under `system`. */
	const cast = async (
		system: string,
		description: string,
		signal: AbortSignal,
	): Promise<{ reply: string; model: string; lookups: string[] }> => {
		const ctx = ctxNow();
		const picked = castModel(ctx);
		if (!picked) throw new Error("no model: set modelRoles.spellbook (or smol) in your omp config");
		const { reply, lookups } = await runHelper(
			{
				cwd: ctx.cwd,
				model: picked.model,
				thinkingLevel: picked.thinkingLevel,
				settings: Settings.instance,
				modelRegistry: ctx.modelRegistry,
				system,
				description,
				signal,
			},
			SDK,
		);
		return { reply, model: `${picked.model.provider}/${picked.model.id}`, lookups };
	};

	const book = new Spellbook({
		ui: {
			getText: () => ctxNow().ui.getEditorText(),
			setText: text => ctxNow().ui.setEditorText(text),
			setLine: line =>
				ctxNow().ui.setWidget("spellbook", line === undefined ? undefined : [line], { placement: "belowEditor" }),
			notify: (message, type) => ctxNow().ui.notify(message, type),
			remember: text => display.editor?.addToHistory?.(text),
		},
		display,
		settings: () => current.settings,
		bookFile: () => resolveBookPath(location, current.settings.bookPath),
		reduceMotion,
		ask: async (description, signal) => {
			const { reply, model, lookups } = await cast(
				shellSystemPrompt(places(ctxNow()), currentShell(), describeOs()),
				description,
				signal,
			);
			const answer = parseShellReply(reply);
			if (!answer) throw new Error(`${model} gave no command: ${reply}`);
			return { answer, model, lookups };
		},
		askPrompt: async (description, signal) => {
			const { reply, model, lookups } = await cast(promptSystemPrompt(places(ctxNow())), description, signal);
			const answer = parsePromptReply(reply);
			if (!answer) throw new Error(`${model} gave no prompt: ${reply}`);
			return { answer, model, lookups };
		},
		setTimeout: (fn, ms) => ctxNow().setTimeout(fn, ms),
		clearTimeout: handle => live?.clearTimer(handle as never),
		paint,
	});

	display.onText = text => book.onTextChange(text);

	pi.on("session_start", async (_event, ctx) => {
		book.dispose();
		live = ctx;
		if (!ctx.hasUI) return;
		for (const problem of current.problems) ctx.ui.notify(`Spellbook settings: ${problem}`, "warning");
		// Re-added on every session_start (/new, resume); wrapAutocomplete skips a provider it already wrapped.
		ctx.ui.addAutocompleteProvider(provider =>
			wrapAutocomplete(provider, {
				find: (query, kind) => book.find(query, undefined, kind),
				onPick: pick => book.pick(pick),
			}),
		);
		if (ctx.mode === "tui" && !display.editor) await installEditorHooks(ctx.ui, display, paint, look);
	});

	pi.on("session_shutdown", () => {
		book.dispose();
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" || !ctx.hasUI) return undefined;
		live = ctx;
		return book.onInput(event.text);
	});

	pi.on("user_bash", (event, ctx) => {
		live = ctx;
		book.onUserBash(event.command);
		return undefined;
	});

	pi.registerCommand("spellbook", {
		description: "Spellbook: settings, saved spells, cast <description> (a command) or prompt <description>",
		getArgumentCompletions: prefix =>
			["style", "book", "list", "cast", "prompt", ...MORPH_STYLES.map(s => `style ${s}`)]
				.filter(option => option.startsWith(prefix))
				.map(option => ({ value: option, label: option })),
		handler: async (args, ctx) => {
			live = ctx;
			// Headless runs (omp -p) have no UI to notify: print instead.
			const say = (text: string, type: "info" | "warning" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(text, type);
				else process.stdout.write(`${text}\n`);
			};
			const [sub = "", ...rest] = args.trim().split(/\s+/);
			const arg = rest.join(" ").trim();
			switch (sub.toLowerCase()) {
				case "style": {
					const style = arg ? parseStyle(arg) : undefined;
					if (!style) {
						say(`Spellbook style is ${current.settings.style}; choose ${MORPH_STYLES.join(", ")} (or D, B, C)`);
						return;
					}
					writeSetting(location, "style", style);
					reload();
					say(`Spellbook style: ${style}`);
					return;
				}
				case "book": {
					if (arg) {
						writeSetting(location, "bookPath", arg);
						reload();
					}
					say(`Spellbook file: ${resolveBookPath(location, current.settings.bookPath)}`);
					return;
				}
				case "list": {
					const commands = book.find(arg, 20).map(m => `${m.spell.words} → ${m.spell.command}`);
					const prompts = book
						.find(arg, 20, "prompt")
						.map(m => `${m.spell.words} → (prompt) ${m.spell.prompt.split(/\r?\n/, 1)[0]}`);
					const lines = [...commands, ...prompts];
					say(lines.length ? lines.join("\n") : "No saved spells match.");
					return;
				}
				case "cast":
				case "prompt": {
					const kind = sub.toLowerCase() === "cast" ? "shell" : "prompt";
					const request = parseCast(`${kind === "shell" ? "?!" : "?"} ${arg}`);
					if (request?.kind !== kind) {
						say(`Usage: /spellbook ${sub.toLowerCase()} <description>`, "warning");
						return;
					}
					if (ctx.hasUI) {
						await book.cast(request);
						return;
					}
					const started = Date.now();
					const signal = AbortSignal.timeout(300_000);
					const result =
						kind === "shell"
							? await book.deps.ask(request.description, signal)
							: await book.deps.askPrompt(request.description, signal);
					const ms = Date.now() - started;
					process.stdout.write(
						`${JSON.stringify({ ...result.answer, model: result.model, ms, lookups: result.lookups ?? [] })}\n`,
					);
					return;
				}
				default: {
					const picked = castModel(ctx);
					const model = picked
						? `${picked.model.provider}/${picked.model.id}${picked.thinkingLevel ? `:${picked.thinkingLevel}` : ""} (via ${picked.via})`
						: "none";
					say(
						[
							`Style: ${current.settings.style}   (/spellbook style diff|decode|rewind|none)`,
							`File: ${resolveBookPath(location, current.settings.bookPath)}`,
							`Settings: ${location.file}`,
							`Model: ${model}`,
							`Shell: ${currentShell().shell}`,
							"Type `? <description>` for an omp prompt, `?! <description>` for a command (`?!!` for `!!`); Tab on a `?` or `?!` line lists saved ones.",
						].join("\n"),
					);
				}
			}
		},
	});
}
