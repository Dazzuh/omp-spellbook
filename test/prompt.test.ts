import { describe, expect, test } from "bun:test";
import type { ShellInfo } from "../src/platform";
import { parsePromptReply, parseShellReply, promptSystemPrompt, shellSystemPrompt } from "../src/prompt";

const GIT_BASH: ShellInfo = {
	platform: "win32",
	shell: "C:\\Program Files\\Git\\bin\\bash.exe",
	family: "bash",
	notes: ["omp's embedded shell has these built in on every OS: ls, find."],
};
const PLACES = { sessionLog: "C:/Users/u/.omp/agent/sessions/x/1.jsonl", cwd: "C:/work/project" };

describe("system prompts", () => {
	test("both name every place the model can look: the session log, omp://, skill://, cfg:// and the project", () => {
		for (const system of [promptSystemPrompt(PLACES), shellSystemPrompt(PLACES, GIT_BASH, "Windows 10.0.26200")]) {
			expect(system).toContain(PLACES.sessionLog);
			expect(system).toContain("omp://");
			expect(system).toContain("skill://");
			expect(system).toContain("cfg://");
			expect(system).toContain(PLACES.cwd);
		}
	});

	test("a session without a log file leaves the log line out", () => {
		expect(promptSystemPrompt({ sessionLog: undefined, cwd: "/p" })).not.toContain("JSONL");
	});

	test("? asks for the text and its explanation; ?! adds the destructive flag and says where the line runs", () => {
		expect(promptSystemPrompt(PLACES)).toContain('{"text": "<the prompt>", "explain":');
		expect(promptSystemPrompt(PLACES)).not.toContain("destructive");
		const shell = shellSystemPrompt(PLACES, GIT_BASH, "Windows 10.0.26200");
		expect(shell).toContain('{"text": "<the command>", "explain":');
		expect(shell).toContain('"destructive":');
		expect(shell).toContain("It runs in bash (C:\\Program Files\\Git\\bin\\bash.exe) on Windows 10.0.26200");
		expect(shell).toContain(GIT_BASH.notes[0]!);
	});
});

describe("the reply envelope", () => {
	test("text lands exactly as the model wrote it: spaces, newlines, backticks, `$` and `!` kept", () => {
		const text = "  $ !ls `pwd`\n  && echo done  ";
		const reply = JSON.stringify({ text, explain: "Lists.", destructive: false });
		expect(parseShellReply(reply)).toEqual({ text, explain: "Lists.", destructive: false });
		expect(parsePromptReply(reply)).toEqual({ text, explain: "Lists." });
	});

	test("the envelope is found in a fence or with words around it", () => {
		const json = '{"text":"Review src/ with skill://reviewer. orchestrate","explain":"Asks for a review."}';
		for (const reply of [json, `\`\`\`json\n${json}\n\`\`\``, `Here it is:\n${json}\nDone.`]) {
			expect(parsePromptReply(reply)).toEqual({
				text: "Review src/ with skill://reviewer. orchestrate",
				explain: "Asks for a review.",
			});
		}
	});

	test("only the model's own true marks a command destructive", () => {
		expect(parseShellReply('{"text":"rm x","destructive":true}')?.destructive).toBe(true);
		expect(parseShellReply('{"text":"rm x","destructive":"yes"}')?.destructive).toBe(false);
		expect(parseShellReply('{"text":"rm x"}')).toEqual({ text: "rm x", explain: "", destructive: false });
	});

	test("no text, no answer: nothing is guessed from a reply without the envelope", () => {
		for (const reply of ["", "ls -la", '{"text":""}', '{"text":"  "}', '{"command":"ls"}', "[1]"]) {
			expect(parsePromptReply(reply)).toBeUndefined();
			expect(parseShellReply(reply)).toBeUndefined();
		}
	});
});
