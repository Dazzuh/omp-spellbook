/**
 * Live check against a real model through stock omp: each description is cast with
 * `omp -p "/spellbook cast …"` (a command) or `omp -p "/spellbook prompt …"` (a prompt), and each
 * command runs through omp's own `!` executor (`executeBash` with `useUserShell`, exactly what Enter
 * on a `!` line calls). Every cast prints its description, landed text, explanation and time.
 *
 * Runs only with SPELLBOOK_LIVE=1 (it spends tokens). Options:
 * - SPELLBOOK_OMP: how to start omp (default `bun x @oh-my-pi/pi-coding-agent@18.20.2`)
 * - SPELLBOOK_MODEL: the `spellbook` role, thinking level allowed (default `anthropic/claude-haiku-5-5:low`)
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
const MODEL = process.env.SPELLBOOK_MODEL ?? "anthropic/claude-haiku-5-5:low";
/** The model a cast reports: the role's model without its thinking level. */
const MODEL_ID = MODEL.replace(/:[a-z]+$/, "");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spellbook-live-"));
/** Sessions these runs make stay here, never beside the user's own. */
const SESSIONS = path.join(tmp, "sessions");

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Answer {
	text: string;
	explain: string;
	destructive?: boolean;
	model: string;
	ms: number;
}

/** Run stock omp in print mode, isolated from other extensions, with its sessions in {@link SESSIONS}. */
function omp(args: string[]): string {
	const proc = Bun.spawnSync([...OMP, "--no-extensions", "-e", REPO, "--session-dir", SESSIONS, ...args], {
		cwd: REPO,
		env: { ...process.env, SPELLBOOK_BOOK: path.join(tmp, "book.json") },
		timeout: 300_000,
		windowsHide: true,
	});
	const out = proc.stdout.toString();
	if (proc.exitCode !== 0) throw new Error(`omp exit ${proc.exitCode}:\n${out}\n${proc.stderr.toString()}`);
	return out;
}

/** `/spellbook cast|prompt <description>`, its JSON answer printed for the record. */
function run(subcommand: "cast" | "prompt", description: string, extra: string[]): Answer {
	const out = omp([...extra, "-p", `/spellbook ${subcommand} ${description}`]);
	const line = out
		.split(/\r?\n/)
		.reverse()
		.find(l => l.trim().startsWith("{"));
	if (!line) throw new Error(`no answer from omp:\n${out}`);
	const answer = JSON.parse(line) as Answer;
	console.log(
		JSON.stringify({ platform: process.platform, spell: subcommand === "cast" ? "?!" : "?", description, ...answer }),
	);
	return answer;
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
		test(`?! "${description}" works in the ! shell`, async () => {
			const answer = run("cast", description, overlay({ spellbook: MODEL }));
			expect(answer.model).toBe(MODEL_ID);
			const result = await runInShell(answer.text);
			if (result.code !== 0 || !expected.test(result.out)) {
				throw new Error(`command: ${answer.text}\nexit: ${result.code}\noutput:\n${result.out}`);
			}
		}, 360_000);
	}

	test("without a spellbook role the smol role answers", () => {
		const answer = run("cast", "list the files in this folder", ["--smol", MODEL, ...overlay({})]);
		expect(answer.model).toBe(MODEL_ID);
	}, 360_000);

	test("?! a destructive description is flagged", () => {
		const answer = run("cast", "delete every .log file below here", overlay({ spellbook: MODEL }));
		expect(answer.destructive).toBe(true);
	}, 360_000);

	for (const description of [
		"get a few agents to review this repo for bugs",
		"stop it forgetting stuff in long chats",
		"make the agent stop asking me before it edits files",
		"fix the typo in the readme title",
	]) {
		test(`? "${description}" lands a prompt`, () => {
			const answer = run("prompt", description, overlay({ spellbook: MODEL }));
			expect(answer.model).toBe(MODEL_ID);
			expect(answer.text.trim().length).toBeGreaterThan(0);
		}, 360_000);
	}
});

describe.skipIf(!LIVE)("? casts a skill fits", () => {
	/** A skill only this test has, in a folder of its own, so the cast can only know it by looking. */
	const skills = path.join(tmp, "skills");
	fs.mkdirSync(path.join(skills, "changelog-entry"), { recursive: true });
	fs.writeFileSync(
		path.join(skills, "changelog-entry", "SKILL.md"),
		"---\nname: changelog-entry\ndescription: Use when adding an entry to CHANGELOG.md: which section, tense and wording this repo uses.\n---\n\n# Changelog entries\n\nNew entries go under the top version heading, one bullet per change, present tense.\n",
	);
	const withSkill = () => {
		const file = path.join(tmp, "skills.yml");
		fs.writeFileSync(file, `skills:\n  customDirectories:\n    - ${JSON.stringify(skills)}\n`);
		return [...overlay({ spellbook: MODEL }), "--config", file];
	};

	for (const description of [
		"add a line to the changelog saying the spell's explanation now goes away when you clear the composer",
		"write a tern plugin that adds a palette command to open htop in a split",
		"file an issue in kata for the flaky cast test",
	]) {
		test(`? "${description}" lands a prompt (lookups printed)`, () => {
			const answer = run("prompt", description, withSkill());
			expect(answer.text.trim().length).toBeGreaterThan(0);
		}, 360_000);
	}
});

describe.skipIf(!LIVE)("casts that only make sense from the conversation", () => {
	/** A session in which the user already talked about something; later casts resume it. */
	let session = "";
	const resume = () => ["--resume", session, ...overlay({ spellbook: MODEL })];

	test("seed: a short conversation about a flaky test", () => {
		omp([
			"--model",
			MODEL_ID,
			"-p",
			"Context for later, reply with one short sentence and do nothing else: test/cast.test.ts fails on Windows now and then with EBUSY when it removes its temp folder, and I also want the README's Settings table to list SPELLBOOK_STYLE.",
		]);
		const files = fs.readdirSync(SESSIONS, { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		session = path.join(SESSIONS, files[0]!);
	}, 360_000);

	test('? "fix that flaky test I mentioned" lands a prompt about it', () => {
		const answer = run("prompt", "fix that flaky test I mentioned", resume());
		expect(answer.text).toMatch(/cast\.test|EBUSY|temp/i);
	}, 360_000);

	test('? "do the readme thing" lands a prompt about it', () => {
		const answer = run("prompt", "do the readme thing", resume());
		expect(answer.text).toMatch(/README|SPELLBOOK_STYLE/i);
	}, 360_000);

	test('?! "run just that test file" lands a command for it', () => {
		const answer = run("cast", "run just that test file", resume());
		expect(answer.text).toMatch(/cast\.test/);
	}, 360_000);
});
