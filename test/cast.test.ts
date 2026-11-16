import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AgentRegistry,
	createAgentSession,
	discoverAuthStorage,
	discoverSkills,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { getActiveRules, setActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { getModelMatchPreferences, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { getActiveSkills, type Skill, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { CAST_TOOLS, type HelperSdk, type HelperSession, helperOptions, lastReply, runHelper } from "../src/helper";
import { castModel } from "../src/model";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "spellbook-cast-"));
// omp keeps its auth database open for the process, so the folder may be locked until exit (Windows).
afterAll(() => {
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {}
});

const REAL_SDK: HelperSdk = {
	createAgentSession,
	inMemorySessionManager: cwd => SessionManager.inMemory(cwd),
	agentRegistry: () => new AgentRegistry(),
	activeSkills: () => getActiveSkills() as Skill[],
	activeRules: getActiveRules,
	restoreRules: setActiveRules,
};

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
				system: "S",
			},
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
				"thinkingLevel",
				"skills",
				"toolNames",
			].sort(),
		);
		// The user's own skills, the same array: never `[]`, which would hide skill:// from the model.
		expect(options.skills).toBe(getActiveSkills() as Skill[]);
	});
});

describe("the cast session in stock omp", () => {
	test("read-only tools only; they reach the session log, omp://, skill://, cfg:// and the project; nothing is saved", async () => {
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
				system: "S",
			},
			REAL_SDK,
		);
		const { session } = await createAgentSession({ ...options, agentDir: omp.agentDir });
		try {
			// The user's skill snapshot is still the user's: omp tracks it by identity.
			expect(getActiveSkills()).toBe(userSkills);
			expect(session.getAllToolNames().sort()).toEqual([...CAST_TOOLS].sort());
			for (const name of ["bash", "eval", "write", "edit", "ast_edit", "task", "browser", "github"]) {
				expect(session.getToolByName(name)).toBeUndefined();
			}
			expect(String(session.thinkingLevel)).toBe("low");
			expect(session.sessionFile).toBeUndefined();
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
	}, 60_000);
});

describe("runHelper", () => {
	/** A stand-in session that replies with `messages` and records what it was asked. */
	function fakeSdk(messages: unknown[], hold?: Promise<void>, creating?: Promise<void>) {
		const seen = { prompts: [] as string[], aborted: false, disposed: false, rules: ["user rules"] as unknown[] };
		const session: HelperSession = {
			prompt: async text => {
				seen.prompts.push(text);
				await hold;
			},
			abort: async () => {
				seen.aborted = true;
			},
			dispose: async () => {
				seen.disposed = true;
			},
			messages,
		};
		const sdk: HelperSdk = {
			createAgentSession: async () => {
				// omp publishes a new top-level session's rules process-wide.
				seen.rules = ["helper rules"];
				await creating;
				return { session };
			},
			inMemorySessionManager: () => ({}) as never,
			agentRegistry: () => ({}) as never,
			activeSkills: () => [],
			activeRules: () => seen.rules as never,
			restoreRules: rules => {
				seen.rules = rules as unknown[];
			},
		};
		return { sdk, seen };
	}
	const request = (signal = new AbortController().signal) => ({
		cwd: root,
		model: {} as never,
		thinkingLevel: undefined,
		settings: {} as never,
		modelRegistry: { authStorage: {} } as never,
		system: "S",
		description: "list files here",
		signal,
	});

	test("sends the description as the user message and returns the last assistant text and the lookups; the session is disposed", async () => {
		const { sdk, seen } = fakeSdk([
			{ role: "user", content: [{ type: "text", text: "list files here" }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "omp://" } }], stopReason: "toolUse" },
			{ role: "toolResult", content: [{ type: "text", text: "README.md" }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "flaky" } }], stopReason: "toolUse" },
			{ role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: '{"text":"ls"}' }] },
		]);
		expect(await runHelper(request(), sdk)).toEqual({ reply: '{"text":"ls"}', lookups: ["read omp://", "grep flaky"] });
		expect(seen.prompts).toEqual(["list files here"]);
		expect(seen.disposed).toBe(true);
		expect(seen.rules).toEqual(["user rules"]);
	});

	test("an abort stops the session and rejects", async () => {
		const hold = Promise.withResolvers<void>();
		const { sdk, seen } = fakeSdk([], hold.promise);
		const abort = new AbortController();
		const pending = runHelper(request(abort.signal), sdk);
		await Promise.resolve();
		await Promise.resolve();
		abort.abort();
		hold.resolve();
		await expect(pending).rejects.toThrow();
		expect(seen.aborted).toBe(true);
		expect(seen.disposed).toBe(true);
	});

	test("an abort while the session is being created never asks the model", async () => {
		const creating = Promise.withResolvers<void>();
		const { sdk, seen } = fakeSdk([], undefined, creating.promise);
		const abort = new AbortController();
		const pending = runHelper(request(abort.signal), sdk);
		abort.abort();
		creating.resolve();
		await expect(pending).rejects.toThrow();
		expect(seen.prompts).toEqual([]);
		expect(seen.disposed).toBe(true);
		expect(seen.rules).toEqual(["user rules"]);
	});

	test("a model error surfaces as the error", () => {
		expect(() => lastReply([{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }])).toThrow(
			"rate limited",
		);
		expect(() => lastReply([])).toThrow("no reply");
	});
});
