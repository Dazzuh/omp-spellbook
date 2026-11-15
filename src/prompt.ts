import type { ShellInfo } from "./platform";

/** Everything the model sees: never the conversation, only this packet. */
export interface ContextPacket {
	description: string;
	cwd: string;
	os: string;
	shell: ShellInfo;
	sshHosts: string[];
	recentCommands: string[];
	/** Saved spells close to the description, as `words → command`. */
	spells: { words: string; command: string }[];
}

export interface CastAnswer {
	command: string;
	/** One plain-words line saying what the command does. */
	explain: string;
	/** The model's own flag for data-destroying commands. */
	destructive: boolean;
}

/** The whole request (system prompt + user message), in UTF-8 bytes. */
export const REQUEST_BUDGET = 4000;

/** Per-field caps, in UTF-8 bytes; when the request is still over budget, the lists shrink. */
export const LIMITS = {
	description: 500,
	cwd: 200,
	/** The whole SSH alias list. */
	sshHosts: 300,
	recentCommands: 5,
	recentCommand: 120,
	spells: 4,
	spellWords: 80,
	spellCommand: 120,
} as const;

/** Cut to `maxBytes` of UTF-8 on a code-point boundary, marking the cut with an ellipsis. */
function clip(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let out = "";
	let used = Buffer.byteLength("…");
	for (const char of text) {
		const size = Buffer.byteLength(char);
		if (used + size > maxBytes) break;
		out += char;
		used += size;
	}
	return `${out}…`;
}

export function buildSystemPrompt(shell: ShellInfo): string {
	const name = shell.family === "sh" ? "POSIX sh" : shell.family;
	const system = shell.platform === "win32" ? "Windows" : shell.platform === "darwin" ? "macOS" : shell.platform;
	return [
		"You turn a plain-language description into ONE shell command line for the user's terminal.",
		`The line runs in ${name} on ${system}. Write ${name} syntax; never PowerShell or cmd.exe syntax at the top level.`,
		"Prefer tools that ship with that system. Prefer read-only, safe forms; never add sudo unless the description asks for elevated rights.",
		"Use the context (cwd, SSH host aliases, recent commands, the user's saved commands) to pick real names; never invent hosts or paths.",
		"If the description cannot be one command line, chain with && or a pipe; keep it on one line.",
		'Reply with JSON only, no code fence: {"command": "<the command line>", "explain": "<one short plain-words sentence, what it does>", "destructive": <true if it deletes, overwrites or stops anything, else false>}',
	].join("\n");
}

/**
 * The user message: the context packet, every field capped, plus the description. When the
 * request would pass {@link REQUEST_BUDGET}, the oldest recent commands go first, then saved
 * spells, then SSH aliases.
 */
export function buildUserMessage(packet: ContextPacket): string {
	const head = [`OS: ${clip(packet.os, 200)}`, `Shell: ${clip(packet.shell.shell, 200)}`];
	for (const note of packet.shell.notes) head.push(`Note: ${note}`);
	head.push(`cwd: ${clip(packet.cwd, LIMITS.cwd)}`);
	let hosts = "";
	for (const host of packet.sshHosts) {
		const next = hosts ? `${hosts}, ${host}` : host;
		if (Buffer.byteLength(next) > LIMITS.sshHosts) break;
		hosts = next;
	}
	const recent = packet.recentCommands
		.slice(-LIMITS.recentCommands)
		.map(command => `  ${clip(command.replace(/\s+/g, " "), LIMITS.recentCommand)}`);
	const spells = packet.spells
		.slice(0, LIMITS.spells)
		.map(
			spell =>
				`  ${clip(spell.words.replace(/\s+/g, " "), LIMITS.spellWords)} → ${clip(spell.command.replace(/\s+/g, " "), LIMITS.spellCommand)}`,
		);
	const tail = ["", `Description: ${clip(packet.description.replace(/\s+/g, " ").trim(), LIMITS.description)}`];
	const room = REQUEST_BUDGET - Buffer.byteLength(buildSystemPrompt(packet.shell));
	const assemble = (): string => {
		const lines = [...head];
		if (hosts) lines.push(`SSH host aliases: ${hosts}`);
		if (recent.length > 0) lines.push("Recent ! commands (oldest first):", ...recent);
		if (spells.length > 0) lines.push("Saved commands for similar words:", ...spells);
		return [...lines, ...tail].join("\n");
	};
	let message = assemble();
	while (Buffer.byteLength(message) > room && (recent.length > 0 || spells.length > 0 || hosts)) {
		if (recent.length > 0) recent.shift();
		else if (spells.length > 0) spells.pop();
		else hosts = "";
		message = assemble();
	}
	return message;
}

/** Pull the answer out of the model's reply: JSON (fenced or not), else the first code line. */
export function parseAnswer(reply: string): CastAnswer | undefined {
	const text = reply.trim();
	const candidates: string[] = [];
	const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fence) candidates.push(fence[1]!.trim());
	const brace = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (brace !== -1 && last > brace) candidates.push(text.slice(brace, last + 1));
	for (const candidate of candidates) {
		try {
			const value = JSON.parse(candidate) as Partial<Record<keyof CastAnswer, unknown>>;
			if (typeof value.command !== "string" || !value.command.trim()) continue;
			return {
				command: cleanCommand(value.command),
				explain: typeof value.explain === "string" ? value.explain.trim().replace(/\s+/g, " ") : "",
				destructive: value.destructive === true,
			};
		} catch {}
	}
	// No JSON: take the first non-empty line, minus a code fence or prompt marker.
	const line = text
		.replace(/```\w*/g, "")
		.split(/\r?\n/)
		.map(l => l.trim())
		.find(Boolean);
	if (!line || line.startsWith("{")) return undefined;
	return { command: cleanCommand(line), explain: "", destructive: false };
}

/** The command without a leading `$ `, `!` or backticks around it; a multi-line command keeps its lines. */
function cleanCommand(command: string): string {
	let out = command.replace(/\r\n?/g, "\n").trim();
	out = out.replace(/^`+|`+$/g, "").trim();
	out = out.replace(/^(\$|!!?)\s*/, "");
	return out;
}
