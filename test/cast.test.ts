import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AgentRegistry,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { CAST_TOOLS, type HelperSdk, type HelperSession, helperOptions, lastReply, runHelper } from "../src/helper";
import { pickModel } from "../src/model";

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
};

/** An isolated omp: its own agent folder, settings with the given roles, and every built-in model (no credentials needed). */
async function isolatedOmp(roles: Record<string, string>, extra: Record<string, unknown> = {}) {
	const agentDir = fs.mkdtempSync(path.join(root, "agent-"));
	const settings = Settings.isolated({ modelRoles: roles, ...extra });
	const modelRegistry = new ModelRegistry(await discoverAuthStorage(agentDir, { settings }));
	const models = modelRegistry.getAll();
	const picked = pickModel({
		role: list => resolveRoleSelection(list, settings, models),
		session: () => undefined,
	});
	return { agentDir, settings, modelRegistry, picked };
}

describe("the cast model runs as its role is configured", () => {
	test("role spellbook with its thinking level, else smol with its own, else the session's model and level", async () => {
		const both = await isolatedOmp({ spellbook: "anthropic/claude-haiku-5-5:low", smol: "anthropic/claude-opus-5-5:high" });
		expect(both.picked).toMatchObject({ via: "spellbook", thinkingLevel: "low", model: { id: "claude-haiku-5-5" } });
		const smol = await isolatedOmp({ smol: "anthropic/claude-opus-5-5:high" });
		expect(smol.picked).toMatchObject({ via: "smol", thinkingLevel: "high", model: { id: "claude-opus-5-5" } });
		const session = pickModel({ role: () => undefined, session: () => ({ model: "opus", thinkingLevel: "medium" }) });
		expect(session).toEqual({ model: "opus", thinkingLevel: "medium", via: "session" });
		expect(pickModel({ role: () => undefined, session: () => undefined })).toBeUndefined();
	});

	test("the helper session gets the model and thinking level and no other model knob", async () => {
		const omp = await isolatedOmp({ spellbook: "anthropic/claude-haiku-5-5:low" });
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
				"toolNames",
			].sort(),
		);
		// Skills stay discovered: `skills: []` would hide skill:// from the model.
		expect("skills" in options).toBe(false);
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
		const omp = await isolatedOmp({ spellbook: "anthropic/claude-haiku-5-5:low" }, { "skills.customDirectories": [skills] });
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
	function fakeSdk(messages: unknown[], hold?: Promise<void>) {
		const seen = { prompts: [] as string[], aborted: false, disposed: false, options: undefined as unknown };
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
			createAgentSession: async options => {
				seen.options = options;
				return { session };
			},
			inMemorySessionManager: () => ({}) as never,
			agentRegistry: () => ({}) as never,
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

	test("a model error surfaces as the error", () => {
		expect(() => lastReply([{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }])).toThrow(
			"rate limited",
		);
		expect(() => lastReply([])).toThrow("no reply");
	});
});
