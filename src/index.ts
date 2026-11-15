import * as os from "node:os";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, settings as ompSettings, theme } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { isNativeRendering, motionEffectsEnabled } from "@oh-my-pi/pi-tui";
import { wrapAutocomplete } from "./autocomplete";
import { installEditorHooks, type MorphDisplay, type SpellLook } from "./editor";
import { pickModel, replyText } from "./model";
import { parseCast } from "./parse";
import { describeOs, detectShell, liveProbe, readSshHosts, type ShellInfo } from "./platform";
import { buildSystemPrompt, buildUserMessage, parseAnswer } from "./prompt";
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

/** Output budget for one answer: a command line and a sentence. */
const MAX_TOKENS = 400;

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
		const value = lookup("shellPath")?.get(ompSettings);
		if (typeof value === "string" && value) shellPath = value;
	} catch {}
	try {
		ompShell = ompSettings.getShellConfig().shell;
	} catch {}
	return detectShell(liveProbe({ shellPath, ompShell }));
}

/** The last `count` commands run with `!`/`!!` on this session's branch. */
function recentBashCommands(ctx: ExtensionContext, count: number): string[] {
	if (count <= 0) return [];
	const commands: string[] = [];
	for (const entry of ctx.sessionManager.getBranch() as ReadonlyArray<{
		type: string;
		message?: { role?: string; command?: unknown };
	}>) {
		if (entry.type === "message" && entry.message?.role === "bashExecution") {
			if (typeof entry.message.command === "string") commands.push(entry.message.command);
		}
	}
	return commands.slice(-count);
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

	const book = new Spellbook({
		ui: {
			getText: () => ctxNow().ui.getEditorText(),
			setText: text => ctxNow().ui.setEditorText(text),
			setLine: line =>
				ctxNow().ui.setWidget("spellbook", line === undefined ? undefined : [line], { placement: "belowEditor" }),
			notify: (message, type) => ctxNow().ui.notify(message, type),
		},
		display,
		settings: () => current.settings,
		bookFile: () => resolveBookPath(location, current.settings.bookPath),
		reduceMotion,
		context: () => ({
			cwd: ctxNow().cwd,
			os: describeOs(),
			shell: currentShell(),
			sshHosts: readSshHosts(os.homedir()),
			recentCommands: recentBashCommands(ctxNow(), current.settings.recentCommands),
		}),
		ask: async (packet, signal) => {
			const ctx = ctxNow();
			const picked = pickModel(ctx.models);
			if (!picked) throw new Error("no model: set modelRoles.spellbook (or smol) in your omp config");
			const model = picked.model;
			const apiKey = await ctx.modelRegistry.getApiKey(model);
			if (!apiKey) throw new Error(`no credential for ${model.provider}; log in with /login`);
			const message = await completeSimple(
				model,
				{
					systemPrompt: [buildSystemPrompt(packet.shell)],
					messages: [{ role: "user", content: buildUserMessage(packet), timestamp: Date.now() }],
				},
				{ apiKey, maxTokens: MAX_TOKENS, disableReasoning: true, temperature: 0, signal },
			);
			const answer = parseAnswer(replyText(message));
			if (!answer) throw new Error(`${model.id} gave no command`);
			return { answer, model: `${model.provider}/${model.id}` };
		},
		setTimeout: (fn, ms) => ctxNow().setTimeout(fn, ms),
		clearTimeout: handle => live?.clearTimer(handle as never),
		paint,
	});

	pi.on("session_start", async (_event, ctx) => {
		book.dispose();
		live = ctx;
		if (!ctx.hasUI) return;
		for (const problem of current.problems) ctx.ui.notify(`Spellbook settings: ${problem}`, "warning");
		// Re-added on every session_start (/new, resume); wrapAutocomplete skips a provider it already wrapped.
		ctx.ui.addAutocompleteProvider(provider =>
			wrapAutocomplete(provider, {
				find: query => book.find(query),
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
		description: "Spellbook: settings, saved commands, or cast <description>",
		getArgumentCompletions: prefix =>
			["style", "book", "list", "cast", ...MORPH_STYLES.map(s => `style ${s}`)]
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
					const matches = book.find(arg, 20);
					say(
						matches.length
							? matches.map(m => `${m.spell.words} → ${m.spell.command}`).join("\n")
							: "No saved commands match.",
					);
					return;
				}
				case "cast": {
					const request = parseCast(`?! ${arg}`);
					if (request?.kind !== "shell") {
						say("Usage: /spellbook cast <description>", "warning");
						return;
					}
					if (ctx.hasUI) {
						await book.cast(request);
						return;
					}
					const spells = book.find(request.description, 5).map(m => ({ words: m.spell.words, command: m.spell.command }));
					const result = await book.deps.ask(
						{ ...book.deps.context(), description: request.description, spells },
						AbortSignal.timeout(60_000),
					);
					process.stdout.write(`${JSON.stringify({ ...result.answer, model: result.model })}\n`);
					return;
				}
				default: {
					const picked = pickModel(ctx.models);
					say(
						[
							`Style: ${current.settings.style}   (/spellbook style diff|decode|rewind|none)`,
							`File: ${resolveBookPath(location, current.settings.bookPath)}`,
							`Settings: ${location.file}`,
							`Model: ${picked ? `${picked.model.provider}/${picked.model.id} (via ${picked.via})` : "none"}`,
							`Shell: ${currentShell().shell}`,
							"Type `?! <description>` for a command, `?!! ` for `!!`; Tab on a `?!` line lists saved ones.",
						].join("\n"),
					);
				}
			}
		},
	});
}
