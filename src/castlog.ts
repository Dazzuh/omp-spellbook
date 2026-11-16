/**
 * Cast logs: every cast is an omp session file in `<omp agent dir>/spellbook/casts`, a folder of
 * Spellbook's own, so casts never show in omp's session lists. omp records the conversation itself
 * (the system prompt the model got, model and thinking level, each message with its usage, cost and
 * time, each tool call and result); Spellbook adds one entry before the cast ({@link CAST_ENTRY}) and
 * one after it ({@link OUTCOME_ENTRY}). The `/spellbook` panel's Recent casts reads them back.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Custom entry written before the cast: what was asked, how, and on which model. */
export const CAST_ENTRY = "spellbook.cast";
/** Custom entry written once the cast ends: what came of it. */
export const OUTCOME_ENTRY = "spellbook.outcome";
/** Abort reason of a cast a newer cast replaced; its outcome is `superseded`, any other abort's `aborted`. */
export const SUPERSEDED = "superseded by a newer cast";

/** `<spellbook dir>/casts`: where cast logs go. */
export function castsDir(spellbookDir: string): string {
	return path.join(spellbookDir, "casts");
}

/** A new cast log's file name, as omp names its own: `<time>_<id>.jsonl`, so names sort by time. */
export function castFileName(now: Date, id: string): string {
	return `${now.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;
}

/** What the log records about a cast before it runs. */
export interface CastStart {
	/** `prompt` for `?`, `shell` for `?!`/`?!!`. */
	kind: "prompt" | "shell";
	/** `!` or `!!` for a shell cast. */
	sigil?: "!" | "!!";
	description: string;
	/** The `model` setting as configured. */
	setting: string;
	/** The model the cast runs on, `provider/id`. */
	model: string;
	thinkingLevel?: string;
	/** Why the configured model wasn't used, when it wasn't. */
	note?: string;
	/** Cast from `omp -p "/spellbook cast|prompt …"`: the answer is printed, not put in a composer. */
	headless?: boolean;
}

export type CastOutcomeKind = "landed" | "superseded" | "aborted" | "model error" | "unparseable reply";

/** Token use and cost over every model call of a cast, as omp counts them per assistant message. */
export interface CastUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

/** How long each step took, in ms; steps the cast never reached are absent. */
export interface CastTimings {
	/** Creating the cast's omp session. */
	sessionMs?: number;
	/** The model's turn, tool calls included. */
	modelMs?: number;
	/** From the cast's start to its outcome. */
	totalMs: number;
}

/** What the log records once a cast ends. */
export interface CastOutcome {
	outcome: CastOutcomeKind;
	/** The error, the abort's reason, or why the answer wasn't put in the composer. */
	reason?: string;
	/** The model's final reply, as it wrote it. */
	reply?: string;
	/** The JSON answer read from the reply. */
	answer?: unknown;
	/** The text put in the composer (or printed, headless). */
	landed?: string;
	/** Each tool call, as `<tool> <path or pattern>`. */
	lookups: string[];
	usage: CastUsage;
	timings: CastTimings;
}

/** The sum of every assistant message's usage. */
export function castUsage(messages: ReadonlyArray<unknown>): CastUsage {
	const total: CastUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	for (const message of messages as ReadonlyArray<{ role?: string; usage?: Record<string, unknown> }>) {
		const usage = message?.role === "assistant" ? message.usage : undefined;
		if (!usage) continue;
		const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
		total.input += n(usage.input);
		total.output += n(usage.output);
		total.cacheRead += n(usage.cacheRead);
		total.cacheWrite += n(usage.cacheWrite);
		total.totalTokens += n(usage.totalTokens);
		total.cost += n((usage.cost as Record<string, unknown> | undefined)?.total);
	}
	return total;
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

/** One cast as Recent casts shows it. */
export interface CastSummary {
	file: string;
	/** When the cast started (the log's header). */
	at: string;
	kind: CastStart["kind"] | undefined;
	sigil?: "!" | "!!";
	description: string;
	model: string | undefined;
	thinkingLevel: string | undefined;
	note?: string;
	/** `unfinished` when the log has no outcome (omp stopped mid-cast). */
	outcome: CastOutcomeKind | "unfinished";
	reason?: string;
	landed?: string;
	lookups: string[];
	totalMs: number | undefined;
	cost: number | undefined;
	totalTokens: number | undefined;
}

/** A cast log's summary from its JSONL text; undefined when it is not a cast log. */
export function summarizeCast(file: string, jsonl: string): CastSummary | undefined {
	let at: string | undefined;
	let start: CastStart | undefined;
	let outcome: CastOutcome | undefined;
	const messages: unknown[] = [];
	for (const line of jsonl.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let entry: { type?: string; timestamp?: string; customType?: string; data?: unknown; message?: unknown };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session") at = entry.timestamp;
		else if (entry.type === "custom" && entry.customType === CAST_ENTRY) start = entry.data as CastStart;
		else if (entry.type === "custom" && entry.customType === OUTCOME_ENTRY) outcome = entry.data as CastOutcome;
		else if (entry.type === "message" && entry.message) messages.push(entry.message);
	}
	if (!start) return undefined;
	return {
		file,
		at: at ?? "",
		kind: start.kind,
		sigil: start.sigil,
		description: start.description,
		model: start.model,
		thinkingLevel: start.thinkingLevel,
		note: start.note,
		outcome: outcome?.outcome ?? "unfinished",
		reason: outcome?.reason,
		landed: outcome?.landed,
		lookups: outcome?.lookups ?? lookups(messages),
		totalMs: outcome?.timings.totalMs,
		cost: outcome?.usage.cost,
		totalTokens: outcome?.usage.totalTokens,
	};
}

/** The newest `limit` casts in `dir`, newest first; a missing folder is no casts. */
export function recentCasts(dir: string, limit = 20): CastSummary[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter(name => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const casts: CastSummary[] = [];
	for (const name of names.sort().reverse()) {
		if (casts.length >= limit) break;
		const file = path.join(dir, name);
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const summary = summarizeCast(file, text);
		if (summary) casts.push(summary);
	}
	return casts;
}
