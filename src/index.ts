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
import { getModelMatchPreferences, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getActiveSkills, type Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { isNativeRendering, motionEffectsEnabled } from "@oh-my-pi/pi-tui";
import { wrapAutocomplete } from "./autocomplete";
import { type CastStart, castFileName, castsDir, recentCasts } from "./castlog";
import { installEditorHooks, type MorphDisplay, type SpellLook } from "./editor";
import { castAndLog, type HelperSdk } from "./helper";
import { castModel } from "./model";
import { nowRows, SpellbookPanel } from "./panel";
import { parseCast } from "./parse";
import { describeOs, detectShell, liveProbe, type ShellInfo } from "./platform";
import {
	type LookupPlaces,
	parsePromptReply,
	parseShellReply,
	promptSystemPrompt,
	shellSystemPrompt,
	writerRules,
} from "./prompt";
import {
	loadSettings,
	resolveBookPath,
	type SettingsRead,
	type SpellbookSettings,
	settingsFrom,
	spellbookDir,
} from "./settings";
import { type CastResult, oneLine, Spellbook } from "./spellbook";

/** Where this omp's cast logs go. */
const castsFolder = () => castsDir(spellbookDir(getAgentDir()));

/** omp's SDK as a cast uses it, its logs in the folder `dir` names at each cast. */
export function ompSdk(dir: () => string): HelperSdk {
	return {
		createAgentSession,
		// A session file of omp's own format in Spellbook's folder. Opened rather than created so omp writes no
		// terminal breadcrumb for it: `omp --continue` must find the user's session, never a cast.
		castLog: cwd =>
			SessionManager.open(path.join(dir(), castFileName(new Date(), Bun.randomUUIDv7())), undefined, undefined, {
				initialCwd: cwd,
				suppressBreadcrumb: true,
			}),
		appendToLog: async (file, customType, data) => {
			const log = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
			try {
				log.appendCustomEntry(customType, data);
			} finally {
				await log.close();
			}
		},
		// Each cast gets its own registry, so its agent id never meets the user's session's.
		agentRegistry: () => new AgentRegistry(),
		// The same array, not a copy: omp tells whether the user's session still owns the snapshot by identity.
		activeSkills: () => getActiveSkills() as Skill[],
		activeRules: getActiveRules,
		restoreRules: setActiveRules,
	};
}

const SDK = ompSdk(castsFolder);

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
	const bookDir = spellbookDir(getAgentDir());
	/** The settings as last read; every entry point re-reads them first, so a Configure change applies at once. */
	let current: SettingsRead = settingsFrom({});
	const reported = new Set<string>();
	/** Re-read the settings from omp's plugin settings store; each new problem is reported once. */
	const refresh = async (ctx: ExtensionContext): Promise<SpellbookSettings> => {
		current = await loadSettings(ctx.cwd);
		for (const problem of current.problems) {
			if (reported.has(problem)) continue;
			reported.add(problem);
			if (ctx.hasUI) ctx.ui.notify(oneLine(`Spellbook settings: ${problem}`), "warning");
		}
		return current.settings;
	};
	const bookFile = () => resolveBookPath(bookDir, current.settings.bookPath);
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
	/**
	 * The cast model: the `model` setting resolved as omp resolves prewalk targets (role aliases,
	 * `provider/id`, thinking level), else the session's model and thinking level with the reason.
	 */
	const pickModel = (ctx: ExtensionContext, selector: string) =>
		castModel(selector, {
			resolve: cliModel =>
				resolveCliModel({
					cliModel,
					modelRegistry: ctx.modelRegistry,
					settings: Settings.instance,
					preferences: getModelMatchPreferences(Settings.instance),
				}),
			unusable: model => {
				// As prewalk: offline mode keeps the cast on the session's provider.
				if (lookup("models.offline")?.get(Settings.instance) === true && ctx.model && model.provider !== ctx.model.provider) {
					return `offline mode keeps casts on the session's provider, ${ctx.model.provider}`;
				}
				return ctx.modelRegistry.hasConfiguredAuth(model) ? undefined : `no API key for ${model.provider}/${model.id}`;
			},
			session: () => (ctx.model ? { model: ctx.model, thinkingLevel: pi.getThinkingLevel() } : undefined),
		});
	const modelName = (picked: { model: { provider: string; id: string }; thinkingLevel?: string }) =>
		`${picked.model.provider}/${picked.model.id}${picked.thinkingLevel ? `:${picked.thinkingLevel}` : ""}`;
	/** Where the cast model can look things up: this session's log and the project. */
	const places = (ctx: ExtensionContext): LookupPlaces => ({
		sessionLog: ctx.sessionManager.getSessionFile(),
		cwd: ctx.cwd,
		// The folders omp found the user's skills in (its own discovery), not the skills themselves.
		skillFolders: [...new Set(getActiveSkills().filter(skill => !skill.hide).map(skill => path.dirname(skill.baseDir)))],
	});
	/** One cast, logged: a read-only helper session on the cast model answers `description`. */
	const cast = async <A>(
		start: Pick<CastStart, "kind" | "sigil" | "description">,
		signal: AbortSignal,
		parse: (reply: string) => A | undefined,
	): Promise<CastResult<A>> => {
		const ctx = ctxNow();
		const settings = await refresh(ctx);
		const picked = pickModel(ctx, settings.model);
		const model = `${picked.model.provider}/${picked.model.id}`;
		const note = picked.fallback
			? `model setting "${picked.selector}" not used: ${picked.fallback}; cast on the session's ${modelName(picked)}`
			: undefined;
		const lookIn = places(ctx);
		const { answer, lookups, settle } = await castAndLog(
			{
				cwd: ctx.cwd,
				model: picked.model,
				thinkingLevel: picked.thinkingLevel,
				settings: Settings.instance,
				modelRegistry: ctx.modelRegistry,
				system: rules =>
					start.kind === "prompt"
						? promptSystemPrompt(lookIn, writerRules(rules))
						: shellSystemPrompt(lookIn, currentShell(), describeOs()),
				description: start.description,
				signal,
				start: {
					...start,
					setting: settings.model,
					model,
					thinkingLevel: picked.thinkingLevel,
					note,
					headless: ctx.hasUI ? undefined : true,
				},
			},
			SDK,
			parse,
		);
		return { answer, model, lookups, note, settle };
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
		bookFile,
		reduceMotion,
		ask: (description, signal, sigil) => cast({ kind: "shell", sigil, description }, signal, parseShellReply),
		askPrompt: (description, signal) => cast({ kind: "prompt", description }, signal, parsePromptReply),
		setTimeout: (fn, ms) => ctxNow().setTimeout(fn, ms),
		clearTimeout: handle => live?.clearTimer(handle as never),
		paint,
	});

	display.onText = text => book.onTextChange(text);

	pi.on("session_start", async (_event, ctx) => {
		book.dispose();
		live = ctx;
		if (!ctx.hasUI) return;
		await refresh(ctx);
		// Re-added on every session_start (/new, resume); wrapAutocomplete skips a provider it already wrapped.
		ctx.ui.addAutocompleteProvider(provider =>
			wrapAutocomplete(provider, {
				find: async (query, kind) => {
					await refresh(ctxNow());
					return book.find(query, undefined, kind);
				},
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
		// Decided in the same tick as Enter, so a morph can't finish between Enter and the decision. A cast re-reads
		// the settings itself; a sent prompt spell is saved where the settings named at its cast.
		return book.onInput(event.text);
	});

	pi.on("user_bash", async (event, ctx) => {
		live = ctx;
		await refresh(ctx);
		book.onUserBash(event.command);
		return undefined;
	});

	/** The Now rows from the settings just read. */
	const now = (ctx: ExtensionContext, settings: SpellbookSettings) => {
		let model: string | undefined;
		let fallback: string | undefined;
		try {
			const picked = pickModel(ctx, settings.model);
			model = modelName(picked);
			fallback = picked.fallback;
		} catch (error) {
			fallback = error instanceof Error ? error.message : String(error);
		}
		return nowRows({
			style: settings.style,
			bookFile: bookFile(),
			modelSetting: settings.model,
			model,
			fallback,
			shell: currentShell().shell,
			castsDir: castsFolder(),
			problems: current.problems,
			overrides: ["SPELLBOOK_STYLE", "SPELLBOOK_BOOK"].flatMap(name => (process.env[name] ? [`${name}=${process.env[name]}`] : [])),
		});
	};

	/** Open the panel over the session until Esc; it never enters the session or the model's context. */
	const openPanel = (ctx: ExtensionContext, query: string) =>
		ctx.ui.custom<void>(
			(tui, _theme, _keybindings, done) =>
				new SpellbookPanel(
					{
						find: (q, kind) => book.find(q, 50, kind).map(match => match.spell),
						now: () => now(ctx, current.settings),
						casts: () => recentCasts(castsFolder()),
						land: spell => {
							const from = ctx.ui.getEditorText();
							// The composer's own `?!!` or `!!` keeps a command's output out of context, as Tab does.
							const sigil = /^\s*\?!!|^\s*!!/.test(from) ? "!!" : "!";
							book.pick(
								spell.kind === "command"
									? { kind: "command", from, sigil, words: spell.words, command: spell.command }
									: { kind: "prompt", from, words: spell.words, prompt: spell.prompt },
							);
						},
						forget: spell => book.forget(spell),
						close: () => done(undefined),
						requestRender: () => tui.requestRender(),
						paint,
					},
					"spells",
					query,
				),
			{ overlay: true },
		);

	pi.registerCommand("spellbook", {
		description: "Spellbook: saved spells, settings and recent casts in one panel; cast <description> (a command) or prompt <description>",
		getArgumentCompletions: prefix =>
			["list", "cast", "prompt"]
				.filter(option => option.startsWith(prefix))
				.map(option => ({ value: option, label: option })),
		handler: async (args, ctx) => {
			live = ctx;
			const settings = await refresh(ctx);
			const [sub = "", ...rest] = args.trim().split(/\s+/);
			const arg = rest.join(" ").trim();
			switch (sub.toLowerCase()) {
				case "cast":
				case "prompt": {
					const kind = sub.toLowerCase() === "cast" ? "shell" : "prompt";
					const request = parseCast(`${kind === "shell" ? "?!" : "?"} ${arg}`);
					if (request?.kind !== kind) {
						const usage = `Usage: /spellbook ${sub.toLowerCase()} <description>`;
						if (ctx.hasUI) ctx.ui.notify(usage, "warning");
						else process.stdout.write(`${usage}\n`);
						return;
					}
					if (ctx.hasUI) {
						await book.cast(request);
						return;
					}
					// Headless (omp -p): the answer is printed as JSON, nothing lands in a composer.
					const started = Date.now();
					const signal = AbortSignal.timeout(300_000);
					const result =
						request.kind === "shell"
							? await book.deps.ask(request.description, signal, request.sigil)
							: await book.deps.askPrompt(request.description, signal);
					const ms = Date.now() - started;
					await result.settle?.({ outcome: "landed", landed: result.answer.text });
					process.stdout.write(
						`${JSON.stringify({ ...result.answer, model: result.model, ms, lookups: result.lookups ?? [], ...(result.note ? { note: result.note } : {}) })}\n`,
					);
					return;
				}
				default: {
					if (!ctx.hasUI) {
						// Headless: the Now rows as text, the one part of the panel that needs no keyboard.
						process.stdout.write(`${now(ctx, settings).map(row => `${row.label}: ${row.value}`).join("\n")}\n`);
						return;
					}
					// Not awaited: the panel stays open while the session carries on, mid-turn too.
					// `/spellbook list <words>` and `/spellbook <words>` both open Spells searching for the words.
					openPanel(ctx, sub.toLowerCase() === "list" ? arg : args.trim()).catch(error =>
						ctx.ui.notify(oneLine(`Spellbook panel: ${error instanceof Error ? error.message : String(error)}`), "error"),
					);
				}
			}
		},
	});
}
