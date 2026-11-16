/**
 * One cast: an in-process omp session with Spellbook's system prompt and omp's read, grep and glob
 * tools only, run as its model is configured. It answers the description and is thrown away: its
 * session stays in memory, and omp's process-wide skill and rule snapshots are the user's again
 * when it ends.
 */
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";

/**
 * The tools a cast may use: omp's `read` (files, and omp's internal URLs such as `omp://`,
 * `skill://`, `cfg://`), `grep` and `glob`. No edit, write, bash, eval or task tool.
 */
export const CAST_TOOLS = ["read", "grep", "glob"] as const;

export interface HelperRequest {
	cwd: string;
	model: NonNullable<CreateAgentSessionOptions["model"]>;
	thinkingLevel: CreateAgentSessionOptions["thinkingLevel"];
	settings: NonNullable<CreateAgentSessionOptions["settings"]>;
	modelRegistry: NonNullable<CreateAgentSessionOptions["modelRegistry"]>;
	system: string;
	/** The user's description, sent as the user message. */
	description: string;
	signal: AbortSignal;
}

/** The slice of omp's SDK a cast uses; the real one is `createAgentSession`, `SessionManager.inMemory` and omp's skill and rule snapshots. */
export interface HelperSdk {
	createAgentSession(options: CreateAgentSessionOptions): Promise<{ session: HelperSession }>;
	inMemorySessionManager(cwd: string): NonNullable<CreateAgentSessionOptions["sessionManager"]>;
	agentRegistry(): NonNullable<CreateAgentSessionOptions["agentRegistry"]>;
	/** The user's session's skills (omp's process-wide snapshot `skill://` reads). */
	activeSkills(): NonNullable<CreateAgentSessionOptions["skills"]>;
	/** omp's process-wide rule snapshot, read before a cast and put back after it: a new top-level session overwrites it. */
	activeRules(): readonly Rule[];
	restoreRules(rules: readonly Rule[]): void;
}

/** The slice of omp's `AgentSession` a cast uses. */
export interface HelperSession {
	prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<unknown>;
	abort(): Promise<unknown>;
	dispose(): Promise<unknown>;
	readonly messages: ReadonlyArray<unknown>;
}

/** The options a cast's session is created with. */
export function helperOptions(request: Omit<HelperRequest, "description" | "signal">, sdk: HelperSdk): CreateAgentSessionOptions {
	return {
		cwd: request.cwd,
		settings: request.settings,
		modelRegistry: request.modelRegistry,
		authStorage: request.modelRegistry.authStorage,
		model: request.model,
		thinkingLevel: request.thinkingLevel,
		systemPrompt: [request.system],
		toolNames: [...CAST_TOOLS],
		restrictToolNames: true,
		// Kept in memory: a saved session would leave a file beside the user's own for every cast.
		sessionManager: sdk.inMemorySessionManager(request.cwd),
		// The user's own skills: omp publishes a new session's skills process-wide, so this keeps the
		// user's snapshot in place, and skill:// resolves the user's skills.
		skills: sdk.activeSkills(),
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		hasUI: false,
		cacheWarming: false,
		// A helper for the user's session: that session keeps the process-wide state and its agent id.
		bindProcessState: false,
		agentRegistry: sdk.agentRegistry(),
		agentId: "Spellbook",
		agentDisplayName: "spellbook",
	};
}

/** The text of the last assistant message, or throws its error. */
export function lastReply(messages: ReadonlyArray<unknown>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as {
			role?: string;
			content?: ReadonlyArray<{ type: string; text?: string }>;
			stopReason?: string;
			errorMessage?: string;
		};
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage || `model request ${message.stopReason}`);
		}
		return (message.content ?? [])
			.filter(block => block.type === "text" && typeof block.text === "string")
			.map(block => block.text)
			.join("");
	}
	throw new Error("the model gave no reply");
}

/** What the model looked up during a cast, in order: each tool call as `<tool> <path or pattern>`. */
export function lookups(messages: ReadonlyArray<unknown>): string[] {
	const calls: string[] = [];
	for (const message of messages as ReadonlyArray<{ role?: string; content?: unknown }>) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as ReadonlyArray<{ type?: string; name?: string; arguments?: Record<string, unknown> }>) {
			if (block.type !== "toolCall") continue;
			const target = block.arguments?.path ?? block.arguments?.pattern ?? JSON.stringify(block.arguments ?? {});
			calls.push(`${block.name} ${String(target)}`);
		}
	}
	return calls;
}

/** Run one cast: the model's final reply text and what it looked up on the way. */
export async function runHelper(request: HelperRequest, sdk: HelperSdk): Promise<{ reply: string; lookups: string[] }> {
	request.signal.throwIfAborted();
	const rules = sdk.activeRules();
	try {
		const { session } = await sdk.createAgentSession(helperOptions(request, sdk));
		const onAbort = () => {
			session.abort().catch(() => {});
		};
		request.signal.addEventListener("abort", onAbort, { once: true });
		try {
			// An abort while the session was being created stops it before it asks the model.
			request.signal.throwIfAborted();
			await session.prompt(request.description, { expandPromptTemplates: false });
			request.signal.throwIfAborted();
			return { reply: lastReply(session.messages), lookups: lookups(session.messages) };
		} finally {
			request.signal.removeEventListener("abort", onAbort);
			await session.dispose();
		}
	} finally {
		sdk.restoreRules(rules);
	}
}
