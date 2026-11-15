import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildCatalogue,
	CATALOGUE_BUDGET,
	type CatalogueEntry,
	type CatalogueSources,
	DESCRIPTION_CHARS,
	DOC_PAGE_BYTES,
} from "../src/catalogue";

const LONG = `Use when the user asks about ${"multi-step workflows across several repositories ".repeat(20)}`;

function sources(overrides: Partial<CatalogueSources> = {}): CatalogueSources {
	const docs: Record<string, string> = {
		"extensions.md": "# Extensions\n\nregisterCommand …",
		"skills.md": `# Skills\n\n${"語😀".repeat(5000)}`,
		"hooks.md": "# Hooks",
	};
	return {
		builtins: [
			{ name: "model", description: "Select a model" },
			{ name: "settings", description: "Open settings" },
		],
		commands: [
			{ name: "spellbook", description: "Spellbook: settings, saved commands, or cast", source: "extension" },
			{ name: "review", description: "Review the diff", source: "prompt" },
			{ name: "skill:kata", description: "Kata issue tracker CLI.\nUse for issues.", source: "skill" },
			{ name: "skill:tern", description: LONG, source: "skill" },
		],
		keywords: [
			{ id: "ultrathink", word: "ultrathink" },
			{ id: "chillax", word: "chillax" },
			{ id: "orchestrate", word: "orchestrate" },
			{ id: "workflow", word: "workflowz" },
		],
		setting: () => undefined,
		docNames: Object.keys(docs).sort(),
		readDoc: async name => docs[name],
		...overrides,
	};
}

const names = (entries: readonly CatalogueEntry[]) => entries.map(e => e.name);

describe("catalogue from fixture sources", () => {
	test("skills lose the skill: prefix and stay out of the command list", () => {
		const catalogue = buildCatalogue(sources());
		expect(names(catalogue.skills)).toEqual(["kata", "tern"]);
		expect(catalogue.skills[0]?.description).toBe("Kata issue tracker CLI. Use for issues.");
		const text = catalogue.render();
		expect(text).toContain("- kata: Kata issue tracker CLI.");
		expect(text).not.toMatch(/skill:(?!\/\/)/);
	});

	test("commands list built-ins first, then extension and prompt commands", () => {
		const catalogue = buildCatalogue(sources());
		expect(names(catalogue.commands)).toEqual(["model", "settings", "spellbook", "review"]);
		const text = catalogue.render();
		expect(text).toContain("- /model: Select a model");
		expect(text).toContain("- /spellbook: Spellbook: settings");
		expect(text).toContain("- /review: Review the diff");
	});

	test("keywords: all by default, none when the master switch is off, a disabled one dropped", () => {
		expect(buildCatalogue(sources()).keywords).toEqual(["ultrathink", "chillax", "orchestrate", "workflowz"]);
		const masterOff = buildCatalogue(sources({ setting: id => (id === "magicKeywords.enabled" ? false : undefined) }));
		expect(masterOff.keywords).toEqual([]);
		expect(masterOff.render()).not.toContain("ultrathink");
		const oneOff = buildCatalogue(
			sources({ setting: id => (id === "magicKeywords.chillax" || id === "magicKeywords.workflow" ? false : true) }),
		);
		expect(oneOff.keywords).toEqual(["ultrathink", "orchestrate"]);
	});

	test("descriptions are cut to 120 characters and the render stays under budget", () => {
		const text = buildCatalogue(sources()).render(CATALOGUE_BUDGET);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CATALOGUE_BUDGET);
		const tern = text.split("\n").find(line => line.startsWith("- tern: "));
		expect(tern).toBeDefined();
		expect(Array.from(tern!.slice("- tern: ".length)).length).toBe(DESCRIPTION_CHARS);
		expect(tern!.endsWith("…")).toBe(true);
		expect(text).toContain("omp doc pages (omp://<name>):\nextensions.md, hooks.md, skills.md");
	});

	test("a budget too small for descriptions switches to names only, still under budget", () => {
		const catalogue = buildCatalogue(sources());
		const full = catalogue.render(100_000);
		const budget = Buffer.byteLength(full) - 1;
		const short = catalogue.render(budget);
		expect(Buffer.byteLength(short)).toBeLessThanOrEqual(budget);
		expect(short).toContain("kata, tern");
		expect(short).toContain("/model, /settings, /spellbook, /review");
		expect(short).not.toContain("Select a model");
		// Smaller still: whole lines go from the end, never past the budget.
		for (const tiny of [120, 40, 0]) expect(Buffer.byteLength(catalogue.render(tiny))).toBeLessThanOrEqual(tiny);
	});

	test("doc reader: known pages only, at most two, each capped", async () => {
		const catalogue = buildCatalogue(sources());
		const pages = await catalogue.readDocs(["omp://skills", "nope.md", "extensions.md", "skills.md", "hooks"]);
		expect(pages.map(p => p.name)).toEqual(["skills.md", "extensions.md"]);
		expect(Buffer.byteLength(pages[0]!.text)).toBeLessThanOrEqual(DOC_PAGE_BYTES);
		expect(pages[0]!.text.endsWith("…")).toBe(true);
		expect(pages[1]!.text).toBe("# Extensions\n\nregisterCommand …");
		expect(await catalogue.readDocs(["../package.json"])).toEqual([]);
	});
});

// Stock omp 18.20.2: the devDependency's own CLI, or SPELLBOOK_OMP (e.g. `omp` in CI).
const OMP_CLI = path.join(path.dirname(require.resolve("@oh-my-pi/pi-coding-agent/package.json")), "dist", "cli.js");
const OMP = process.env.SPELLBOOK_OMP?.split(" ") ?? [process.execPath, OMP_CLI];
const PROBE = path.join(import.meta.dir, "fixtures", "catalogue-probe.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spellbook-catalogue-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("against stock omp", () => {
	test("the real reader returns skills, built-in commands, keywords from settings and doc pages", () => {
		// A project skill in the cwd, so the check holds on a machine with no skills installed.
		const skillDir = path.join(tmp, ".omp", "skills", "catalogue-fixture");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			"---\nname: catalogue-fixture\ndescription: Spellbook catalogue test skill.\n---\n\nNothing to do.\n",
		);
		const config = path.join(tmp, "config.yml");
		fs.writeFileSync(config, "magicKeywords:\n  chillax: false\n");
		const proc = Bun.spawnSync(
			[
				...OMP,
				"--no-extensions",
				"-e",
				PROBE,
				"--config",
				config,
				"--model",
				"anthropic/claude-haiku-5-5",
				"-p",
				"/catalogue-probe extensions",
			],
			{
				cwd: tmp,
				env: { ANTHROPIC_API_KEY: "sk-ant-catalogue-placeholder", ...process.env },
				timeout: 120_000,
				windowsHide: true,
			},
		);
		const out = proc.stdout.toString();
		const line = out.split(/\r?\n/).find(l => l.startsWith('{"skills"'));
		if (!line) throw new Error(`no probe output (exit ${proc.exitCode}):\n${out}\n${proc.stderr.toString()}`);
		const probe = JSON.parse(line) as {
			skills: CatalogueEntry[];
			commands: CatalogueEntry[];
			keywords: string[];
			docs: string[];
			pages: { name: string; text: string }[];
			render: string;
		};

		expect(probe.skills).toContainEqual({ name: "catalogue-fixture", description: "Spellbook catalogue test skill." });
		expect(names(probe.commands)).toEqual(expect.arrayContaining(["model", "settings", "catalogue-probe"]));
		expect(probe.keywords).toContain("orchestrate");
		expect(probe.keywords).not.toContain("chillax");
		expect(probe.docs).toContain("extensions.md");
		expect(probe.pages).toHaveLength(1);
		expect(probe.pages[0]!.name).toBe("extensions.md");
		expect(probe.pages[0]!.text.length).toBeGreaterThan(200);
		expect(Buffer.byteLength(probe.render)).toBeLessThanOrEqual(CATALOGUE_BUDGET);
		console.log(`omp catalogue: ${Buffer.byteLength(probe.render)} bytes, ${probe.skills.length} skills, ${probe.commands.length} commands, ${probe.docs.length} docs`);
	}, 150_000);
});
