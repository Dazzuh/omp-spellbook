import { describe, expect, test } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { ShellInfo } from "../src/platform";
import {
	parsePromptReply,
	parseShellReply,
	promptSystemPrompt,
	RULES_FRAMING,
	shellSystemPrompt,
	writerRules,
} from "../src/prompt";

const GIT_BASH: ShellInfo = {
	platform: "win32",
	shell: "C:\\Program Files\\Git\\bin\\bash.exe",
	family: "bash",
	notes: ["omp's embedded shell has these built in on every OS: ls, find."],
};
const PLACES = {
	sessionLog: "C:/Users/u/.omp/agent/sessions/x/1.jsonl",
	cwd: "C:/work/project",
	skillFolders: ["C:/Users/u/.agents/skills", "C:/work/agent-kit/skills"],
};

describe("system prompts", () => {
	test("both name every place the model can look: the session log, omp://, skill://, cfg:// and the project", () => {
		for (const system of [promptSystemPrompt(PLACES), shellSystemPrompt(PLACES, GIT_BASH, "Windows 10.0.26200")]) {
			expect(system).toContain(PLACES.sessionLog);
			expect(system).toContain("omp://");
			expect(system).toContain("skill://");
			expect(system).toContain("cfg://");
			expect(system).toContain(PLACES.cwd);
			// Where the skills are, never which: the model lists and reads them itself.
			expect(system).toContain("C:/Users/u/.agents/skills, C:/work/agent-kit/skills");
		}
	});

	test("a session without a log file or skills leaves those lines' paths out", () => {
		const system = promptSystemPrompt({ sessionLog: undefined, cwd: "/p", skillFolders: [] });
		expect(system).not.toContain("JSONL");
		expect(system).toContain("- the user's skills: skill://<name> reads one\n");
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

describe("the user's rules in the ? system prompt", () => {
	const rule = (name: string, content: string, extra: Partial<Rule> = {}): Rule => ({
		name,
		path: `/rules/${name}.md`,
		content,
		_source: {} as never,
		...extra,
	});
	// The user's RULES.md as omp holds it: frontmatter stripped, the rest untouched (here with odd spacing and markup).
	const USER = rule("RULES", "# Existing code\nExisting code is reference, not a base:\n  agents rewrite cheaply.\n\n<b>keep</b> `this` $HOME\n", {
		alwaysApply: true,
	});
	const PROJECT = rule("RULES", "Use bun, never npm.", { alwaysApply: true });
	const SNAPSHOT: Rule[] = [
		USER,
		// A rulebook rule the agent reads on request, never always applied.
		rule("style", "Prefer tabs.", { description: "style guide" }),
		// TTSR rules fire mid-stream on a match; a judged rule on a judge's yes.
		rule("no-any", "Never use any.", { alwaysApply: true, condition: ["\\bany\\b"] }),
		rule("ast", "No console.log.", { alwaysApply: true, astCondition: ["console.log($A)"] }),
		rule("judged", "Say sorry.", { alwaysApply: true, question: "Was the user upset?" }),
		// Scoped to subagents only, so not the main agent's.
		rule("subs", "Report to the parent.", { alwaysApply: true, agents: ["sub", "task"] }),
		rule("main-only", "Ask before pushing.", { alwaysApply: true, agents: ["main"] }),
		PROJECT,
	];

	test("only rules that always apply to the main agent, with no stream condition or question, reach the writer", () => {
		expect(writerRules(SNAPSHOT).map(r => r.content)).toEqual([USER.content, "Ask before pushing.", PROJECT.content]);
	});

	test("each rule follows the framing line word for word; the rest of the prompt is unchanged", () => {
		const system = promptSystemPrompt(PLACES, writerRules(SNAPSHOT));
		expect(system).toContain(`${RULES_FRAMING}\n`);
		for (const r of writerRules(SNAPSHOT)) expect(system).toContain(`\n${r.content}\n`);
		for (const absent of ["Prefer tabs.", "Never use any.", "No console.log.", "Say sorry.", "Report to the parent."]) {
			expect(system).not.toContain(absent);
		}
		expect(system.indexOf(RULES_FRAMING)).toBeLessThan(system.indexOf(USER.content));
		// Without the rules block, the prompt is the one with no rules.
		const block = system.slice(system.indexOf(RULES_FRAMING), system.indexOf("Reply with JSON only"));
		expect(system.replace(block, "")).toBe(promptSystemPrompt(PLACES));
	});

	test("with no rules the ? prompt is exactly 0.3 run 1's; ?! never gets rules", () => {
		expect(promptSystemPrompt(PLACES, [])).toBe(
			[
				"You are Spellbook, inside omp, a coding agent in the terminal. The user describes in plain words what they want omp's agent to do. Write the prompt they will send to omp's agent for it, using omp's docs, skills and magic keywords where they help. It lands in their composer; they read it and send it themselves.",
				"",
				"You can look things up before you answer, with the read, grep and glob tools:",
				"- the user's conversation with omp so far, a JSONL log: C:/Users/u/.omp/agent/sessions/x/1.jsonl",
				"- omp's documentation: omp:// lists the pages, omp://<page> reads one",
				"- the user's skills: skill://<name> reads one; each is a folder with a SKILL.md in C:/Users/u/.agents/skills, C:/work/agent-kit/skills",
				"- omp's settings and their current values: cfg://, or cfg://<key>",
				"- the project: C:/work/project",
				"",
				'Reply with JSON only: {"text": "<the prompt>", "explain": "<what sending it does, for the user>"}',
			].join("\n"),
		);
		expect(promptSystemPrompt(PLACES, writerRules([]))).toBe(promptSystemPrompt(PLACES));
		expect(shellSystemPrompt(PLACES, GIT_BASH, "Windows 10.0.26200")).not.toContain(RULES_FRAMING);
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
