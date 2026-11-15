import { describe, expect, test } from "bun:test";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { lookup, all } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getDocFilenames, getEmbeddedDoc } from "@oh-my-pi/pi-coding-agent/internal-urls/docs-index";
import { MAGIC_KEYWORDS } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import * as omp from "@oh-my-pi/pi-coding-agent";
import { buildCatalogue, type CatalogueSources, type SettingEntry, type SettingSource } from "../src/catalogue";
import { buildOmpMap, type DocSummary, docSummary, MAP_SENTENCE_CHARS, type OmpMap, renderMap } from "../src/omp-map";

const decodeStrict = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

function fixtureSources(overrides: Partial<CatalogueSources> = {}): CatalogueSources {
	const docs: Record<string, string> = {
		"compaction.md": "---\ntitle: Compaction\n---\n# Compaction\n\nCompaction keeps long chats going. It summarises older turns.\n",
		"hooks.md": "# Hooks\n\n- item one. Still a list.\n",
	};
	return {
		builtins: [{ name: "model", description: "Select a model" }],
		commands: [{ name: "skill:kata", description: "Kata issue tracker CLI.\nUse for issues.", source: "skill" }],
		keywords: [
			{ id: "ultrathink", word: "ultrathink", description: "Think   hard\n  now.", notice: () => "N" },
			{
				id: "orchestrate",
				word: "orchestrate",
				description: "Orchestrate agents",
				notice: (ctx: { tools: string[] }) => `X ${ctx.tools.length}`,
			},
			{ id: "chillax", word: "chillax", description: "Chill out", notice: () => "C" },
		],
		setting: id => (id === "magicKeywords.chillax" ? false : undefined),
		docNames: Object.keys(docs).sort(),
		readDoc: async name => docs[name],
		settings: [
			{ id: "tools.x", type: "enum", values: ["a", "b"], default: "a", ui: { label: "Tools X", description: "Pick" } },
		],
		...overrides,
	};
}

describe("docSummary", () => {
	test("title and first prose sentence, past front matter, code, tables and lists", () => {
		const text = [
			"---",
			"name: x",
			"---",
			"# Compaction",
			"",
			"```ts",
			"const a = 1. Not prose.",
			"```",
			"",
			"| a | b |",
			"|---|---|",
			"| 1 | 2 |",
			"",
			"- item one. Not prose either.",
			"",
			"Omp keeps long chats going. It summarises older turns.",
		].join("\n");
		expect(docSummary("compaction.md", text)).toEqual({
			name: "compaction.md",
			title: "Compaction",
			sentence: "Omp keeps long chats going.",
		});
	});

	test("a table as the first block is skipped", () => {
		const text = "| a | b |\n|---|---|\n\nThe real text. Yes.\n";
		expect(docSummary("t.md", text).sentence).toBe("The real text.");
	});

	test("no heading: the title is the page name's stem", () => {
		const summary = docSummary("omp://plain-page.md", "Plain page here! Second.\n");
		expect(summary.title).toBe("plain-page");
		expect(summary.sentence).toBe("Plain page here!");
	});

	test("a sentence ends at ? or ! followed by a space or the end", () => {
		expect(docSummary("q.md", "# Q\n\nWhy? Because.\n").sentence).toBe("Why?");
		expect(docSummary("q.md", "# Q\n\nNo full stop at all").sentence).toBe("No full stop at all");
	});

	test("a long sentence is cut to MAP_SENTENCE_CHARS code points with an ellipsis", () => {
		const sentence = `${"語😀".repeat(200)} end.`;
		const summary = docSummary("long.md", `# Long\n\n${sentence}\n`);
		expect(Array.from(summary.sentence).length).toBe(MAP_SENTENCE_CHARS);
		expect(summary.sentence.endsWith("…")).toBe(true);
	});
});

describe("buildOmpMap from fixture sources", () => {
	test("covers every doc page, only enabled keywords, with omp's descriptions and zero-arg notices", async () => {
		const map = await buildOmpMap(buildCatalogue(fixtureSources()));
		expect(map.docs.map(d => d.name)).toEqual(["compaction.md", "hooks.md"]);
		expect(map.docs[0]).toEqual({
			name: "compaction.md",
			title: "Compaction",
			sentence: "Compaction keeps long chats going.",
		});
		expect(map.keywords).toEqual([
			{ word: "ultrathink", description: "Think hard now.", notice: "N" },
			{ word: "orchestrate", description: "Orchestrate agents" },
		]);
		expect(map.keywords[1]).not.toHaveProperty("notice");
		expect(map.settings.map(s => s.id)).toEqual(["tools.x"]);
		expect(map.settings[0]?.description).toBe("Tools X: Pick");
		expect(map.skills).toEqual([{ name: "kata", description: "Kata issue tracker CLI. Use for issues." }]);
		expect(map.commands.map(c => c.name)).toEqual(["model"]);
	});
});

const sampleMap: OmpMap = {
	docs: [{ name: "a.md", title: "A title", sentence: "A sentence." }],
	settings: [
		{ id: "s.one", type: "enum", values: ["x", "y"], default: "", description: "desc 語😀", experimental: false, warning: "", current: "" },
	],
	keywords: [{ word: "ultrathink", description: "Think" }],
	skills: [{ name: "kata", description: "Kata CLI" }],
	commands: [{ name: "review", description: "Review" }],
};

function hugeMap(settings: number): OmpMap {
	return {
		...sampleMap,
		settings: Array.from({ length: settings }, (_, i) => ({
			id: `s.${i}`,
			type: "string",
			values: [],
			default: "",
			description: "語😀".repeat(60),
			experimental: false,
			warning: "",
			current: "",
		})),
	};
}

describe("renderMap", () => {
	test("a setting line marks experimental after its type and ends with its risk note", () => {
		const settings: SettingEntry[] = [
			{ id: "exp.one", type: "boolean", values: [], default: "false", description: "Pick", experimental: true, warning: "", current: "" },
			{ id: "risk.two", type: "boolean", values: [], default: "", description: "Risky", experimental: false, warning: "Sends data out.", current: "" },
		];
		const text = renderMap({ ...sampleMap, settings }, 1e9);
		expect(text).toContain("- exp.one (boolean) [experimental]: Pick");
		expect(text).toContain("- risk.two (boolean): Risky Risk: Sends data out.");
	});

	test("every section appears with its lines when the budget is huge", () => {
		const text = renderMap(sampleMap, 1e9);
		expect(text).toContain("omp doc pages (omp://<name>):\n- a.md: A title. A sentence.");
		expect(text).toContain("omp settings (omp config set <id> <value>):\n- s.one (enum one of x|y): desc 語😀");
		expect(text).toContain(
			"Magic keywords (switched on; a standalone lowercase word in the prompt turns one on):\n- ultrathink: Think",
		);
		expect(text).toContain("Skills (skill://<name>):\n- kata: Kata CLI");
		expect(text).toContain("Slash commands:\n- /review: Review");
	});

	test("an empty section is omitted", () => {
		const text = renderMap({ ...sampleMap, keywords: [], skills: [] }, 1e9);
		expect(text).not.toContain("Magic keywords");
		expect(text).not.toContain("Skills (skill://");
		expect(text).toContain("Slash commands:");
	});

	test("a keyword line carries its cleaned notice, cut to 300 code points", () => {
		const notice = `<system-notice>Use  <b>care</b>\n now. ${"語😀".repeat(300)}</system-notice>`;
		const text = renderMap({ ...sampleMap, keywords: [{ word: "ultrathink", description: "Think", notice }] }, 1e9);
		const line = text.split("\n").find(l => l.startsWith("- ultrathink: "));
		expect(line).toBeDefined();
		expect(line!.startsWith("- ultrathink: Think It tells the agent: Use care now. 語😀")).toBe(true);
		const shown = line!.slice(line!.indexOf("It tells the agent: ") + "It tells the agent: ".length);
		expect(Array.from(shown).length).toBe(300);
		expect(shown.endsWith("…")).toBe(true);
		expect(shown).not.toContain("<");
	});

	test("stays within every small budget and never splits a multi-byte character", () => {
		for (let budget = 0; budget <= 400; budget += 1) {
			const text = renderMap(sampleMap, budget);
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget);
			expect(() => decodeStrict(Buffer.from(text))).not.toThrow();
		}
	});

	test("a tiny budget (2,000 bytes) over 2,000 settings stays under budget and keeps whole lines", () => {
		const text = renderMap(hugeMap(2000), 2_000);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2_000);
		expect(() => decodeStrict(Buffer.from(text))).not.toThrow();
		// Keywords lead (small, and never the lines a tight budget drops), then pages, then settings.
		expect(text.startsWith("Magic keywords (")).toBe(true);
		expect(text).toContain("omp doc pages (omp://<name>):\n- a.md: A title. A sentence.\nomp settings (omp config set <id> <value>):\n- s.0 (string): ");
		expect(text.split("\n").at(-1)!.startsWith("- s.")).toBe(true);
	});

	test("a huge map is cut to descriptions of 50 characters before lines are dropped", () => {
		const budget = 20_000;
		const text = renderMap(hugeMap(2000), budget);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget);
		expect(() => decodeStrict(Buffer.from(text))).not.toThrow();
		const first = text.split("\n").find(line => line.startsWith("- s.0 ("));
		expect(first).toBeDefined();
		const description = first!.slice(first!.indexOf("): ") + 3);
		expect(Array.from(description).length).toBeLessThanOrEqual(50);
		expect(description.endsWith("…")).toBe(true);
	});

	test("a huge map at the full request budget fits and decodes", () => {
		const text = renderMap(hugeMap(2000), 128_000);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(128_000);
		expect(() => decodeStrict(Buffer.from(text))).not.toThrow();
	});

	test("a doc summary with no sentence renders its title alone", () => {
		const docs: DocSummary[] = [{ name: "b.md", title: "Only title", sentence: "" }];
		expect(renderMap({ ...sampleMap, docs }, 1e9)).toContain("- b.md: Only title");
	});
});

// Real omp, not fixtures: the doc index, the setting registry and the magic keywords as installed.
describe("against stock omp", () => {
	test(
		"maps the installed doc pages and settings",
		async () => {
			const catalogue = buildCatalogue({
				builtins: BUILTIN_SLASH_COMMAND_DEFS,
				commands: [],
				keywords: MAGIC_KEYWORDS,
				setting: id => {
					try {
						return lookup(id)?.get(omp.settings);
					} catch {
						return undefined;
					}
				},
				docNames: getDocFilenames(),
				readDoc: getEmbeddedDoc,
				settings: all().map(s => s.definition as SettingSource),
				noticeContext: { tools: ["task", "read"] },
			});
			const map = await buildOmpMap(catalogue);

			expect(map.docs.length).toBeGreaterThan(100);
			for (const doc of map.docs) expect(doc.title.trim().length).toBeGreaterThan(0);
			const compaction = map.docs.find(d => d.name === "compaction.md");
			expect(compaction).toBeDefined();
			expect(`${compaction!.title} ${compaction!.sentence}`).toMatch(/context/i);
			expect(map.settings.some(s => s.id === "tools.approvalMode")).toBe(true);
			expect(map.settings.find(s => s.id === "compaction.experimentalContextManagement")?.experimental).toBe(true);
			expect(map.settings.find(s => s.id === "compaction.enabled")?.experimental).toBe(false);
			const orchestrate = renderMap(map, 1e9).split("\n").find(line => line.startsWith("- orchestrate: "));
			expect(orchestrate).toContain("It tells the agent:");

			console.log(`omp map, uncapped: ${Buffer.byteLength(renderMap(map, 1e9))} bytes`);
		},
		30_000,
	);
});
