import type { ShellInfo } from "./platform";

/** Where the model can look things up with its read-only tools. */
export interface LookupPlaces {
	/** The live omp session's log (JSONL), when the session has one. */
	sessionLog: string | undefined;
	/** The project folder omp runs in. */
	cwd: string;
}

/** The model's reply for `?`: the prompt to land and what sending it does. */
export interface PromptAnswer {
	text: string;
	explain: string;
}

/** The model's reply for `?!`/`?!!`: the command to land, what it does, and the model's destructive flag. */
export interface CastAnswer extends PromptAnswer {
	destructive: boolean;
}

function lookupLines(places: LookupPlaces): string[] {
	return [
		"You can look things up before you answer, with the read, grep and glob tools:",
		...(places.sessionLog ? [`- the user's conversation with omp so far, a JSONL log: ${places.sessionLog}`] : []),
		"- omp's documentation: omp:// lists the pages, omp://<page> reads one",
		"- the user's skills: skill://<name>",
		"- omp's settings and their current values: cfg://, or cfg://<key>",
		`- the project: ${places.cwd}`,
	];
}

/** System prompt for `?`: write the prompt the user will send to omp's agent. */
export function promptSystemPrompt(places: LookupPlaces): string {
	return [
		"You are Spellbook, inside omp, a coding agent in the terminal. The user describes in plain words what they want omp's agent to do. Write the prompt they will send to omp's agent for it, using omp's docs, skills and magic keywords where they help. It lands in their composer; they read it and send it themselves.",
		"",
		...lookupLines(places),
		"",
		'Reply with JSON only: {"text": "<the prompt>", "explain": "<what sending it does, for the user>"}',
	].join("\n");
}

/** System prompt for `?!`/`?!!`: write the shell command for omp's `!` line. */
export function shellSystemPrompt(places: LookupPlaces, shell: ShellInfo, os: string): string {
	const name = shell.family === "sh" ? "POSIX sh" : shell.family;
	return [
		"You are Spellbook, inside omp, a coding agent in the terminal. The user describes in plain words a shell command they want. Write it. It lands in their composer after omp's `!`; they read it and run it themselves.",
		`It runs in ${name} (${shell.shell}) on ${os}, in ${places.cwd}.`,
		...shell.notes,
		"",
		...lookupLines(places),
		"",
		'Reply with JSON only: {"text": "<the command>", "explain": "<what it does, for the user>", "destructive": <true if it deletes, overwrites or stops anything, else false>}',
	].join("\n");
}

/** The JSON object in a reply: the whole reply, a fenced block, or the span from the first `{` to the last `}`. */
function envelope(reply: string): Record<string, unknown> | undefined {
	const candidates = [reply.trim()];
	const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
	if (fence) candidates.push(fence[1]!.trim());
	const first = reply.indexOf("{");
	const last = reply.lastIndexOf("}");
	if (first !== -1 && last > first) candidates.push(reply.slice(first, last + 1));
	for (const candidate of candidates) {
		try {
			const value: unknown = JSON.parse(candidate);
			if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
		} catch {}
	}
	return undefined;
}

/** The `?` answer in a reply; `text` exactly as the model wrote it. Undefined when the reply has none. */
export function parsePromptReply(reply: string): PromptAnswer | undefined {
	const value = envelope(reply);
	if (typeof value?.text !== "string" || !value.text.trim()) return undefined;
	return { text: value.text, explain: typeof value.explain === "string" ? value.explain : "" };
}

/** The `?!` answer in a reply; `text` exactly as the model wrote it. Undefined when the reply has none. */
export function parseShellReply(reply: string): CastAnswer | undefined {
	const answer = parsePromptReply(reply);
	if (!answer) return undefined;
	return { ...answer, destructive: envelope(reply)?.destructive === true };
}
