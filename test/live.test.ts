/**
 * Live check against a real model through stock omp: each description becomes a command via
 * `omp -p "/spellbook cast …"`, and the command runs in the shell omp's `!` uses on this machine.
 *
 * Runs only with SPELLBOOK_LIVE=1 (it spends tokens). Options:
 * - SPELLBOOK_OMP: how to start omp (default `bun x @oh-my-pi/pi-coding-agent@18.20.2`)
 * - SPELLBOOK_MODEL: model for the `spellbook` role (default `anthropic/claude-haiku-5-5`)
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectShell, liveProbe } from "../src/platform";

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

/** Run `/spellbook cast` in stock omp, isolated from other extensions; `roles` goes in a config overlay. */
function cast(description: string, extra: string[]): Cast {
	const proc = Bun.spawnSync(
		[...OMP, "--no-extensions", "-e", REPO, ...extra, "-p", `/spellbook cast ${description}`],
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
	return JSON.parse(line) as Cast;
}

function overlay(roles: Record<string, string>): string[] {
	const file = path.join(tmp, `roles-${Object.keys(roles).join("-") || "none"}.yml`);
	const body = Object.entries(roles)
		.map(([role, model]) => `  ${role}: ${model}`)
		.join("\n");
	fs.writeFileSync(file, `modelRoles:\n${body}\n`);
	return ["--config", file];
}

/** Run a command the way omp's `!` would: the detected shell, as a login shell for bash/zsh. */
function runInShell(command: string): { code: number | null; out: string } {
	const shell = detectShell(liveProbe());
	if (shell.shell.includes("embedded")) throw new Error("no bash on this machine; run with Git Bash installed");
	const args = shell.family === "fish" ? ["-c", command] : ["-l", "-c", command];
	const proc = Bun.spawnSync([shell.shell, ...args], { cwd: REPO, timeout: 60_000, windowsHide: true });
	return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
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
		test(`"${description}" works in the ! shell`, () => {
			const answer = cast(description, overlay({ spellbook: MODEL }));
			expect(answer.model).toBe(MODEL);
			const result = runInShell(answer.command);
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
});
