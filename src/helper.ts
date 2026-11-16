/**
 * One cast: an omp session with Spellbook's system prompt and omp's read, grep and glob tools only,
 * run as its model is configured. It answers the description and is thrown away: its session file
 * stays as the cast's log (see `castlog.ts`), and omp's process-wide skill and rule snapshots are
 * the user's again when it ends.
 */
import type { CreateAgentSessionOptions, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import {
	CAST_ENTRY,
	type CastOutcome,
	type CastStart,
	type CastUsage,
	castUsage,
	lookups,
	OUTCOME_ENTRY,
	SUPERSEDED,
} from "./castlog";

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
	/** The system prompt, built from omp's rule snapshot as it stands before the cast's session exists. */
	system(rules: readonly Rule[]): string;
	/** The user's description, sent as the user message. */
	description: string;
	signal: AbortSignal;
	/** What the cast's log records before it runs. */
	start: CastStart;
}

/** The slice of omp's `SessionManager` a cast log is written through before the cast's session takes it over. */
export type CastLogWriter = Pick<
	SessionManager,
	"appendSessionInit" | "appendCustomEntry" | "ensureOnDisk" | "getSessionFile" | "close"
>;

/** The slice of omp's SDK a cast uses; the real one is `createAgentSession`, `SessionManager` and omp's skill and rule snapshots. */
export interface HelperSdk {
	createAgentSession(options: CreateAgentSessionOptions): Promise<{ session: HelperSession }>;
	/** A new cast log for a cast in `cwd`: an omp session file in Spellbook's casts folder. */
	castLog(cwd: string): Promise<CastLogWriter>;
	/** Append one custom entry to a finished cast's log (its session has closed it). */
	appendToLog(file: string, customType: string, data: unknown): Promise<void>;
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
export function helperOptions(
	request: Omit<HelperRequest, "system" | "description" | "signal" | "start">,
	system: string,
	sessionManager: NonNullable<CreateAgentSessionOptions["sessionManager"]>,
	sdk: HelperSdk,
): CreateAgentSessionOptions {
	return {
		cwd: request.cwd,
		settings: request.settings,
		modelRegistry: request.modelRegistry,
		authStorage: request.modelRegistry.authStorage,
		model: request.model,
		thinkingLevel: request.thinkingLevel,
		systemPrompt: [system],
		toolNames: [...CAST_TOOLS],
		restrictToolNames: true,
		// The cast's log: a session file in Spellbook's own folder, never beside the user's sessions.
		sessionManager,
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
		// A sub-agent to omp: disposing a top-level ("main") session tears down omp's process-wide
		// agent lifecycle, which holds the user's adopted and parked subagents.
		taskDepth: 1,
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

/** What a cast's run left behind, success or not. */
export interface HelperTrace {
	/** The cast's log file; undefined when it couldn't be written. */
	log: string | undefined;
	lookups: string[];
	usage: CastUsage;
	sessionMs?: number;
	modelMs?: number;
}

/** A cast that ended without a reply: the abort or error, and what it did before. */
export class CastFailed extends Error {
	constructor(
		readonly cause: unknown,
		readonly trace: HelperTrace,
	) {
		super(cause instanceof Error ? cause.message : String(cause));
	}
}

/**
 * Run one cast: the model's final reply text and its trace. Before anything else, omp's rule snapshot
 * is read for the system prompt; creating the cast's session overwrites that snapshot, and it is put
 * back when the cast ends unless something newer replaced it meanwhile. The log records the system
 * prompt (omp's `session_init`) and {@link CAST_ENTRY} before the model is asked, so an abort from
 * then on is logged too; omp records the rest. Throws {@link CastFailed}.
 */
export async function runHelper(request: HelperRequest, sdk: HelperSdk): Promise<HelperTrace & { reply: string }> {
	const rules = sdk.activeRules();
	const trace: HelperTrace = { log: undefined, lookups: [], usage: castUsage([]) };
	/** The helper session's own rule snapshot, which creating it published. */
	let published: unknown;
	try {
		const system = request.system(rules);
		const log = await sdk.castLog(request.cwd);
		try {
			log.appendSessionInit({
				systemPrompt: [system],
				task: request.description,
				tools: [...CAST_TOOLS],
				agent: "spellbook",
				resolvedModel: request.start.model,
				readOnly: true,
				restrictToolNames: true,
			});
			log.appendCustomEntry(CAST_ENTRY, request.start);
			// On disk now, so a cast that ends before the model answers still leaves its log.
			await log.ensureOnDisk();
		} catch (error) {
			await log.close().catch(() => {});
			throw error;
		}
		trace.log = log.getSessionFile();
		const creating = Date.now();
		let session: HelperSession;
		try {
			// Aborted before the session exists (say, while the settings were read): logged, never created.
			request.signal.throwIfAborted();
			({ session } = await sdk.createAgentSession(
				helperOptions(request, system, log as NonNullable<CreateAgentSessionOptions["sessionManager"]>, sdk),
			));
		} catch (error) {
			await log.close().catch(() => {});
			throw error;
		}
		published = sdk.activeRules();
		trace.sessionMs = Date.now() - creating;
		const onAbort = () => {
			session.abort().catch(() => {});
		};
		request.signal.addEventListener("abort", onAbort, { once: true });
		let asking: number | undefined;
		let reply: string;
		try {
			// An abort while the session was being created stops it before it asks the model.
			request.signal.throwIfAborted();
			asking = Date.now();
			await session.prompt(request.description, { expandPromptTemplates: false });
			request.signal.throwIfAborted();
			reply = lastReply(session.messages);
		} finally {
			if (asking !== undefined) trace.modelMs = Date.now() - asking;
			trace.lookups = lookups(session.messages);
			trace.usage = castUsage(session.messages);
			request.signal.removeEventListener("abort", onAbort);
			// Closes the log too: the outcome is appended with `appendToLog`. A teardown that fails
			// never costs the reply.
			await session.dispose().catch(() => {});
		}
		return { ...trace, reply };
	} catch (error) {
		throw new CastFailed(request.signal.aborted ? (request.signal.reason ?? error) : error, trace);
	} finally {
		// The user's session may have published newer rules mid-cast (a RULES.md edit); those stay.
		if (published === undefined || sdk.activeRules() === published) sdk.restoreRules(rules);
	}
}

/** How a cast that answered ended: what landed, or why nothing did. */
export type CastSettle =
	| { outcome: "landed"; landed: string }
	| { outcome: "superseded" | "aborted"; reason: string };

/**
 * One cast, logged from start to end: runs it, reads the answer with `parse`, and records the outcome
 * in its log. A model error, an abort (`superseded` when its reason is {@link SUPERSEDED}) or a reply
 * with no answer is recorded and thrown; an answer returns with `settle`, which records what became of
 * it. A log that can't be finished never costs the cast.
 */
export async function castAndLog<A>(
	request: HelperRequest,
	sdk: HelperSdk,
	parse: (reply: string) => A | undefined,
	clock: () => number = Date.now,
): Promise<{ answer: A; lookups: string[]; log: string | undefined; settle(settled: CastSettle): Promise<void> }> {
	const startedAt = clock();
	const finish = (trace: HelperTrace, outcome: Omit<CastOutcome, "lookups" | "usage" | "timings">) => {
		if (!trace.log) return Promise.resolve();
		const data: CastOutcome = {
			...outcome,
			lookups: trace.lookups,
			usage: trace.usage,
			timings: { sessionMs: trace.sessionMs, modelMs: trace.modelMs, totalMs: clock() - startedAt },
		};
		return sdk.appendToLog(trace.log, OUTCOME_ENTRY, data).catch(() => {});
	};
	let result: HelperTrace & { reply: string };
	try {
		result = await runHelper(request, sdk);
	} catch (error) {
		if (!(error instanceof CastFailed)) throw error;
		const { signal } = request;
		const outcome = !signal.aborted ? "model error" : signal.reason === SUPERSEDED ? "superseded" : "aborted";
		await finish(error.trace, { outcome, reason: error.message });
		throw error.cause instanceof Error ? error.cause : error;
	}
	const answer = parse(result.reply);
	if (answer === undefined) {
		await finish(result, { outcome: "unparseable reply", reply: result.reply });
		throw new Error(
			`${request.start.model} gave no ${request.start.kind === "prompt" ? "prompt" : "command"}; its reply is in the cast log`,
		);
	}
	return {
		answer,
		lookups: result.lookups,
		log: result.log,
		settle: settled => finish(result, { ...settled, reply: result.reply, answer }),
	};
}
