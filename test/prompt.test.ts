import { describe, expect, test } from "bun:test";
import { pickModel, replyText } from "../src/model";
import type { ShellInfo } from "../src/platform";
import { buildSystemPrompt, buildUserMessage, type ContextPacket, parseAnswer } from "../src/prompt";

const BASH: ShellInfo = { platform: "linux", shell: "/bin/bash", family: "bash", notes: [] };
const GIT_BASH: ShellInfo = {
	platform: "win32",
	shell: "C:\\Program Files\\Git\\bin\\bash.exe",
	family: "bash",
	notes: ["Windows with Git Bash: GNU coreutils available.", "Paths: C:/Users/..."],
};

describe("request size", () => {
	test("stays under 4 KB even with every list overfull and oversized", () => {
		const long = "x".repeat(5000);
		const packet: ContextPacket = {
			description: `delete ${long}`,
			cwd: `C:/${long}`,
			os: "Windows 10.0.26200",
			shell: GIT_BASH,
			sshHosts: Array.from({ length: 200 }, (_, i) => `host-${i}-${long}`),
			recentCommands: Array.from({ length: 100 }, (_, i) => `echo ${i} ${long}`),
			spells: Array.from({ length: 50 }, (_, i) => ({ words: `words ${i} ${long}`, command: `cmd ${i} ${long}` })),
		};
		const bytes =
			Buffer.byteLength(buildSystemPrompt(packet.shell), "utf8") + Buffer.byteLength(buildUserMessage(packet), "utf8");
		expect(bytes).toBeLessThan(4096);
	});

	test("a typical request is well under 2 KB and carries no conversation", () => {
		const packet: ContextPacket = {
			description: "list files here",
			cwd: "/home/dz/project",
			os: "Linux 6.8 (Ubuntu 24.04)",
			shell: BASH,
			sshHosts: ["donnager", "donnager-root"],
			recentCommands: ["git status", "bun test"],
			spells: [{ words: "list files", command: "ls -la" }],
		};
		const user = buildUserMessage(packet);
		expect(Buffer.byteLength(buildSystemPrompt(BASH) + user)).toBeLessThan(2048);
		expect(user).toContain("Description: list files here");
		expect(user).toContain("SSH host aliases: donnager, donnager-root");
		expect(user).toContain("list files → ls -la");
	});

	test("the system prompt names the platform and shell, never assuming Linux", () => {
		expect(buildSystemPrompt(GIT_BASH)).toContain("runs in bash on Windows");
		expect(buildSystemPrompt({ ...BASH, platform: "darwin", family: "zsh", shell: "/bin/zsh" })).toContain(
			"runs in zsh on macOS",
		);
		expect(buildSystemPrompt({ ...BASH, family: "fish", shell: "/usr/bin/fish" })).toContain("Write fish syntax");
	});
});

describe("parseAnswer", () => {
	test("plain JSON, fenced JSON, and JSON with chatter around it", () => {
		const json = '{"command":"ls -la","explain":"Lists files.","destructive":false}';
		for (const reply of [json, `\`\`\`json\n${json}\n\`\`\``, `Sure! ${json} Hope that helps.`]) {
			expect(parseAnswer(reply)).toEqual({ command: "ls -la", explain: "Lists files.", destructive: false });
		}
	});

	test("strips a leading $, ! or backticks and joins lines", () => {
		expect(parseAnswer('{"command":"$ ls\\n-la","explain":"x"}')?.command).toBe("ls -la");
		expect(parseAnswer('{"command":"!git status"}')?.command).toBe("git status");
		expect(parseAnswer("`du -sh .`")?.command).toBe("du -sh .");
	});

	test("no command, no answer", () => {
		expect(parseAnswer('{"command":""}')).toBeUndefined();
		expect(parseAnswer("")).toBeUndefined();
	});
});

describe("pickModel", () => {
	const models = (roles: Record<string, string | undefined>, current?: string) => ({
		resolve: (spec: string) => roles[spec],
		current: () => current,
	});

	test("role spellbook first, then smol, then the session model", () => {
		expect(pickModel(models({ "@spellbook": "haiku", "@smol": "mini" }, "opus"))).toEqual({
			model: "haiku",
			via: "spellbook",
		});
		expect(pickModel(models({ "@smol": "mini" }, "opus"))).toEqual({ model: "mini", via: "smol" });
		expect(pickModel(models({}, "opus"))).toEqual({ model: "opus", via: "session" });
		expect(pickModel(models({}))).toBeUndefined();
	});

	test("replyText joins text blocks and surfaces errors", () => {
		expect(
			replyText({
				content: [
					{ type: "thinking", text: "hmm" },
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
			}),
		).toBe("ab");
		expect(() => replyText({ content: [], stopReason: "error", errorMessage: "rate limited" })).toThrow("rate limited");
	});
});
