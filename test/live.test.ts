/**
 * Live check against a real model through stock omp: each description becomes a command via
 * `omp -p "/spellbook cast …"`, and the command runs through omp's own `!` executor
 * (`executeBash` with `useUserShell`, exactly what Enter on a `!` line calls).
 *
 * Runs only with SPELLBOOK_LIVE=1 (it spends tokens). Options:
 * - SPELLBOOK_OMP: how to start omp (default `bun x @oh-my-pi/pi-coding-agent@18.20.2`)
 * - SPELLBOOK_MODEL: model for the `spellbook` role (default `anthropic/claude-haiku-5-5`)
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Test-only deep import of the devDependency: the plugin itself never runs commands.
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";

const LIVE = process.env.SPELLBOOK_LIVE === "1";
const REPO = path.resolve(import.meta.dir, "..");
// `bun x`, not `bunx`: some bun installs ship only the `bun` binary.
const OMP = process.env.SPELLBOOK_OMP?.split(" ") ?? [process.execPath, "x", "@oh-my-pi/pi-coding-agent@18.20.2"];
const MODEL = process.env.SPELLBOOK_MODEL ?? "anthropic/claude-haiku-5-5";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spellbook-live-"));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Cast {
	command: string;
	explain: string;
	destructive: boolean;
	model: string;
}

/** Run a `/spellbook` subcommand in stock omp, isolated from other extensions, and parse its JSON answer. */
function run<T>(subcommand: string, description: string, extra: string[]): T {
	const proc = Bun.spawnSync(
		[...OMP, "--no-extensions", "-e", REPO, ...extra, "-p", `/spellbook ${subcommand} ${description}`],
		{
			cwd: REPO,
			env: { ...process.env, SPELLBOOK_BOOK: path.join(tmp, "book.json") },
			timeout: 180_000,
			windowsHide: true,
		},
	);
	const out = proc.stdout.toString();
	const line = out
		.split(/\r?\n/)
		.reverse()
		.find(l => l.trim().startsWith("{"));
	if (!line) throw new Error(`no answer from omp (exit ${proc.exitCode}):\n${out}\n${proc.stderr.toString()}`);
	return JSON.parse(line) as T;
}

/** `/spellbook cast`: a shell command; `roles` goes in a config overlay. */
function cast(description: string, extra: string[]): Cast {
	return run<Cast>("cast", description, extra);
}

interface PromptCast {
	kind: "prompt" | "command" | "setting";
	text: string;
	explain: string;
	warnings: string[];
	model: string;
	picks?: { docs: string[]; settings: string[]; keywords: string[] };
	ms: number;
	mapBytes: number;
}

function overlay(roles: Record<string, string>): string[] {
	const file = path.join(tmp, `roles-${Object.keys(roles).join("-") || "none"}.yml`);
	const body = Object.entries(roles)
		.map(([role, model]) => `  ${role}: ${model}`)
		.join("\n");
	fs.writeFileSync(file, `modelRoles:\n${body}\n`);
	return ["--config", file];
}

/** Run a command exactly as omp's `!` does: its executor, the user's shell, the repo as cwd. */
async function runInShell(command: string): Promise<{ code: number | undefined; out: string }> {
	const result = await executeBash(command, { cwd: REPO, useUserShell: true, timeout: 60_000 });
	return { code: result.exitCode, out: result.output };
}

const DESCRIPTIONS: ReadonlyArray<readonly [string, RegExp]> = [
	["list the files in this folder", /package\.json/],
	["print the full path of the current folder", new RegExp(path.basename(REPO).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
	["count the lines in README.md", /\d+/],
	["find every file named package.json below here, skipping node_modules", /package\.json/],
	["show the three most recently modified files in src", /\.ts/],
];

describe.skipIf(!LIVE)(`live on ${process.platform}`, () => {
	for (const [description, expected] of DESCRIPTIONS) {
		test(`"${description}" works in the ! shell`, async () => {
			const answer = cast(description, overlay({ spellbook: MODEL }));
			expect(answer.model).toBe(MODEL);
			const result = await runInShell(answer.command);
			console.log(`${process.platform} | ${description} → ${answer.command}`);
			if (result.code !== 0 || !expected.test(result.out)) {
				throw new Error(`command: ${answer.command}\nexit: ${result.code}\noutput:\n${result.out}`);
			}
		}, 240_000);
	}

	test("without a spellbook role the smol role answers", () => {
		const answer = cast("list the files in this folder", ["--smol", MODEL, ...overlay({})]);
		expect(answer.model).toBe(MODEL);
	}, 240_000);

	test("a destructive description is flagged", () => {
		const answer = cast("delete every .log file below here", overlay({ spellbook: MODEL }));
		expect(answer.destructive).toBe(true);
	}, 240_000);

	test("? prompt spell: a fan-out task gets orchestrate and stays a prompt", () => {
		const answer = run<PromptCast>("prompt", "get a few agents to review this repo for bugs", overlay({ spellbook: MODEL }));
		console.log(`${process.platform} | ? review → ${answer.text}`);
		expect(answer.kind).toBe("prompt");
		expect(answer.text).toMatch(/(?<![\w./\\-])orchestrate(?![\w/\\-])/);
		expect(answer.text).not.toMatch(/^[!?/]/);
		expect(answer.text).not.toMatch(/skill:(?!\/\/[A-Za-z0-9])/);
	}, 240_000);

	test("? prompt spell: an omp command becomes the slash command", () => {
		const answer = run<PromptCast>("prompt", "compact the conversation", overlay({ spellbook: MODEL }));
		expect(answer).toMatchObject({ kind: "command", text: "/compact" });
	}, 240_000);

	test("? prompt spell: a setting becomes !omp config set with a real key", () => {
		const answer = run<PromptCast>("prompt", "turn off auto compaction", overlay({ spellbook: MODEL }));
		expect(answer.kind).toBe("setting");
		expect(answer.text).toMatch(/^!omp config set compaction\.\S+ \S+/);
		expect(answer.warnings).toEqual([]);
	}, 240_000);
});

describe.skipIf(!LIVE)("? prompt spell: newcomers without omp's words", () => {
	test("'stop it forgetting stuff in long chats' reaches compaction", () => {
		const description = "stop it forgetting stuff in long chats";
		const answer = run<PromptCast>("prompt", description, overlay({ spellbook: MODEL }));
		console.log(
			JSON.stringify({
				description,
				kind: answer.kind,
				text: answer.text,
				picks: answer.picks,
				ms: answer.ms,
				mapBytes: answer.mapBytes,
			}),
		);
		const reached =
			answer.picks?.docs.includes("compaction.md") ||
			answer.picks?.settings.some(id => id.startsWith("compaction.")) ||
			/compact/i.test(answer.text);
		expect(Boolean(reached)).toBe(true);
	}, 240_000);

	test("'get a bunch of helpers to check every file for bugs at once' gets orchestrate", () => {
		const description = "get a bunch of helpers to check every file for bugs at once";
		const answer = run<PromptCast>("prompt", description, overlay({ spellbook: MODEL }));
		console.log(
			JSON.stringify({
				description,
				kind: answer.kind,
				text: answer.text,
				picks: answer.picks,
				ms: answer.ms,
				mapBytes: answer.mapBytes,
			}),
		);
		expect(answer.text).toMatch(/(?<![\w./\\-])orchestrate(?![\w/\\-])/);
	}, 240_000);

	test("'make the agent stop asking me before it edits files' reaches tools.approvalMode", () => {
		const description = "make the agent stop asking me before it edits files";
		const answer = run<PromptCast>("prompt", description, overlay({ spellbook: MODEL }));
		console.log(
			JSON.stringify({
				description,
				kind: answer.kind,
				text: answer.text,
				picks: answer.picks,
				ms: answer.ms,
				mapBytes: answer.mapBytes,
			}),
		);
		const reached =
			answer.picks?.settings.includes("tools.approvalMode") ||
			answer.text.includes("tools.approvalMode") ||
			/approval/i.test(answer.text);
		expect(Boolean(reached)).toBe(true);
	}, 240_000);
});
