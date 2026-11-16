import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createAgentSession,
	discoverAuthStorage,
	discoverSkills,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { getModelMatchPreferences, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { getActiveSkills, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { CAST_ENTRY, castsDir, OUTCOME_ENTRY, recentCasts, SUPERSEDED, summarizeCast } from "../src/castlog";
import {
	CAST_TOOLS,
	castAndLog,
	type HelperRequest,
	type HelperSdk,
	type HelperSession,
	helperOptions,
	lastReply,
	runHelper,
} from "../src/helper";
import { ompSdk } from "../src/index";
import { castModel } from "../src/model";
import { parsePromptReply } from "../src/prompt";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "spellbook-cast-"));
// omp keeps its auth database open for the process, so the folder may be locked until exit (Windows).
afterAll(() => {
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {}
});

const CASTS = castsDir(path.join(root, "spellbook"));
const REAL_SDK: HelperSdk = ompSdk(() => CASTS);

/**
 * An isolated omp: its own agent folder, settings with the given roles, and every built-in model. `pick` resolves a
 * `model` setting through omp's `resolveCliModel` against a fake registry that offers every model as authenticated,
 * so no credentials are needed; `picked` is the default setting, `@smol`.
 */
async function isolatedOmp(roles: Record<string, string>, extra: Record<string, unknown> = {}) {
	const agentDir = fs.mkdtempSync(path.join(root, "agent-"));
	const settings = Settings.isolated({ modelRoles: roles, ...extra });
	const modelRegistry = new ModelRegistry(await discoverAuthStorage(agentDir, { settings }));
	const models = modelRegistry.getAll();
	const registry = { getAll: () => models, getAvailable: () => models };
	// The session's model in these tests: any catalog model from another provider than the ones the settings name.
	const sessionModel = models.find(model => model.provider !== "anthropic")!;
	const resolve = (cliModel: string) =>
		resolveCliModel({ cliModel, modelRegistry: registry, settings, preferences: getModelMatchPreferences(settings) });
	// omp's own value for "medium", typed as omp types it.
	const medium = resolve("anthropic/claude-opus-5-5:medium").thinkingLevel;
	const pick = (selector: string, options: { session?: boolean; noKey?: string } = {}) =>
		castModel(selector, {
			resolve,
			unusable: model => (model.provider === options.noKey ? `no API key for ${options.noKey}` : undefined),
			session: () => (options.session ? { model: sessionModel, thinkingLevel: medium } : undefined),
		});
	return { agentDir, settings, modelRegistry, pick, sessionModel, picked: pick("@smol") };
}

describe("the cast model is the model setting, resolved as omp resolves prewalk targets", () => {
	const roles = {
		smol: "anthropic/claude-haiku-5-5:low",
		slow: "anthropic/claude-opus-5-5:high",
		spellbook: "anthropic/claude-sonnet-5-5:medium",
	};
	const session = true;

	test("a role alias runs as that role is configured, thinking level included", async () => {
		const omp = await isolatedOmp(roles);
		expect(omp.pick("@smol")).toMatchObject({ selector: "@smol", thinkingLevel: "low", model: { id: "claude-haiku-5-5" } });
		expect(omp.pick("@slow")).toMatchObject({ selector: "@slow", thinkingLevel: "high", model: { id: "claude-opus-5-5" } });
		// The old `spellbook` role still works when named.
		expect(omp.pick("@spellbook")).toMatchObject({ thinkingLevel: "medium", model: { id: "claude-sonnet-5-5" } });
		expect(omp.pick("@smol").fallback).toBeUndefined();
	});

	test("a provider/id:thinking string runs with that thinking level", async () => {
		const omp = await isolatedOmp(roles);
		expect(omp.pick("anthropic/claude-haiku-5-5:xhigh", { session })).toMatchObject({
			thinkingLevel: "xhigh",
			model: { provider: "anthropic", id: "claude-haiku-5-5" },
		});
		expect(omp.pick("anthropic/claude-opus-5-5", { session }).fallback).toBeUndefined();
	});

	test("a value that doesn't resolve falls back to the session's model and thinking level, with the reason", async () => {
		const omp = await isolatedOmp(roles);
		const bad = omp.pick("nosuchprovider/nosuch-model:low", { session });
		expect(bad).toMatchObject({ model: omp.sessionModel, thinkingLevel: "medium", selector: "nosuchprovider/nosuch-model:low" });
		expect(bad.fallback).toBeTruthy();
		const unsetRole = omp.pick("@nosuchrole", { session });
		expect(unsetRole).toMatchObject({ model: omp.sessionModel, thinkingLevel: "medium" });
		expect(unsetRole.fallback).toBeTruthy();
		const noKey = omp.pick("@slow", { session, noKey: "anthropic" });
		expect(noKey).toMatchObject({ model: omp.sessionModel, thinkingLevel: "medium", fallback: "no API key for anthropic" });
		expect(() => omp.pick("nosuchprovider/nosuch-model")).toThrow(/session has no model/);
	});

	test("the helper session gets the model and thinking level and no other model knob", async () => {
		const omp = await isolatedOmp({ smol: "anthropic/claude-haiku-5-5:low" });
		const options = helperOptions(
			{
				cwd: root,
				model: omp.picked!.model,
				thinkingLevel: omp.picked!.thinkingLevel,
				settings: omp.settings,
				modelRegistry: omp.modelRegistry,
			},
			"S",
			SessionManager.inMemory(root),
			REAL_SDK,
		);
		expect(options.model).toBe(omp.picked!.model);
		expect(String(options.thinkingLevel)).toBe("low");
		expect(Object.keys(options).sort()).toEqual(
			[
				"agentDisplayName",
				"agentId",
				"agentRegistry",
				"authStorage",
				"bindProcessState",
				"cacheWarming",
				"cwd",
				"disableExtensionDiscovery",
				"enableIrc",
				"enableLsp",
				"enableMCP",
				"hasUI",
				"model",
				"modelRegistry",
				"restrictToolNames",
				"sessionManager",
				"settings",
				"systemPrompt",
				"taskDepth",
				"thinkingLevel",
				"skills",
				"toolNames",
			].sort(),
		);
		// The user's own skills, the same array: never `[]`, which would hide skill:// from the model.
		expect(options.skills).toBe(getActiveSkills() as never);
	});
});

describe("the cast session in stock omp", () => {
	test("read-only tools only; they reach the session log, omp://, skill://, cfg:// and the project", async () => {
		const project = fs.mkdtempSync(path.join(root, "project-"));
		const skills = fs.mkdtempSync(path.join(root, "skills-"));
		fs.mkdirSync(path.join(skills, "tidy"));
		fs.writeFileSync(path.join(skills, "tidy", "SKILL.md"), "---\nname: tidy\ndescription: Tidies a repo.\n---\nTidy skill body\n");
		fs.writeFileSync(path.join(project, "notes.md"), "project notes\n");
		// The live session's log sits outside the project, as omp's own logs do.
		const log = path.join(root, "session.jsonl");
		fs.writeFileSync(log, '{"type":"message","message":{"role":"user","content":"fix the flaky test"}}\n');
		const omp = await isolatedOmp({ smol: "anthropic/claude-haiku-5-5:low" }, { "skills.customDirectories": [skills] });
		// The user's session has published its skills, as a top-level omp session does.
		const userSkills = (await discoverSkills(project, omp.agentDir, { customDirectories: [skills] } as never)).skills;
		setActiveSkills(userSkills);
		const options = helperOptions(
			{
				cwd: project,
				model: omp.picked!.model,
				thinkingLevel: omp.picked!.thinkingLevel,
				settings: omp.settings,
				modelRegistry: omp.modelRegistry,
			},
			"S",
			SessionManager.inMemory(project),
			REAL_SDK,
		);
		// The user's session owns omp's agent lifecycle (its adopted and parked subagents).
		const lifecycle = AgentLifecycleManager.global();
		const { session } = await createAgentSession({ ...options, agentDir: omp.agentDir });
		try {
			// The user's skill snapshot is still the user's: omp tracks it by identity.
			expect(getActiveSkills()).toBe(userSkills);
			expect(session.getAllToolNames().sort()).toEqual([...CAST_TOOLS].sort());
			for (const name of ["bash", "eval", "write", "edit", "ast_edit", "task", "browser", "github"]) {
				expect(session.getToolByName(name)).toBeUndefined();
			}
			expect(String(session.thinkingLevel)).toBe("low");
			const read = session.getToolByName("read")!;
			const text = async (target: string) => {
				const result = (await read.execute("t", { path: target } as never, AbortSignal.timeout(30_000))) as {
					content?: { text?: string }[];
				};
				return (result.content ?? []).map(block => block.text ?? "").join("");
			};
			expect(await text(log)).toContain("fix the flaky test");
			expect(await text("notes.md")).toContain("project notes");
			expect(await text("skill://tidy")).toContain("Tidy skill body");
			expect(await text("cfg://modelRoles")).toContain("claude-haiku-5-5:low");
			expect(await text("omp://")).toContain("omp://skills.md");
		} finally {
			await session.dispose();
		}
		// Disposing a cast never tears the user's lifecycle down: disposing it would make a fresh one.
		expect(AgentLifecycleManager.global()).toBe(lifecycle);
	}, 60_000);

	test("a cast's log is an omp session file in Spellbook's casts folder, never in the project's session list", async () => {
		const project = fs.mkdtempSync(path.join(root, "project-"));
		const omp = await isolatedOmp({ smol: "anthropic/claude-haiku-5-5:low" });
		const sdk: HelperSdk = {
			...REAL_SDK,
			createAgentSession: options => createAgentSession({ ...options, agentDir: omp.agentDir }),
		};
		const abort = new AbortController();
		const request: HelperRequest = {
			cwd: project,
			model: omp.picked!.model,
			thinkingLevel: omp.picked!.thinkingLevel,
			settings: omp.settings,
			modelRegistry: omp.modelRegistry,
			system: () => "THE SYSTEM PROMPT",
			description: "list files here",
			// Aborted as the session is created, so no model is ever asked.
			signal: abort.signal,
			start: { kind: "shell", sigil: "!", description: "list files here", setting: "@smol", model: "anthropic/claude-haiku-5-5", thinkingLevel: "low" },
		};
		const creating = sdk.createAgentSession;
		sdk.createAgentSession = async options => {
			const created = await creating(options);
			abort.abort("aborted: something else was sent");
			return created;
		};
		await expect(castAndLog(request, sdk, parsePromptReply)).rejects.toThrow();
		const files = fs.readdirSync(CASTS).filter(name => name.endsWith(".jsonl"));
		expect(files.length).toBeGreaterThan(0);
		const file = path.join(CASTS, files.sort().at(-1)!);
		const entries = fs
			.readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(entries.find(e => e.type === "session")).toMatchObject({ cwd: project });
		expect(entries.find(e => e.type === "session_init")).toMatchObject({
			systemPrompt: ["THE SYSTEM PROMPT"],
			task: "list files here",
			tools: [...CAST_TOOLS],
		});
		expect(entries.find(e => e.customType === CAST_ENTRY)?.data).toMatchObject({ kind: "shell", model: "anthropic/claude-haiku-5-5" });
		expect(entries.find(e => e.customType === OUTCOME_ENTRY)?.data).toMatchObject({
			outcome: "aborted",
			reason: "aborted: something else was sent",
		});
		// omp's own list for the project (what /resume shows) never holds a cast.
		const listed = await SessionManager.list(project);
		expect(listed.some(info => path.resolve(info.path).startsWith(path.resolve(CASTS)))).toBe(false);
		expect(recentCasts(CASTS)[0]).toMatchObject({ file, outcome: "aborted", description: "list files here" });
	}, 60_000);
});

describe("runHelper and castAndLog", () => {
	/** A stand-in session that replies with `messages`, and a stand-in log that records each entry. */
	function fakeSdk(messages: unknown[], options: { hold?: Promise<void>; creating?: Promise<void>; disposeThrows?: boolean } = {}) {
		const seen = {
			prompts: [] as string[],
			aborted: false,
			disposed: false,
			rules: [{ name: "RULES", content: "user rules", alwaysApply: true }] as unknown[],
			/** The system prompt each session was created with. */
			systems: [] as string[],
			/** Rules the system prompt builder saw, per cast. */
			rulesSeen: [] as unknown[][],
			entries: [] as { type: string; data?: unknown }[],
			prompting: Promise.withResolvers<void>(),
		};
		const session: HelperSession = {
			prompt: async text => {
				seen.prompts.push(text);
				seen.prompting.resolve();
				await options.hold;
			},
			abort: async () => {
				seen.aborted = true;
			},
			dispose: async () => {
				seen.disposed = true;
				if (options.disposeThrows) throw new Error("teardown failed");
			},
			messages,
		};
		const sdk: HelperSdk = {
			createAgentSession: async created => {
				seen.systems.push((created.systemPrompt as string[])[0]!);
				// omp publishes a new top-level session's rules process-wide.
				seen.rules = [{ name: "helper", content: "helper rules", alwaysApply: true }];
				await options.creating;
				return { session };
			},
			castLog: async () => ({
				appendSessionInit: init => {
					seen.entries.push({ type: "session_init", data: init });
					return "id";
				},
				appendCustomEntry: (customType, data) => {
					seen.entries.push({ type: customType, data });
					return "id";
				},
				ensureOnDisk: async () => {},
				getSessionFile: () => "cast.jsonl",
				close: async () => {},
			}),
			appendToLog: async (file, customType, data) => {
				seen.entries.push({ type: `${file} ${customType}`, data });
			},
			agentRegistry: () => ({}) as never,
			activeSkills: () => [],
			activeRules: () => seen.rules as never,
			restoreRules: rules => {
				seen.rules = rules as unknown[];
			},
		};
		return { sdk, seen };
	}
	const request = (seen: { rulesSeen: unknown[][] }, signal = new AbortController().signal): HelperRequest => ({
		cwd: root,
		model: {} as never,
		thinkingLevel: undefined,
		settings: {} as never,
		modelRegistry: { authStorage: {} } as never,
		system: rules => {
			seen.rulesSeen.push([...rules]);
			return `S: ${rules.map(rule => rule.content).join(", ")}`;
		},
		description: "list files here",
		signal,
		start: { kind: "prompt", description: "list files here", setting: "@smol", model: "test/model" },
	});
	const replied = (text: string) => [
		{ role: "user", content: [{ type: "text", text: "list files here" }] },
		{
			role: "assistant",
			content: [{ type: "toolCall", name: "read", arguments: { path: "omp://" } }],
			stopReason: "toolUse",
			usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, totalTokens: 115, cost: { total: 0.001 } },
		},
		{ role: "toolResult", content: [{ type: "text", text: "README.md" }] },
		{ role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "flaky", path: "test" } }], stopReason: "toolUse" },
		{
			role: "assistant",
			content: [{ type: "thinking", thinking: "hm" }, { type: "text", text }],
			usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 220, cost: { total: 0.002 } },
		},
	];

	test("sends the description, returns the last assistant text, lookups and usage; the session is disposed and the rules put back", async () => {
		const { sdk, seen } = fakeSdk(replied('{"text":"ls"}'));
		const result = await runHelper(request(seen), sdk);
		expect(result).toMatchObject({ reply: '{"text":"ls"}', lookups: ["read omp://", "grep flaky in test"], log: "cast.jsonl" });
		expect(result.usage).toEqual({ input: 300, output: 30, cacheRead: 5, cacheWrite: 0, totalTokens: 335, cost: 0.003 });
		expect(seen.prompts).toEqual(["list files here"]);
		expect(seen.disposed).toBe(true);
		expect(seen.rules).toEqual([{ name: "RULES", content: "user rules", alwaysApply: true }]);
	});

	test("the rules are read per cast before the session exists: a rule changed between two casts shows in the second", async () => {
		const { sdk, seen } = fakeSdk(replied('{"text":"ls"}'));
		await runHelper(request(seen), sdk);
		// The user's rules change between casts (a RULES.md edit omp picked up).
		seen.rules = [{ name: "RULES", content: "rewrite freely", alwaysApply: true }];
		await runHelper(request(seen), sdk);
		expect(seen.systems).toEqual(["S: user rules", "S: rewrite freely"]);
		// Never the helper session's own snapshot, which creating it publishes.
		expect(seen.rulesSeen.flat().some(rule => (rule as { content: string }).content === "helper rules")).toBe(false);
	});

	test("the log gets the system prompt as omp's session_init and the cast entry before the model is asked", async () => {
		const { sdk, seen } = fakeSdk(replied('{"text":"ls"}'));
		await runHelper(request(seen), sdk);
		expect(seen.entries.slice(0, 2)).toEqual([
			{
				type: "session_init",
				data: {
					systemPrompt: ["S: user rules"],
					task: "list files here",
					tools: [...CAST_TOOLS],
					agent: "spellbook",
					resolvedModel: "test/model",
					readOnly: true,
					restrictToolNames: true,
				},
			},
			{ type: CAST_ENTRY, data: { kind: "prompt", description: "list files here", setting: "@smol", model: "test/model" } },
		]);
	});

	test("an answer that lands is logged with the reply, the answer, what landed, usage and timings", async () => {
		const { sdk, seen } = fakeSdk(replied('{"text":"List the files","explain":"lists"}'));
		let now = 1000;
		const result = await castAndLog(request(seen), sdk, parsePromptReply, () => (now += 10));
		await result.settle({ outcome: "landed", landed: "List the files" });
		const outcome = seen.entries.find(entry => entry.type === `cast.jsonl ${OUTCOME_ENTRY}`)?.data;
		expect(outcome).toMatchObject({
			outcome: "landed",
			landed: "List the files",
			reply: '{"text":"List the files","explain":"lists"}',
			answer: { text: "List the files", explain: "lists" },
			lookups: ["read omp://", "grep flaky in test"],
			usage: { totalTokens: 335, cost: 0.003 },
			timings: { totalMs: 10 },
		});
		expect((outcome as { timings: { sessionMs: number; modelMs: number } }).timings).toHaveProperty("modelMs");
	});

	test("each other ending leaves its outcome: superseded, aborted, model error, unparseable reply", async () => {
		const outcomeOf = (seen: { entries: { type: string; data?: unknown }[] }) =>
			(seen.entries.find(entry => entry.type.endsWith(OUTCOME_ENTRY))?.data as { outcome: string; reason?: string; reply?: string }) ?? {};

		for (const [reason, outcome] of [
			[SUPERSEDED, "superseded"],
			["aborted: the session ended", "aborted"],
		] as const) {
			const hold = Promise.withResolvers<void>();
			const { sdk, seen } = fakeSdk([], { hold: hold.promise });
			const abort = new AbortController();
			const pending = castAndLog(request(seen, abort.signal), sdk, parsePromptReply);
			await seen.prompting.promise;
			abort.abort(reason);
			hold.resolve();
			await expect(pending).rejects.toThrow();
			expect(seen.aborted).toBe(true);
			expect(seen.disposed).toBe(true);
			expect(outcomeOf(seen)).toMatchObject({ outcome, reason });
		}

		const failed = fakeSdk([{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }]);
		await expect(castAndLog(request(failed.seen), failed.sdk, parsePromptReply)).rejects.toThrow("rate limited");
		expect(outcomeOf(failed.seen)).toMatchObject({ outcome: "model error", reason: "rate limited" });

		const garbled = fakeSdk(replied("I can't help with that."));
		await expect(castAndLog(request(garbled.seen), garbled.sdk, parsePromptReply)).rejects.toThrow(/gave no prompt/);
		expect(outcomeOf(garbled.seen)).toMatchObject({ outcome: "unparseable reply", reply: "I can't help with that." });
	});

	test("an abort while the session is being created never asks the model, and the rules are put back", async () => {
		const creating = Promise.withResolvers<void>();
		const { sdk, seen } = fakeSdk([], { creating: creating.promise });
		const abort = new AbortController();
		const pending = runHelper(request(seen, abort.signal), sdk);
		await Promise.resolve();
		await Promise.resolve();
		abort.abort();
		creating.resolve();
		await expect(pending).rejects.toThrow();
		expect(seen.prompts).toEqual([]);
		expect(seen.disposed).toBe(true);
		expect(seen.rules).toEqual([{ name: "RULES", content: "user rules", alwaysApply: true }]);
	});

	test("an abort before the session exists is logged as aborted, and no session is made", async () => {
		const { sdk, seen } = fakeSdk([]);
		const abort = new AbortController();
		abort.abort("aborted: something else was sent");
		await expect(castAndLog(request(seen, abort.signal), sdk, parsePromptReply)).rejects.toThrow();
		expect(seen.systems).toEqual([]);
		expect(seen.entries.map(entry => entry.type)).toEqual(["session_init", CAST_ENTRY, `cast.jsonl ${OUTCOME_ENTRY}`]);
		expect(seen.entries.at(-1)?.data).toMatchObject({ outcome: "aborted", reason: "aborted: something else was sent" });
		expect(seen.rules).toEqual([{ name: "RULES", content: "user rules", alwaysApply: true }]);
	});

	test("a teardown that fails keeps the reply", async () => {
		const { sdk, seen } = fakeSdk(replied('{"text":"ls"}'), { disposeThrows: true });
		expect((await runHelper(request(seen), sdk)).reply).toBe('{"text":"ls"}');
	});

	test("rules the user's session publishes mid-cast stay; the helper's own snapshot never does", async () => {
		const hold = Promise.withResolvers<void>();
		const { sdk, seen } = fakeSdk(replied('{"text":"ls"}'), { hold: hold.promise });
		const pending = runHelper(request(seen), sdk);
		await seen.prompting.promise;
		const edited = [{ name: "RULES", content: "edited mid-cast", alwaysApply: true }];
		seen.rules = edited;
		hold.resolve();
		await pending;
		expect(seen.rules).toBe(edited);
	});

	test("a model error surfaces as the error", () => {
		expect(() => lastReply([{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }])).toThrow(
			"rate limited",
		);
		expect(() => lastReply([])).toThrow("no reply");
	});

	test("a log's summary for Recent casts: what was asked, model, outcome, lookups and time", () => {
		const lines = [
			{ type: "session", timestamp: "2026-11-16T16:00:00.000Z" },
			{ type: "custom", customType: CAST_ENTRY, data: { kind: "shell", sigil: "!!", description: "disk usage", model: "a/b", thinkingLevel: "low" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "glob", arguments: { pattern: "*" } }] } },
		];
		const unfinished = summarizeCast("x.jsonl", lines.map(line => JSON.stringify(line)).join("\n"));
		expect(unfinished).toMatchObject({ kind: "shell", sigil: "!!", outcome: "unfinished", lookups: ["glob *"], totalMs: undefined });
		const done = { type: "custom", customType: OUTCOME_ENTRY, data: { outcome: "landed", landed: "!!du -sh .", lookups: ["glob *"], usage: { cost: 0.01, totalTokens: 9 }, timings: { totalMs: 4200 } } };
		expect(summarizeCast("x.jsonl", [...lines, done].map(line => JSON.stringify(line)).join("\n"))).toMatchObject({
			at: "2026-11-16T16:00:00.000Z",
			outcome: "landed",
			landed: "!!du -sh .",
			totalMs: 4200,
			cost: 0.01,
		});
		expect(summarizeCast("y.jsonl", '{"type":"session"}\n')).toBeUndefined();
	});
});
