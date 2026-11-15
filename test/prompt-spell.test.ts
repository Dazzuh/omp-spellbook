import { describe, expect, test } from "bun:test";
import { buildCatalogue, type Catalogue, type CatalogueSources, DOC_PAGE_BYTES } from "../src/catalogue";
import {
	buildPromptRequest,
	castPrompt,
	hasKeyword,
	keywordHints,
	matchSettings,
	pickDocPages,
	PROMPT_REQUEST_BUDGET,
	type PromptRequest,
	parsePromptReply,
} from "../src/prompt-spell";

const INSTALLED = ["kata", "git-workflow-and-versioning", "tarkov-wiki"];
const KEYWORDS = [
	{ id: "ultrathink", word: "ultrathink" },
	{ id: "chillax", word: "chillax" },
	{ id: "orchestrate", word: "orchestrate" },
	{ id: "workflow", word: "workflowz" },
	{ id: "jevify", word: "jevify" },
];
const DOCS: Record<string, string> = {
	"compaction.md": "# Compaction\n\nWhen the context fills, omp summarises older turns.",
	"magic-keywords.md": "# Magic keywords\n\northestrate, ultrathink …",
	"skills.md": "# Skills",
	"natives-architecture.md": "# Natives",
	"settings.md": `# Settings\n\n${"x".repeat(250_000)}`,
};

/** A fixture omp: three installed skills, a few commands and settings, all keywords on unless `off` names them. */
function catalogue(options: { off?: string[]; overrides?: Partial<CatalogueSources> } = {}): Catalogue {
	const off = new Set(options.off ?? []);
	return buildCatalogue({
		builtins: [
			{ name: "compact", description: "Compact the conversation to free context" },
			{ name: "model", description: "Select a model" },
			{ name: "settings", description: "Open settings" },
		],
		commands: [
			{ name: "spellbook", description: "Spellbook", source: "extension" },
			...INSTALLED.map(name => ({ name: `skill:${name}`, description: `The ${name} skill.`, source: "skill" })),
		],
		keywords: KEYWORDS,
		setting: id => (off.has(id) ? false : undefined),
		docNames: Object.keys(DOCS).sort(),
		readDoc: async name => DOCS[name],
		settings: [
			{
				id: "compaction.enabled",
				type: "boolean",
				default: true,
				ui: { label: "Auto-Compact", description: "Automatically compact context when it gets too large" },
			},
			{ id: "compaction.strategy", type: "enum", values: ["summary", "drop"], ui: { description: "How to compact" } },
			{ id: "tui.motion", type: "boolean", ui: { label: "Motion", description: "Animate the interface" } },
			{ id: "auth.broker.token", type: "string", credential: true, ui: { description: "Compaction broker token" } },
		],
		...options.overrides,
	});
}

/** Run a cast against a scripted model reply; returns the landed answer and the one request sent. */
async function cast(description: string, reply: unknown, cat: Catalogue = catalogue()) {
	const requests: PromptRequest[] = [];
	const answer = await castPrompt(
		description,
		cat,
		async request => {
			requests.push(request);
			return typeof reply === "string" ? reply : JSON.stringify(reply);
		},
		id => cat.settings.some(s => s.id === id),
	);
	expect(requests).toHaveLength(1);
	return { answer, request: requests[0]! };
}

describe("skills are named as skill://<name>, installed ones only", () => {
	test("the request lists the installed skills and asks for skill://<name>", async () => {
		const { request } = await cast("file an issue for the flaky test", { kind: "prompt", text: "File it." });
		for (const name of INSTALLED) expect(request.user).toContain(`- ${name}: The ${name} skill.`);
		expect(request.system).toContain("skill://<name>");
		expect(request.system).toContain("never write /skill: or skill:<name>");
	});

	test("every form of skill reference lands as skill://<name>; uninstalled skills are never named", async () => {
		const { answer } = await cast("file an issue and branch for the fix", {
			kind: "prompt",
			text: "Read skill://kata and /skill:git-workflow-and-versioning, then skill:tarkov-wiki. Also skill://made-up-skill and /skill:nope.",
		});
		expect(answer.kind).toBe("prompt");
		expect([...answer.text.matchAll(/\/?skill:(?:\/\/)?[\w.-]*\w/g)].map(m => m[0]).sort()).toEqual(
			["skill://git-workflow-and-versioning", "skill://kata", "skill://tarkov-wiki"].sort(),
		);
		expect(answer.text).not.toMatch(/skill:(?!\/\/[A-Za-z0-9])/);
		expect(answer.text).toContain("then skill://tarkov-wiki.");
		expect(answer.warnings).toEqual(["skill made-up-skill is not installed", "skill nope is not installed"]);
	});

	test("a slash command that is really a /skill: token becomes a prompt naming the skill", async () => {
		for (const text of ["/skill:kata file the flaky test", "/skill://kata file the flaky test"]) {
			const { answer } = await cast("use kata to file it", { kind: "command", text });
			expect(answer).toMatchObject({ kind: "prompt", text: "Use skill://kata file the flaky test", warnings: [] });
		}
		const missing = await cast("use nope", { kind: "command", text: "/skill:nope go" });
		expect(missing.answer).toMatchObject({ kind: "prompt", text: "Use nope go", warnings: ["skill nope is not installed"] });
	});

	test("a slash command's arguments get the same check: installed skills only, enabled keywords only", async () => {
		const { answer } = await cast(
			"review the diff",
			{ kind: "command", text: "/compact skill://nope and orchestrate" },
			catalogue({ off: ["magicKeywords.orchestrate"] }),
		);
		expect(answer.text).toBe("/compact nope and");
		expect(answer.warnings).toEqual(["skill nope is not installed", "orchestrate is switched off"]);
	});
});

describe("magic keywords", () => {
	test("a description that fits a keyword produces it, even when the model leaves it out", async () => {
		const description = "get a few agents to review this repo in parallel";
		const { answer, request } = await cast(description, { kind: "prompt", text: "Review this repo." });
		expect(request.user).toContain("Keywords this description asks for: orchestrate");
		expect(hasKeyword(answer.text, "orchestrate")).toBe(true);
		// The model's own use is kept as written, never doubled.
		const kept = await cast(description, { kind: "prompt", text: "orchestrate a review of this repo." });
		expect(kept.answer.text).toBe("orchestrate a review of this repo.");
		// "Orchestrate" at a sentence start is no keyword to omp: it is lowercased, not repeated.
		const capital = await cast(description, { kind: "prompt", text: "Orchestrate a review of this repo." });
		expect(capital.answer.text).toBe("orchestrate a review of this repo.");
	});

	test("the system prompt lists only the enabled keywords", async () => {
		const { request } = await cast("review this", { kind: "prompt", text: "Review." }, catalogue({ off: ["magicKeywords.jevify"] }));
		expect(request.system).toContain("orchestrate:");
		expect(request.system).not.toContain("jevify");
	});

	for (const off of [["magicKeywords.orchestrate"], ["magicKeywords.enabled"]]) {
		test(`with ${off[0]} off, orchestrate never appears: not asked for, not kept`, async () => {
			const cat = catalogue({ off });
			const description = "get a few agents to review this repo in parallel";
			const { answer, request } = await cast(
				description,
				{ kind: "prompt", text: "orchestrate a review of this repo, then orchestrate the fixes." },
				cat,
			);
			expect(request.system).not.toContain("orchestrate");
			expect(request.user).not.toContain("orchestrate");
			expect(hasKeyword(answer.text, "orchestrate")).toBe(false);
			expect(answer.text).toBe("a review of this repo, then the fixes.");
		});
	}

	test("a negated or ordinary description never gets a keyword forced on", async () => {
		const all = KEYWORDS.map(k => k.word);
		for (const description of [
			"do not use subagents, review the diff myself",
			"review this without sub-agents",
			"don't think hard about this, just rename the variable",
			"run the unit tests in parallel",
			"parallelize the image resize in the build script",
			"some agents are failing the health check",
		]) {
			expect(keywordHints(description, all)).toEqual([]);
		}
		expect(keywordHints("fan the review out to subagents, then think hard about the results", all)).toEqual([
			"ultrathink",
			"orchestrate",
		]);
		const { answer } = await cast("do not use subagents, review the diff myself", { text: "Review the diff yourself." });
		expect(answer.text).toBe("Review the diff yourself.");
	});

	test("keyword boundaries match omp's: code-ish uses are not keywords", () => {
		expect(hasKeyword("please orchestrate this", "orchestrate")).toBe(true);
		expect(hasKeyword("orchestrate.", "orchestrate")).toBe(true);
		for (const text of ["Orchestrate this", "orchestrate()", "src/orchestrate", "orchestrate.ts", "my-orchestrate"]) {
			expect(hasKeyword(text, "orchestrate")).toBe(false);
		}
	});
});

describe("omp commands and settings", () => {
	test("a slash command lands as /<command>, not a prompt", async () => {
		const { answer } = await cast("compact the conversation", { kind: "command", text: "compact" });
		expect(answer).toMatchObject({ kind: "command", text: "/compact", warnings: [] });
		const args = await cast("switch to a cheaper model", { kind: "command", text: "/model haiku" });
		expect(args.answer.text).toBe("/model haiku");
	});

	test("a slash command omp doesn't list lands with a warning", async () => {
		const { answer } = await cast("do the thing", { kind: "command", text: "/frobnicate" });
		expect(answer).toMatchObject({ kind: "command", text: "/frobnicate" });
		expect(answer.warnings).toEqual(["/frobnicate is not a command omp lists here"]);
	});

	test("a setting lands as !omp config set …, with the !", async () => {
		const { answer, request } = await cast("turn off auto compaction", {
			kind: "setting",
			text: "omp config set compaction.enabled false",
		});
		expect(answer).toMatchObject({ kind: "setting", text: "!omp config set compaction.enabled false", warnings: [] });
		expect(request.user).toContain("Matching settings (omp config set <key> <value>):");
		expect(request.user).toContain("- compaction.enabled (boolean, default true): Auto-Compact: Automatically compact");
	});

	test("however the model writes a config line, it lands with one ! and omp in front", async () => {
		for (const reply of [
			{ text: "!omp config set tui.motion false" },
			{ text: "omp config set tui.motion false" },
			{ text: "!!omp config set tui.motion false" },
			{ kind: "setting", text: "config set tui.motion false" },
		]) {
			const { answer } = await cast("stop the animations", reply);
			expect(answer).toMatchObject({ kind: "setting", text: "!omp config set tui.motion false" });
		}
		// A prompt that merely begins with a ! is never left as a shell line.
		const { answer } = await cast("review", { kind: "prompt", text: "!Review the repo" });
		expect(answer).toMatchObject({ kind: "prompt", text: "Review the repo" });
	});

	test("prose that only looks like a config line stays a prompt, never a ! line", async () => {
		const { answer } = await cast("the deploy config", { text: "config set to prod is wrong, fix it" });
		expect(answer).toMatchObject({ kind: "prompt", text: "config set to prod is wrong, fix it" });
	});

	test("a prompt that is really a known slash command lands as the command", async () => {
		const { answer } = await cast("compact but keep the plan", { kind: "prompt", text: "/compact keep the plan" });
		expect(answer).toMatchObject({ kind: "command", text: "/compact keep the plan" });
	});

	test("an empty answer is an error, not an empty composer", async () => {
		await expect(cast("anything", "```\n```")).rejects.toThrow("the model gave no prompt");
		await expect(cast("anything", { kind: "command", text: "/" })).rejects.toThrow("the model gave no prompt");
	});

	test("a setting omp doesn't have lands with a warning", async () => {
		const { answer } = await cast("turn on the frobber", { kind: "setting", text: "omp config set frob.enabled true" });
		expect(answer.text).toBe("!omp config set frob.enabled true");
		expect(answer.warnings).toEqual(["omp has no setting frob.enabled"]);
	});

	test("matching settings: by id and description words, never credentials", () => {
		const cat = catalogue();
		expect(matchSettings(cat.settings, "turn off auto compaction").map(s => s.id)).toEqual([
			"compaction.enabled",
			"compaction.strategy",
		]);
		expect(matchSettings(cat.settings, "rotate the compaction broker token").map(s => s.id)).not.toContain(
			"auth.broker.token",
		);
		expect(matchSettings(cat.settings, "write a haiku")).toEqual([]);
	});
});

describe("the request: catalogue and description only", () => {
	test("with nothing extra to add, the request is the catalogue, then the description", async () => {
		const cat = catalogue();
		const { request } = await cast("write a haiku about rust", { kind: "prompt", text: "Write a haiku." }, cat);
		expect(request.user).toBe(`${cat.render()}\n\nDescription: write a haiku about rust`);
	});

	test("doc pages ride along only when the description names them, at most two", async () => {
		expect(pickDocPages(Object.keys(DOCS), "how does compaction decide what to summarise")).toEqual(["compaction.md"]);
		expect(pickDocPages(Object.keys(DOCS), "which magic keywords fit a big refactor")).toEqual(["magic-keywords.md"]);
		expect(pickDocPages(Object.keys(DOCS), "list the files here")).toEqual([]);
		// "natives" alone picks natives-architecture.md ("architecture" never picks a page by itself).
		expect(pickDocPages(Object.keys(DOCS), "explain the architecture")).toEqual([]);
		expect(pickDocPages(Object.keys(DOCS), "read omp://settings and omp://skills, compaction and magic keywords")).toHaveLength(2);
		const { request } = await cast("how does compaction decide what to summarise", { text: "Explain compaction." });
		expect(request.user).toContain("omp doc omp://compaction.md:\n# Compaction");
	});

	test("the request stays under its cap however big the catalogue and pages are", async () => {
		const huge = catalogue({
			overrides: {
				commands: Array.from({ length: 400 }, (_, i) => ({
					name: `skill:skill-${i}`,
					description: "A long skill description. ".repeat(40),
					source: "skill",
				})),
			},
		});
		const pages = [
			{ name: "settings.md", text: "s".repeat(DOC_PAGE_BYTES) },
			{ name: "skills.md", text: "k".repeat(DOC_PAGE_BYTES) },
		];
		const request = buildPromptRequest({ description: "d ".repeat(5_000), catalogue: huge, pages, settings: huge.settings });
		const size = Buffer.byteLength(request.system) + Buffer.byteLength(request.user);
		expect(size).toBeLessThanOrEqual(PROMPT_REQUEST_BUDGET);
		expect(request.user).toContain("Description: d d");
		expect(request.user).toContain("skill-0");
	});
});

describe("parsing the reply", () => {
	test("JSON, fenced JSON, or bare text as a prompt", () => {
		expect(parsePromptReply('{"kind":"command","text":"/compact","explain":"Compacts."}')).toEqual({
			kind: "command",
			text: "/compact",
			explain: "Compacts.",
		});
		expect(parsePromptReply('```json\n{"kind":"prompt","text":"Hi"}\n```')?.text).toBe("Hi");
		expect(parsePromptReply("Review the repo.")).toEqual({ kind: undefined, text: "Review the repo.", explain: "" });
		expect(parsePromptReply("")).toBeUndefined();
		expect(parsePromptReply('{"kind":"prompt"}')).toBeUndefined();
	});
});
