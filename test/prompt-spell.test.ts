import { describe, expect, test } from "bun:test";
import { buildCatalogue, Catalogue, type CatalogueSources, DOC_PAGE_BYTES, MAX_DOC_PAGES, type DocPage, type SettingEntry } from "../src/catalogue";
import type { DocSummary, OmpMap } from "../src/omp-map";
import {
	buildPickRequest,
	buildPromptRequest,
	buildSettingCheck,
	castPrompt,
	hasKeyword,
	landAnswer,
	MAX_PICK_KEYWORDS,
	MAX_PICK_SETTINGS,
	parsePicks,
	PROMPT_REQUEST_BUDGET,
	parsePromptReply,
	parseSettingCheck,
	type PromptRequest,
} from "../src/prompt-spell";

const INSTALLED = ["kata", "git-workflow-and-versioning", "tarkov-wiki"];
const KEYWORDS = [
	{
		id: "ultrathink",
		word: "ultrathink",
		description: "Make the agent reason deeply before it answers",
		notice: () => "Think hard before answering.",
	},
	{ id: "chillax", word: "chillax", description: "Keep the answer short and low-effort" },
	{
		id: "orchestrate",
		word: "orchestrate",
		description: "Let standalone orchestrate append its hidden multi-agent orchestration notice",
	},
	{ id: "workflow", word: "workflowz", description: "Run the work as a scripted multi-step workflow from the eval kernel" },
	{ id: "jevify", word: "jevify", description: "Classify many items in bulk through the judge" },
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

/** The fixture catalogue with omp's guidance text, and its settings, replaced. */
function withFixture(options: { guidance?: string; settings?: SettingEntry[] } = {}): Catalogue {
	const base = catalogue();
	return new Catalogue(
		base.skills,
		base.commands,
		base.keywords,
		base.docs,
		async name => DOCS[name],
		base.disabledKeywords,
		options.settings ?? base.settings,
		base.keywordInfo,
		options.guidance ?? "",
	);
}

/** omp's map as the fixture catalogue sees it: page summaries, settings, enabled keywords, skills and commands. */
function ompMap(cat: Catalogue = catalogue(), overrides: Partial<OmpMap> = {}): OmpMap {
	return {
		docs: [
			{ name: "compaction.md", title: "Compaction", sentence: "When the context fills, omp summarises older turns." },
			{ name: "magic-keywords.md", title: "Magic keywords", sentence: "Standalone words in a prompt switch a mode on." },
			{ name: "natives-architecture.md", title: "Natives", sentence: "How omp's native helpers are built." },
			{ name: "settings.md", title: "Settings", sentence: "Every setting omp reads from its config." },
			{ name: "skills.md", title: "Skills", sentence: "How skills are found and loaded." },
		],
		settings: cat.settings,
		keywords: cat.keywordInfo,
		skills: cat.skills,
		commands: cat.commands,
		...overrides,
	};
}

const NO_PICKS = JSON.stringify({ docs: [], settings: [], keywords: [] });

/**
 * Run a cast against scripted replies: the first reply answers the pick call, the second the write
 * call. Returns the landed answer and both requests.
 */
async function cast(
	description: string,
	write: unknown,
	cat: Catalogue = catalogue(),
	pick: unknown = NO_PICKS,
	map: OmpMap = ompMap(cat),
	check: unknown = { currentDoes: false, newDoes: true, worse: false },
) {
	const replies = [pick, write, check];
	const requests: PromptRequest[] = [];
	const answer = await castPrompt(
		description,
		cat,
		map,
		async request => {
			requests.push(request);
			const reply = replies.shift();
			return typeof reply === "string" ? reply : JSON.stringify(reply);
		},
		id => cat.settings.some(s => s.id === id),
	);
	expect([2, 3]).toContain(requests.length);
	return { answer, pick: requests[0]!, request: requests[1]!, check: requests[2] };
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

	test("a sentence that names a skill and hedges it is dropped with a warning; the other sentences stay", async () => {
		const { answer } = await cast("file the flaky test", {
			kind: "prompt",
			text: "Read skill://kata first. Read skill://tarkov-wiki only if relevant. Then file the issue.",
		});
		expect(answer).toMatchObject({
			kind: "prompt",
			text: "Read skill://kata first. Then file the issue.",
			warnings: ["dropped a hedged skill mention: skill://tarkov-wiki"],
		});
	});
});

describe("magic keywords come from the first call's picks", () => {
	test("a picked keyword reaches the write call with omp's description, and lands as written", async () => {
		const description = "get a few agents to review this repo in parallel";
		const { answer, pick, request } = await cast(
			description,
			{ kind: "prompt", text: "orchestrate a review of this repo." },
			catalogue(),
			JSON.stringify({ keywords: ["orchestrate"] }),
		);
		expect(pick.user).toContain("- orchestrate: Let standalone orchestrate append its hidden multi-agent orchestration notice");
		expect(request.user).toContain(
			"Magic keywords that fit:\n- orchestrate: Let standalone orchestrate append its hidden multi-agent orchestration notice",
		);
		expect(answer).toMatchObject({ kind: "prompt", text: "orchestrate a review of this repo.", warnings: [] });
		expect(answer.picks).toEqual({ about: "work", docs: [], settings: [], keywords: ["orchestrate"] });
	});

	test("a keyword the first call did not pick is not in the picked block, is offered as other, and is not added", async () => {
		const description = "get a few agents to review this repo in parallel";
		const { answer, request } = await cast(description, { kind: "prompt", text: "Review this repo." });
		expect(request.user).not.toContain("Magic keywords that fit:");
		expect(request.user).toContain("Other magic keywords switched on");
		expect(answer.text).toBe("Review this repo.");
		expect(answer.picks?.keywords).toEqual([]);
	});

	test("a picked keyword is named beside the description, and a capitalised one lands lowercase", async () => {
		const pickReply = JSON.stringify({ keywords: ["orchestrate"] });
		const { answer, request } = await cast(
			"get a few agents to review this repo",
			{ kind: "prompt", text: "Orchestrate the review: split the repo, then report." },
			catalogue(),
			pickReply,
		);
		expect(request.user).toContain('(for example: "orchestrate a review of ...")');
		expect(answer.text).toBe("orchestrate the review: split the repo, then report.");
		// An enabled keyword the first call did not pick is lowercased the same way: omp fires only on the lowercase word.
		const unpicked = await cast("review this repo", { kind: "prompt", text: "Orchestrate the review." });
		expect(unpicked.answer.text).toBe("orchestrate the review.");
	});

	test("a picked keyword with a notice carries the notice to the write call", async () => {
		const { request } = await cast(
			"think hard about the migration",
			{ kind: "prompt", text: "Plan the migration." },
			catalogue(),
			JSON.stringify({ keywords: ["ultrathink"] }),
		);
		expect(request.user).toContain(
			"- ultrathink: Make the agent reason deeply before it answers\n  What it tells the agent: Think hard before answering.",
		);
	});

	test("the write call's system prompt carries no keyword glosses and says to use only the listed keywords", async () => {
		const { request } = await cast("review this", { kind: "prompt", text: "Review." });
		expect(request.system).toContain("Never use a magic keyword that is not listed there.");
		expect(request.system).not.toContain("fanned out to several subagents");
		for (const word of ["orchestrate", "ultrathink", "jevify"]) expect(request.system).not.toContain(word);
	});

	test("with a keyword switched off, it is never picked, offered or kept", async () => {
		for (const off of [["magicKeywords.orchestrate"], ["magicKeywords.enabled"]]) {
			const cat = catalogue({ off });
			const description = "get a few agents to review this repo in parallel";
			const { answer, request } = await cast(
				description,
				{ kind: "prompt", text: "orchestrate a review of this repo, then orchestrate the fixes." },
				cat,
				JSON.stringify({ keywords: ["orchestrate"] }),
			);
			expect(request.system).not.toContain("orchestrate");
			expect(request.user).not.toContain("orchestrate");
			expect(hasKeyword(answer.text, "orchestrate")).toBe(false);
			expect(answer.text).toBe("a review of this repo, then the fixes.");
		}
	});

	test("keyword boundaries match omp's: code-ish uses are not keywords", () => {
		expect(hasKeyword("please orchestrate this", "orchestrate")).toBe(true);
		expect(hasKeyword("orchestrate.", "orchestrate")).toBe(true);
		for (const text of ["Orchestrate this", "orchestrate()", "src/orchestrate", "orchestrate.ts", "my-orchestrate"]) {
			expect(hasKeyword(text, "orchestrate")).toBe(false);
		}
	});

	test("the first call's system prompt says small tasks fit no keyword, and at most one unless each is asked for", () => {
		const { system } = buildPickRequest("review this", ompMap());
		expect(system).toContain("Small single tasks fit no magic keyword.");
		expect(system).toContain("At most one unless the description plainly asks for each.");
	});

	test("the other keywords block lists the enabled keywords the first call did not pick, never the disabled ones", async () => {
		const cat = catalogue({ off: ["magicKeywords.jevify"] });
		const { request } = await cast(
			"get a few agents to review this repo",
			{ kind: "prompt", text: "Review." },
			cat,
			JSON.stringify({ keywords: ["orchestrate"] }),
		);
		const block = (request.user.split("Other magic keywords switched on")[1] ?? "").split("\n\n")[0]!;
		expect(block).toContain(
			"(use one only when you write a prompt for work with parts, kind (c), and what it tells the agent is what the description asks for):\n- ultrathink: Make the agent reason deeply before it answers\n  What it tells the agent: Think hard before answering.\n- chillax: Keep the answer short and low-effort\n- workflowz: Run the work as a scripted multi-step workflow from the eval kernel",
		);
		expect(block).not.toContain("orchestrate");
		expect(block).not.toContain("jevify");
	});

	test("the other keywords block is absent when every enabled keyword is picked, or none is enabled", async () => {
		const allPicked = await cast(
			"get a few agents to think hard about the migration",
			{ kind: "prompt", text: "Plan the migration." },
			catalogue({ off: ["magicKeywords.chillax", "magicKeywords.workflow", "magicKeywords.jevify"] }),
			JSON.stringify({ keywords: ["ultrathink", "orchestrate"] }),
		);
		expect(allPicked.request.user).toContain("Magic keywords that fit:");
		expect(allPicked.request.user).not.toContain("Other magic keywords switched on");
		const noneOn = await cast(
			"get a few agents to think hard about the migration",
			{ kind: "prompt", text: "Plan the migration." },
			catalogue({ off: ["magicKeywords.enabled"] }),
		);
		expect(noneOn.request.user).not.toContain("Other magic keywords switched on");
		expect(noneOn.request.user).not.toContain("When you use a magic keyword");
	});

	test("a capitalised keyword the writer takes from the other block is lowercased; the placement line names the first one", async () => {
		const { answer, request } = await cast(
			"get a few agents to review this repo",
			{ kind: "prompt", text: "Orchestrate the review, then report." },
			catalogue(),
		);
		expect(request.user).toContain("Other magic keywords switched on");
		expect(request.user).not.toContain("Magic keywords that fit:");
		expect(request.user).toContain('(for example: "ultrathink a review of ...")');
		expect(answer.text).toBe("orchestrate the review, then report.");
		expect(answer.warnings).toEqual([]);
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

	test("a setting lands as !omp config set …, with the !, and the picked setting is offered", async () => {
		const { answer, request } = await cast(
			"turn off auto compaction",
			{ kind: "setting", text: "omp config set compaction.enabled false" },
			catalogue(),
			JSON.stringify({ settings: ["compaction.enabled"] }),
		);
		expect(answer).toMatchObject({ kind: "setting", text: "!omp config set compaction.enabled false", warnings: [] });
		expect(request.user).toContain("Settings that may fit (omp config set <id> <value>):");
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

	test("the settings offered are the ones the first call picked, in its order, never credentials or unknown ids", async () => {
		const { request } = await cast(
			"stop the animations and compact early",
			{ kind: "prompt", text: "Stop them." },
			catalogue(),
			JSON.stringify({ settings: ["tui.motion", "auth.broker.token", "compaction.enabled", "nope.id"] }),
		);
		const at = (id: string) => request.user.indexOf(`- ${id} (`);
		expect(at("tui.motion")).toBeGreaterThan(-1);
		expect(at("tui.motion")).toBeLessThan(at("compaction.enabled"));
		expect(request.user).not.toContain("auth.broker.token");
		expect(request.user).not.toContain("nope.id");
	});
});

describe("the two calls: the map, then the picks", () => {
	test("the first call reads omp's map: a page summary and the description, no doc page text", async () => {
		const description = "how does compaction decide what to summarise";
		const { pick } = await cast(description, { text: "Explain compaction." });
		expect(pick.user).toContain("- compaction.md: Compaction. When the context fills, omp summarises older turns.");
		expect(pick.user).toContain("Skills (skill://<name>):");
		expect(pick.user).toContain(`Description: ${description}`);
		expect(pick.user).not.toContain("omp doc omp://");
	});

	test("the picks reach the write call: their page text, setting line and keyword line; not the rest", async () => {
		const cat = catalogue({ off: ["magicKeywords.jevify"] });
		const pick = JSON.stringify({
			docs: ["omp://compaction"],
			settings: ["compaction.enabled", "nope.id"],
			keywords: ["orchestrate", "jevify"],
		});
		const { answer, request } = await cast(
			"get a few agents to review this repo",
			{ kind: "prompt", text: "Review this repo." },
			cat,
			pick,
		);
		expect(request.user).toContain("omp doc omp://compaction.md:\n# Compaction");
		expect(request.user).toContain("- compaction.enabled (boolean, default true): Auto-Compact: Automatically compact");
		expect(request.user).toContain("- orchestrate: Let standalone orchestrate append its hidden multi-agent orchestration notice");
		expect(request.user).not.toContain("nope.id");
		expect(request.user).not.toContain("jevify");
		expect(answer.picks).toEqual({ about: "work", docs: ["compaction.md"], settings: ["compaction.enabled"], keywords: ["orchestrate"] });
	});

	test("a first reply that is not JSON picks nothing, and the write call still runs", async () => {
		const { answer, request } = await cast(
			"how does compaction decide what to summarise",
			{ kind: "prompt", text: "Explain it." },
			catalogue(),
			"The compaction page, I think.",
		);
		expect(answer.picks).toEqual({ about: "work", docs: [], settings: [], keywords: [] });
		expect(answer.text).toBe("Explain it.");
		expect(request.user).not.toContain("omp doc omp://");
	});

	test("doc pages ride along only when the first call picks them, at most three", async () => {
		const { answer, request } = await cast(
			"how does compaction decide what to summarise",
			{ text: "Explain compaction." },
			catalogue(),
			JSON.stringify({
				docs: ["omp://compaction", "compaction.md", "magic-keywords", "natives-architecture", "settings.md", "made-up"],
			}),
		);
		expect(MAX_DOC_PAGES).toBe(3);
		expect(answer.picks?.docs).toEqual(["compaction.md", "magic-keywords.md", "natives-architecture.md"]);
		expect(request.user).toContain("omp doc omp://compaction.md:\n# Compaction");
		expect(request.user.match(/omp doc omp:\/\//g)).toHaveLength(3);
	});

	test("the write call's user carries the description line, and no conversation can enter", async () => {
		const { pick, request } = await cast("write a haiku about rust", { text: "Write a haiku." });
		for (const req of [pick, request]) expect(req.user).toContain("\n\nDescription: write a haiku about rust");
		const none = catalogue({ off: ["magicKeywords.enabled"] });
		const plain = await cast("write a haiku about rust", { kind: "prompt", text: "Write a haiku." }, none);
		expect(plain.request.user).toBe(`${none.render()}\n\nDescription: write a haiku about rust`);
	});

	test("both calls stay under the cap with a 2,000-setting map", async () => {
		const big: SettingEntry[] = Array.from({ length: 2_000 }, (_, i) => ({
			id: `extra.setting${i}`,
			type: "string",
			values: [],
			default: "",
			description: `Tunes part ${i} of the thing. `.repeat(12),
			experimental: false,
			warning: "",
			current: "",
			options: [],
		}));
		const cat = catalogue();
		const picks = JSON.stringify({ settings: big.slice(0, MAX_PICK_SETTINGS).map(s => s.id), docs: ["settings.md", "compaction.md"] });
		const { pick, request } = await cast("d ".repeat(2_000), { text: "Write it." }, cat, picks, ompMap(cat, { settings: big }));
		for (const req of [pick, request]) {
			expect(Buffer.byteLength(req.system) + Buffer.byteLength(req.user)).toBeLessThanOrEqual(PROMPT_REQUEST_BUDGET);
		}
		expect(pick.user).toContain("- extra.setting0 (");
		expect(request.user).toContain("- extra.setting0 (string)");
	});

	test("the write request stays under its cap however big the catalogue and pages are", () => {
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
		const request = buildPromptRequest({
			description: "d ".repeat(5_000),
			catalogue: huge,
			pages,
			settings: huge.settings,
			keywords: huge.keywordInfo,
			otherKeywords: [],
		});
		const size = Buffer.byteLength(request.system) + Buffer.byteLength(request.user);
		expect(size).toBeLessThanOrEqual(PROMPT_REQUEST_BUDGET);
		expect(request.user).toContain("Description: d d");
		expect(request.user).toContain("skill-0");
	});
});

describe("parsing the first reply", () => {
	const cat = catalogue();
	const extra: SettingEntry[] = Array.from({ length: 10 }, (_, i) => ({
		id: `extra.s${i}`,
		type: "boolean",
		values: [],
		default: "",
		description: "",
		experimental: false,
		warning: "",
		current: "",
		options: [],
	}));
	const map = ompMap(cat, { settings: [...cat.settings, ...extra] });

	test("docs are normalised, kept only when in the map, deduped and capped at three", () => {
		const picks = parsePicks(
			JSON.stringify({
				docs: ["made-up", "omp://compaction", "compaction.md", "magic-keywords", "natives-architecture", "settings.md"],
			}),
			map,
		);
		expect(picks.docs).toEqual(["compaction.md", "magic-keywords.md", "natives-architecture.md"]);
	});

	test("settings are capped at MAX_PICK_SETTINGS, keywords and settings are deduped and checked against the map", () => {
		const capped = parsePicks(JSON.stringify({ settings: map.settings.map(s => s.id) }), map);
		expect(capped.settings).toEqual(map.settings.slice(0, MAX_PICK_SETTINGS).map(s => s.id));
		expect(capped.settings).toHaveLength(MAX_PICK_SETTINGS);
		expect(
			parsePicks(
				JSON.stringify({
					settings: ["compaction.enabled", "compaction.enabled", "nope.id", "tui.motion"],
					keywords: ["orchestrate", "orchestrate", "nope"],
					docs: ["compaction", "compaction.md"],
				}),
				map,
			),
		).toEqual({ about: "work", docs: ["compaction.md"], settings: ["compaction.enabled", "tui.motion"], keywords: ["orchestrate"] });
	});

	test("fenced or bare JSON parses; no JSON picks nothing", () => {
		expect(parsePicks('```json\n{"keywords":["orchestrate"]}\n```', map).keywords).toEqual(["orchestrate"]);
		expect(parsePicks('Sure: {"docs":["settings"]} done', map).docs).toEqual(["settings.md"]);
		expect(parsePicks("no json here", map)).toEqual({ about: "work", docs: [], settings: [], keywords: [] });
	});

	test("at most MAX_PICK_KEYWORDS keywords are picked, in the order the first call gave them", () => {
		expect(MAX_PICK_KEYWORDS).toBe(2);
		expect(map.keywords.map(k => k.word)).toEqual(expect.arrayContaining(["ultrathink", "orchestrate", "jevify"]));
		expect(parsePicks(JSON.stringify({ keywords: ["ultrathink", "orchestrate", "jevify"] }), map).keywords).toEqual([
			"ultrathink",
			"orchestrate",
		]);
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

describe("the writer gets omp's guidance, and the keyword and setting rules", () => {
	const GUIDANCE = "A task with parts that do not depend on each other can be split across agents; one small change is done alone.";
	const EXPERIMENTAL: SettingEntry = {
		id: "compaction.experimentalContextManagement",
		type: "boolean",
		values: [],
		default: "false",
		description: "Notes-backed context windows (experimental)",
		experimental: true,
		warning: "",
		current: "true",
		options: [],
	};
	const RISKY: SettingEntry = {
		id: "thinking.external",
		type: "boolean",
		values: [],
		default: "false",
		description: "Send thinking outside omp",
		experimental: false,
		warning: "Thinking text leaves this machine.",
		current: "",
		options: [],
	};
	const STRATEGY: SettingEntry = {
		id: "compaction.strategy",
		type: "enum",
		values: ["summary", "drop"],
		default: '"summary"',
		description: "How to compact",
		experimental: false,
		warning: "",
		current: '"drop"',
		options: [],
	};
	const STABLE: SettingEntry = {
		id: "tui.motion",
		type: "boolean",
		values: [],
		default: "true",
		description: "Animate the interface",
		experimental: false,
		warning: "",
		current: "",
		options: [],
	};

	/** The explain line `landAnswer` gives a `setting` answer naming `setting` at `value`, given the model's `explain`. */
	async function explainFor(setting: SettingEntry, explain: string, value = "true"): Promise<string> {
		const cat = withFixture({ settings: [setting] });
		return landAnswer({ kind: "setting", text: `omp config set ${setting.id} ${value}`, explain }, cat, () => true).explain;
	}

	test("the write call carries omp's guidance before the description, and only when there is some", async () => {
		const header = "How omp's agent judges a prompt (omp's own instructions: use them to judge how much to write, never copy them into the prompt):";
		const { request } = await cast("review every file for bugs at once", { kind: "prompt", text: "Review." }, withFixture({ guidance: GUIDANCE }));
		expect(request.user).toContain(`${header}\n${GUIDANCE}`);
		expect(request.user.indexOf(header)).toBeLessThan(request.user.indexOf("Description: review every file"));
		const plain = await cast("review every file for bugs at once", { kind: "prompt", text: "Review." });
		expect(plain.request.user).not.toContain("How omp's agent judges a prompt");
	});

	test("the guidance survives the cap: pages and catalogue give way first", () => {
		const huge = new Catalogue(
			Array.from({ length: 400 }, (_, i) => ({ name: `skill-${i}`, description: "A long skill description. ".repeat(40) })),
			[],
			[],
			[],
			async name => DOCS[name],
			[],
			[],
			[],
			GUIDANCE,
		);
		const request = buildPromptRequest({
			description: "d ".repeat(5_000),
			catalogue: huge,
			pages: [{ name: "settings.md", text: "s".repeat(DOC_PAGE_BYTES) }],
			settings: [],
			keywords: [],
			otherKeywords: [],
		});
		expect(Buffer.byteLength(request.system) + Buffer.byteLength(request.user)).toBeLessThanOrEqual(PROMPT_REQUEST_BUDGET);
		expect(request.user).toContain(GUIDANCE);
		expect(request.user).toContain("Description: d d");
		expect(request.user).toContain("skill-0");
	});

	test("the write call's system prompt gives the two shapes of prompt and the small-work rule", async () => {
		const { request } = await cast("review every file", { kind: "prompt", text: "Review." }, withFixture({ guidance: GUIDANCE }));
		for (const part of ["(1) the goal", "(2) the scope", "(3) how it splits", "(4) what done looks like"]) {
			expect(request.system).toContain(part);
		}
		expect(request.system).toContain("Small work (one file, a quick fix, a question): one or two sentences");
		expect(request.system).toContain("never inventing paths, files or requirements");
		expect(request.system).toContain("How omp's agent judges a prompt");
	});

	test("keywords are placed inside a sentence: the system prompt says so and the old appended line is gone", async () => {
		const { request } = await cast(
			"get a few agents to review this repo",
			{ kind: "prompt", text: "Review." },
			catalogue(),
			JSON.stringify({ keywords: ["orchestrate"] }),
		);
		expect(request.system).toContain("never alone at the end, never as a label");
		expect(request.user).not.toContain("use these magic keywords in it");
		expect(request.user).toContain("never alone at the end or as a label.");
		expect(request.user).toContain('(for example: "Use orchestrate to ...")');
	});

	test("settings marked experimental or with a risk show their markers and current value to the writer", async () => {
		const cat = withFixture({ settings: [EXPERIMENTAL, RISKY] });
		const { pick, request } = await cast(
			"keep notes across long chats",
			{ kind: "prompt", text: "Explain the notes option." },
			cat,
			JSON.stringify({ settings: [EXPERIMENTAL.id, RISKY.id] }),
		);
		expect(request.user).toContain(
			"- compaction.experimentalContextManagement (boolean, default false) [experimental]: Notes-backed context windows (experimental) (currently true)",
		);
		expect(request.user).toContain(
			"- thinking.external (boolean, default false): Send thinking outside omp Risk: Thinking text leaves this machine.",
		);
		expect(request.system).toContain("prefer a stable setting");
		expect(request.system).toContain("explain must say it is experimental or state the risk");
		expect(pick.system).toContain("picked only when nothing stable fits");
	});

	test("an experimental setting's explain says so once, and says how to undo it", async () => {
		expect(await explainFor(EXPERIMENTAL, "Turns notes off.", "false")).toBe(
			"Experimental setting: Turns notes off. To undo: !omp config set compaction.experimentalContextManagement true",
		);
		expect(await explainFor(EXPERIMENTAL, "Turns the experimental notes off.", "false")).toBe(
			"Turns the experimental notes off. To undo: !omp config set compaction.experimentalContextManagement true",
		);
	});

	test("a risk note is appended to the explain unless it is already there", async () => {
		expect(await explainFor(RISKY, "Turns it on.")).toBe("Turns it on. omp warns: Thinking text leaves this machine.");
		expect(await explainFor(RISKY, "Turns it on. omp warns: Thinking text leaves this machine.")).toBe(
			"Turns it on. omp warns: Thinking text leaves this machine.",
		);
	});

	test("a setting with a current value says how to undo it, the value as plain text", async () => {
		expect(await explainFor(STRATEGY, "Compacts by summary.")).toBe(
			"Compacts by summary. To undo: !omp config set compaction.strategy drop",
		);
	});

	test("a stable setting with no current value gets nothing added to its explain", async () => {
		expect(await explainFor(STABLE, "Turns animations off.")).toBe("Turns animations off.");
	});

	test("the write call's system prompt has the decision order, the compact rule, and the do-no-more and never-copy rules", async () => {
		const { request } = await cast("compact the conversation", { kind: "command", text: "compact" });
		for (const part of [
			"Decide in this order:",
			'"compact the conversation" is /compact',
			"prefer a stable setting",
			"do exactly what was asked and no more",
			"do not ask to fix",
			"never copy its instructions into the prompt",
		]) {
			expect(request.system).toContain(part);
		}
	});

	test("the model's own undo clause is stripped, and Spellbook's undo line is appended once", async () => {
		expect(await explainFor(STRATEGY, "Compacts by summary. To undo: !omp config set compaction.strategy summary")).toBe(
			"Compacts by summary. To undo: !omp config set compaction.strategy drop",
		);
		expect(await explainFor(STRATEGY, "Turns it back; to undo later, set compaction.strategy to summary.")).toBe(
			"Turns it back. To undo: !omp config set compaction.strategy drop",
		);
		expect(await explainFor(STRATEGY, "Adds a key to undo the last edit.")).toBe(
			"Adds a key to undo the last edit. To undo: !omp config set compaction.strategy drop",
		);
	});

	test("a picked keyword tacked on alone at the end is kept and warned about; one placed in a sentence is not", async () => {
		const pick = JSON.stringify({ keywords: ["orchestrate"] });
		const tacked = await cast(
			"get a few agents to review this repo",
			{ kind: "prompt", text: "Review this repo. orchestrate." },
			catalogue(),
			pick,
		);
		expect(tacked.answer.text).toBe("Review this repo. orchestrate.");
		expect(tacked.answer.warnings).toEqual(["orchestrate was tacked on at the end"]);
		const inside = await cast(
			"get a few agents to review this repo",
			{ kind: "prompt", text: "Review this repo, then orchestrate the fixes." },
			catalogue(),
			pick,
		);
		expect(inside.answer.warnings).toEqual([]);
	});

	test("an experimental setting the write call picks lands as a prompt asking omp about it, never as a switch", async () => {
		const { answer } = await cast(
			"stop it forgetting stuff in long chats",
			{ kind: "setting", text: "omp config set compaction.experimentalContextManagement false", explain: "Turns notes off." },
			withFixture({ settings: [EXPERIMENTAL] }),
			JSON.stringify({ settings: [EXPERIMENTAL.id] }),
		);
		expect(answer).toEqual({
			kind: "prompt",
			text: `Explain omp's experimental compaction.experimentalContextManagement setting: what setting it to false changes, whether it helps with "stop it forgetting stuff in long chats", and how to change it back.`,
			explain:
				"compaction.experimentalContextManagement is experimental, so this asks omp about it instead of switching it on. To switch it yourself: !omp config set compaction.experimentalContextManagement false",
			warnings: ["compaction.experimentalContextManagement is experimental: asking about it instead"],
			picks: { about: "work", docs: [], settings: [EXPERIMENTAL.id], keywords: [] },
		});
	});

	test("a Risk-noted setting re-lands the same way, with risk wording and the description's quotes made single", async () => {
		const { answer } = await cast(
			'send "my" thinking elsewhere',
			{ kind: "setting", text: "omp config set thinking.external true", explain: "Turns it on." },
			withFixture({ settings: [RISKY] }),
			JSON.stringify({ settings: [RISKY.id] }),
		);
		expect(answer).toEqual({
			kind: "prompt",
			text: `Explain omp's thinking.external setting: what setting it to true changes, whether it helps with "send 'my' thinking elsewhere", and how to change it back.`,
			explain:
				"thinking.external has a risk note; omp warns: Thinking text leaves this machine, so this asks omp about it instead of switching it on. To switch it yourself: !omp config set thinking.external true",
			warnings: ["thinking.external has a risk note: asking about it instead"],
			picks: { about: "work", docs: [], settings: [RISKY.id], keywords: [] },
		});
	});

	test("a stable setting is not re-landed: it stays the one-Enter config line", async () => {
		const { answer } = await cast(
			"stop the animations",
			{ kind: "setting", text: "omp config set tui.motion false" },
			withFixture({ settings: [STABLE] }),
			JSON.stringify({ settings: [STABLE.id] }),
		);
		expect(answer).toMatchObject({ kind: "setting", text: "!omp config set tui.motion false", warnings: [] });
	});

	test("the placement line makes the picked keyword the main verb of the first sentence, and says what to avoid", async () => {
		const { request } = await cast(
			"get a few agents to review this repo",
			{ kind: "prompt", text: "Review." },
			catalogue(),
			JSON.stringify({ keywords: ["orchestrate"] }),
		);
		expect(request.user).toContain(
			`When you use a magic keyword in a prompt, make one the main verb of the prompt's first sentence when it reads as a verb (for example: "orchestrate a review of ...")`,
		);
		expect(request.user).toContain('(for example: "Use orchestrate to ...")');
		expect(request.user).toContain("never only in a last sentence after the first");
	});

	test("a picked keyword only in a last sentence after the first is warned about; one in the first sentence is not", async () => {
		const pick = JSON.stringify({ keywords: ["orchestrate"] });
		const late = await cast(
			"get a few agents to review this repo",
			{ kind: "prompt", text: "Review the repo. Then orchestrate the fixes." },
			catalogue(),
			pick,
		);
		expect(late.answer.warnings).toEqual(["orchestrate appears only in the last sentence"]);
		const early = await cast(
			"get a few agents to review this repo",
			{ kind: "prompt", text: "Orchestrate the review. Then report the fixes." },
			catalogue(),
			pick,
		);
		expect(early.answer.text).toBe("orchestrate the review. Then report the fixes.");
		expect(early.answer.warnings).toEqual([]);
	});
});

describe("a setting answer is checked against omp's own descriptions", () => {
	const APPROVAL: SettingEntry = {
		id: "tools.approvalMode",
		type: "enum",
		values: ["always-ask", "write", "yolo"],
		default: '"always-ask"',
		description: "When to ask before a tool runs",
		experimental: false,
		warning: "",
		current: '"yolo"',
		options: [
			{ value: "always-ask", description: "Auto-approve read-only tools; require confirmation for write and exec tools." },
			{ value: "write", description: "Auto-approve reads and writes; require confirmation for exec tools." },
			{ value: "yolo", description: "auto-approves all tiers" },
		],
	};
	const MOTION: SettingEntry = {
		id: "tui.motion",
		type: "boolean",
		values: [],
		default: "true",
		description: "Animate the interface",
		experimental: false,
		warning: "",
		current: "true",
		options: [],
	};
	const STRATEGY: SettingEntry = {
		id: "compaction.strategy",
		type: "enum",
		values: ["summary", "drop"],
		default: '"summary"',
		description: "How to compact",
		experimental: false,
		warning: "",
		current: '"drop"',
		options: [],
	};
	const RISKY: SettingEntry = {
		id: "thinking.external",
		type: "boolean",
		values: [],
		default: "false",
		description: "Send thinking outside omp",
		experimental: false,
		warning: "Thinking text leaves this machine.",
		current: "",
		options: [],
	};
	const ASKED = "make the agent stop asking me before it edits files";

	test("a setting already at the requested value lands as a prompt asking omp, with no config line and no check", async () => {
		const { answer, check } = await cast(
			ASKED,
			{ kind: "setting", text: "omp config set tools.approvalMode yolo", explain: "Keeps yolo mode." },
			withFixture({ settings: [APPROVAL] }),
		);
		expect(answer).toEqual({
			kind: "prompt",
			text: `Explain which omp setting or feature helps with "${ASKED}", what it changes, and how to turn it on and off.`,
			explain: "tools.approvalMode is already yolo, so changing it would do nothing; this asks omp instead.",
			warnings: ["tools.approvalMode is already yolo"],
			picks: { about: "work", docs: [], settings: [], keywords: [] },
		});
		expect(answer.text).not.toContain("config set");
		expect(check).toBeUndefined();
	});

	test("a switch the check says does not do what was asked re-lands as a prompt, with the why in the explain", async () => {
		const { answer, check } = await cast(
			ASKED,
			{ kind: "setting", text: "omp config set tools.approvalMode write", explain: "Asks before writes." },
			withFixture({ settings: [APPROVAL] }),
			undefined,
			undefined,
			{ currentDoes: true, newDoes: true, worse: true, why: "yolo already auto-approves everything, and write makes shell commands ask." },
		);
		expect(answer).toEqual({
			kind: "prompt",
			text: `Explain which omp setting or feature helps with "${ASKED}", what it changes, and how to turn it on and off.`,
			explain:
				"Spellbook checked !omp config set tools.approvalMode write against your current value (yolo): yolo already auto-approves everything, and write makes shell commands ask. So this asks omp instead.",
			warnings: ["tools.approvalMode write would not do what you asked"],
			picks: { about: "work", docs: [], settings: [], keywords: [] },
		});
		expect(check?.system).toContain("Reply with JSON only");
	});

	test("a check reply with no verdict counts as a no, and the explain says so", async () => {
		const { answer } = await cast(
			"stop the animations",
			{ kind: "setting", text: "omp config set tui.motion false" },
			withFixture({ settings: [MOTION] }),
			undefined,
			undefined,
			"I think so",
		);
		expect(answer).toMatchObject({
			kind: "prompt",
			explain:
				"Spellbook checked !omp config set tui.motion false against your current value (true): it would not do what the description asks. So this asks omp instead.",
			warnings: ["tui.motion false would not do what you asked"],
		});
	});

	test("a switch the check says does what was asked lands as the config line, its undo line using the current value", async () => {
		const { answer, check } = await cast(
			"keep the summaries short",
			{ kind: "setting", text: "omp config set compaction.strategy summary", explain: "Compacts by summary." },
			withFixture({ settings: [STRATEGY] }),
			undefined,
			undefined,
			{ currentDoes: false, newDoes: true, worse: false, why: "summary is the other way to compact." },
		);
		expect(answer).toMatchObject({
			kind: "setting",
			text: "!omp config set compaction.strategy summary",
			explain: "Compacts by summary. To undo: !omp config set compaction.strategy drop",
			warnings: [],
		});
		expect(check).toBeDefined();
	});

	test("the check request carries every option's description, the current and new values, and the description", async () => {
		const { check } = await cast(ASKED, { kind: "setting", text: "omp config set tools.approvalMode write" }, withFixture({ settings: [APPROVAL] }));
		expect(check).toBeDefined();
		for (const option of APPROVAL.options) expect(check!.user).toContain(`${option.value}: ${option.description}`);
		expect(check!.user).toContain(
			'- tools.approvalMode (enum one of always-ask|write|yolo, default "always-ask"): When to ask before a tool runs (currently "yolo")',
		);
		expect(check!.user).toContain(
			`\nCurrent value: yolo — auto-approves all tiers\nNew value: write — Auto-approve reads and writes; require confirmation for exec tools.\nDescription: ${ASKED}`,
		);
	});

	test("a setting with no current value is checked as unknown, with its default; a boolean's values read on and off", () => {
		const request = buildSettingCheck("stop the animations", { ...MOTION, current: "" }, "false");
		expect(request.user).toContain(
			"Current value: unknown (default true — on: Animate the interface)\nNew value: false — off: Animate the interface\nDescription: stop the animations",
		);
	});

	test("a boolean check request shows what on and off mean, from the setting's own description", () => {
		const compaction: SettingEntry = {
			...MOTION,
			id: "compaction.enabled",
			description: "Auto-Compact: Automatically compact context when it gets too large",
			current: "true",
		};
		const request = buildSettingCheck("turn off auto compaction", compaction, "false");
		expect(request.user).toContain(
			"Current value: true — on: Auto-Compact: Automatically compact context when it gets too large\nNew value: false — off: Auto-Compact: Automatically compact context when it gets too large\nDescription: turn off auto compaction",
		);
	});

	test("the check's system text asks for the why first, then the three judgements, with their definitions", () => {
		const { system } = buildSettingCheck("turn off auto compaction", MOTION, "false");
		expect(system.indexOf('"why"')).toBeGreaterThan(-1);
		expect(system.indexOf('"why"')).toBeLessThan(system.indexOf('"currentDoes"'));
		expect(system).toContain(
			'{"why": "<one or two short sentences: what the current value does, what the new value does>", "currentDoes": true|false, "newDoes": true|false, "worse": true|false}',
		);
		expect(system).toContain('(for "turn X off", a value that turns X off does)');
		expect(system).toContain("(for example more confirmations). Effects that follow directly from doing exactly what was asked are not worse.");
	});

	test("a current value omp does not say is shown with the default's option description", () => {
		const request = buildSettingCheck(ASKED, { ...APPROVAL, current: "" }, "write");
		expect(request.user).toContain(
			"Current value: unknown (default always-ask — Auto-approve read-only tools; require confirmation for write and exec tools.)\nNew value: write — Auto-approve reads and writes; require confirmation for exec tools.\n",
		);
	});

	test("the writer's setting line lists each option with its description under the setting", async () => {
		const { request } = await cast(
			ASKED,
			{ kind: "prompt", text: "Review." },
			withFixture({ settings: [APPROVAL] }),
			JSON.stringify({ settings: [APPROVAL.id] }),
		);
		expect(request.user).toContain(
			'(currently "yolo")\n    always-ask: Auto-approve read-only tools; require confirmation for write and exec tools.\n    write: Auto-approve reads and writes; require confirmation for exec tools.\n    yolo: auto-approves all tiers',
		);
	});

	test("a prompt answer, a risky setting and a setting omp does not have make no check call", async () => {
		expect((await cast("review the repo", { kind: "prompt", text: "Review the repo." })).check).toBeUndefined();
		const risky = await cast("send my thinking elsewhere", { kind: "setting", text: "omp config set thinking.external true" }, withFixture({ settings: [RISKY] }));
		expect(risky.check).toBeUndefined();
		expect(risky.answer.text).toMatch(/^Explain omp's thinking\.external setting/);
		const unknown = await cast("turn on the frobber", { kind: "setting", text: "omp config set frob.enabled true" });
		expect(unknown.check).toBeUndefined();
		expect(unknown.answer.text).toBe("!omp config set frob.enabled true");
	});

	test("the writer's rules say never to escalate the user's words, and how a setting answer is judged", async () => {
		const { request } = await cast("tidy the tests", { kind: "prompt", text: "Tidy the tests." });
		expect(request.system).toContain("Never escalate the user's words: a mess is tidied, not rewritten; check is not fix.");
		expect(request.system).toContain("judged by omp's description of the setting and of each value");
		expect(request.system).toContain("or the setting is about a different feature than the one described");
	});
});

describe("parsing the setting check", () => {
	test("the reply's currentDoes, newDoes and worse are read as they are; the why kept as one line", () => {
		expect(parseSettingCheck('{"currentDoes": false, "newDoes": true, "worse": false, "why": "Moves it to write."}')).toEqual({
			does: true,
			why: "Moves it to write.",
		});
		expect(parseSettingCheck('```json\n{"currentDoes": true, "newDoes": true, "worse": false, "why": "yolo  already\\tdoes it."}\n```')).toEqual({
			does: false,
			why: "yolo already does it.",
		});
		expect(parseSettingCheck('Sure: {"currentDoes": false, "newDoes": true, "worse": false, "why": "Yes."} done')).toEqual({
			does: true,
			why: "Yes.",
		});
	});

	test("only currentDoes false, newDoes true and worse false is a yes; the other seven combinations are no", () => {
		for (const currentDoes of [true, false]) {
			for (const newDoes of [true, false]) {
				for (const worse of [true, false]) {
					const reply = JSON.stringify({ currentDoes, newDoes, worse, why: "x" });
					expect(parseSettingCheck(reply).does).toBe(!currentDoes && newDoes && !worse);
				}
			}
		}
	});

	test("a missing or non-boolean field is a no", () => {
		expect(parseSettingCheck('{"newDoes": true, "worse": false}').does).toBe(false);
		expect(parseSettingCheck('{"currentDoes": false, "newDoes": true}').does).toBe(false);
		expect(parseSettingCheck('{"currentDoes": "false", "newDoes": true, "worse": false}').does).toBe(false);
		expect(parseSettingCheck('{"currentDoes": false, "newDoes": "true", "worse": false}').does).toBe(false);
	});

	test("no JSON, or an empty reply, is a no with no reason", () => {
		expect(parseSettingCheck("no json here")).toEqual({ does: false, why: "" });
		expect(parseSettingCheck("")).toEqual({ does: false, why: "" });
	});
});

describe("the setting check sees the docs that name the setting, and the picked pages", () => {
	const COMPACTION: SettingEntry = {
		id: "compaction.enabled",
		type: "boolean",
		values: [],
		default: "true",
		description: "Auto-Compact: Automatically compact context when it gets too large",
		experimental: false,
		warning: "",
		current: "true",
		options: [],
	};
	const PAGES: DocPage[] = [
		{ name: "compaction.md", text: "Intro about compaction.\n\nThe compaction.enabled setting turns it off.\n\nUnrelated paragraph." },
		{ name: "memory.md", text: "The memory.backend table:\n\n| memory.backend | local |\n\nNothing here." },
	];

	test("the check carries only the paragraphs that name the setting, each under its page", () => {
		const request = buildSettingCheck("turn off auto compaction", COMPACTION, "false", PAGES);
		expect(request.user).toContain(
			"What omp's docs say about this setting:\nomp://compaction.md:\nThe compaction.enabled setting turns it off.",
		);
		expect(request.user).not.toContain("Intro about compaction.");
		expect(request.user).not.toContain("Unrelated paragraph.");
		expect(request.user).not.toContain("memory.backend");
	});

	test("the docs block is capped at 4,000 bytes, whole paragraphs only", () => {
		const long = (i: number) => `compaction.enabled ${i} ${"x".repeat(1_400)}`;
		const pages: DocPage[] = [{ name: "compaction.md", text: [0, 1, 2].map(long).join("\n\n") }];
		const request = buildSettingCheck("turn off auto compaction", COMPACTION, "false", pages);
		const block = request.user.slice(request.user.indexOf("What omp's docs say about this setting:"));
		expect(Buffer.byteLength(block)).toBeLessThanOrEqual(4_000);
		expect(block).toContain(long(0));
		expect(block).toContain(long(1));
		expect(block).not.toContain("compaction.enabled 2 ");
	});

	test("the picked doc pages are listed by name, title and first sentence; no docs block without a paragraph naming the setting", () => {
		const summaries: DocSummary[] = [
			{ name: "compaction.md", title: "Compaction", sentence: "When the context fills, omp summarises older turns." },
		];
		const request = buildSettingCheck("turn off auto compaction", COMPACTION, "false", [], summaries);
		expect(request.user).toContain(
			"\nDescription: turn off auto compaction\nPicked doc pages:\n- compaction.md: Compaction. When the context fills, omp summarises older turns.",
		);
		expect(request.user).not.toContain("What omp's docs say");
	});

	test("castPrompt gives the check the summaries of the pages the first call picked", async () => {
		const cat = withFixture({ settings: [COMPACTION] });
		const { check } = await cast(
			"turn off auto compaction",
			{ kind: "setting", text: "!omp config set compaction.enabled false" },
			cat,
			JSON.stringify({ docs: ["compaction.md"], settings: ["compaction.enabled"], keywords: [] }),
		);
		expect(check!.user).toContain("Picked doc pages:\n- compaction.md: Compaction. When the context fills, omp summarises older turns.");
	});

	test("the check's system text says a description about another feature is a no, and names no feature", () => {
		const { system } = buildSettingCheck("turn off auto compaction", COMPACTION, "false");
		expect(system).toContain(
			"If omp's docs or the picked pages show the description is about a different feature than this setting, newDoes is false.",
		);
		expect(system).not.toMatch(/compaction|memory/i);
	});

	test("worse counts only what the description did not ask about; the effects that follow from the request do not", () => {
		const { system } = buildSettingCheck("turn off auto compaction", COMPACTION, "false");
		expect(system).toContain(
			"worse is true when the new value also changes something else the description did not ask about (for example more confirmations).",
		);
		expect(system).toContain("Effects that follow directly from doing exactly what was asked are not worse.");
	});
});

describe("a question about omp itself gets a template, not a repo task", () => {
	const FORGET = "stop it forgetting stuff in long chats";
	const ON: SettingEntry = {
		id: "compaction.enabled",
		type: "boolean",
		values: [],
		default: "true",
		description: "Auto-Compact: Automatically compact context when it gets too large",
		experimental: false,
		warning: "",
		current: "true",
		options: [],
	};
	const TOGGLE: SettingEntry = {
		id: "compaction.experimentalContextManagement",
		type: "boolean",
		values: [],
		default: "false",
		description: "Experimental context notes",
		experimental: true,
		warning: "",
		current: "false",
		options: [],
	};
	const LINE = "This description is about omp itself: answer with a command, a setting, or a short prompt asking omp to explain the feature; never a task on the user's project.";

	test("parsePicks reads about as omp only when the reply says exactly omp; anything else is work", () => {
		const map = ompMap();
		expect(parsePicks('{"about":"omp"}', map).about).toBe("omp");
		expect(parsePicks('{"about":"work"}', map).about).toBe("work");
		expect(parsePicks('{"keywords":["orchestrate"]}', map).about).toBe("work");
		for (const junk of ['{"about":"Omp"}', '{"about":true}', '{"about":["omp"]}', "no json here", ""]) {
			expect(parsePicks(junk, map).about).toBe("work");
		}
	});

	test("the pick call asks for about first, and says what omp itself covers", () => {
		const { system } = buildPickRequest(FORGET, ompMap());
		expect(system).toContain('"about" is "omp" when the description asks to change or understand how omp itself behaves');
		expect(system).toContain('{"about": "omp" or "work", "keywords"');
	});

	test("an omp prompt is replaced by the template, with at most two picked pages as omp:// links", async () => {
		const { answer } = await cast(
			FORGET,
			{ kind: "prompt", text: "Find out why the chat loses earlier context and fix it." },
			catalogue(),
			JSON.stringify({ about: "omp", docs: ["compaction.md", "settings.md", "magic-keywords.md"] }),
		);
		expect(answer).toEqual({
			kind: "prompt",
			text: `Explain how omp handles "${FORGET}": which feature or setting covers it (see omp://compaction.md, omp://settings.md), what it changes, and how I turn it on or off.`,
			explain: "This is about omp itself, so it asks omp to explain the feature instead of changing your project.",
			warnings: ["about omp: asking omp to explain"],
			picks: { about: "omp", docs: ["compaction.md", "settings.md", "magic-keywords.md"], settings: [], keywords: [] },
		});
	});

	test("with no picked page the template has no see-clause; the description is collapsed and its double quotes become single ones", async () => {
		const { answer } = await cast(
			'stop   it "forgetting"\n stuff',
			{ kind: "prompt", text: "Find out why." },
			catalogue(),
			JSON.stringify({ about: "omp" }),
		);
		expect(answer.text).toBe(
			"Explain how omp handles \"stop it 'forgetting' stuff\": which feature or setting covers it, what it changes, and how I turn it on or off.",
		);
	});

	test("a command, a setting, and a prompt about the user's work are left alone", async () => {
		const about = JSON.stringify({ about: "omp" });
		const command = await cast("compact the conversation", { kind: "command", text: "compact" }, catalogue(), about);
		expect(command.answer).toMatchObject({ kind: "command", text: "/compact" });
		const setting = await cast("stop the animations", { kind: "setting", text: "omp config set tui.motion false" }, catalogue(), about);
		expect(setting.answer).toMatchObject({ kind: "setting", text: "!omp config set tui.motion false" });
		const work = await cast("tidy the tests", { kind: "prompt", text: "Tidy the tests." }, catalogue(), JSON.stringify({ about: "work" }));
		expect(work.answer).toMatchObject({ kind: "prompt", text: "Tidy the tests.", warnings: [] });
	});

	test("a Spellbook re-land is not replaced again: an already-set switch and an experimental one keep their own text", async () => {
		const already = await cast(
			FORGET,
			{ kind: "setting", text: "omp config set compaction.enabled true" },
			withFixture({ settings: [ON] }),
			JSON.stringify({ about: "omp" }),
		);
		expect(already.answer.text).toMatch(/^Explain which omp setting or feature helps with/);
		expect(already.answer.warnings).toContain("compaction.enabled is already true");
		const risky = await cast(
			FORGET,
			{ kind: "setting", text: "omp config set compaction.experimentalContextManagement true" },
			withFixture({ settings: [TOGGLE] }),
			JSON.stringify({ about: "omp" }),
		);
		expect(risky.answer.text).toMatch(/^Explain omp's experimental/);
		expect(risky.answer.warnings).toEqual(["compaction.experimentalContextManagement is experimental: asking about it instead"]);
	});

	test("the writer gets the about-omp line, before the description, only when about is omp", () => {
		const packet = { description: FORGET, catalogue: catalogue(), pages: [], settings: [], keywords: [], otherKeywords: [] };
		const withOmp = buildPromptRequest({ ...packet, about: "omp" }).user;
		expect(withOmp).toContain(LINE);
		expect(withOmp.indexOf(LINE)).toBeLessThan(withOmp.indexOf(`Description: ${FORGET}`));
		expect(buildPromptRequest({ ...packet, about: "work" }).user).not.toContain("This description is about omp itself");
		expect(buildPromptRequest(packet).user).not.toContain("This description is about omp itself");
	});
});

