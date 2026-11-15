import { describe, expect, test } from "bun:test";
import { buildCatalogue, Catalogue, type CatalogueSources, DOC_PAGE_BYTES, MAX_DOC_PAGES, type SettingEntry } from "../src/catalogue";
import type { OmpMap } from "../src/omp-map";
import {
	buildPickRequest,
	buildPromptRequest,
	castPrompt,
	hasKeyword,
	landAnswer,
	MAX_PICK_KEYWORDS,
	MAX_PICK_SETTINGS,
	parsePicks,
	PROMPT_REQUEST_BUDGET,
	parsePromptReply,
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
) {
	const replies = [pick, write];
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
	expect(requests).toHaveLength(2);
	return { answer, pick: requests[0]!, request: requests[1]! };
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
		expect(answer.picks).toEqual({ docs: [], settings: [], keywords: ["orchestrate"] });
	});

	test("a keyword the first call did not pick is neither offered nor added", async () => {
		const description = "get a few agents to review this repo in parallel";
		const { answer, request } = await cast(description, { kind: "prompt", text: "Review this repo." });
		expect(request.user).not.toContain("Magic keywords that fit:");
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
		// Unpicked, the same capitalised word is left alone.
		const unpicked = await cast("review this repo", { kind: "prompt", text: "Orchestrate the review." });
		expect(unpicked.answer.text).toBe("Orchestrate the review.");
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
		expect(answer.picks).toEqual({ docs: ["compaction.md"], settings: ["compaction.enabled"], keywords: ["orchestrate"] });
	});

	test("a first reply that is not JSON picks nothing, and the write call still runs", async () => {
		const { answer, request } = await cast(
			"how does compaction decide what to summarise",
			{ kind: "prompt", text: "Explain it." },
			catalogue(),
			"The compaction page, I think.",
		);
		expect(answer.picks).toEqual({ docs: [], settings: [], keywords: [] });
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

	test("the write call's user ends with the description line, and no conversation can enter", async () => {
		const { pick, request } = await cast("write a haiku about rust", { text: "Write a haiku." });
		for (const req of [pick, request]) expect(req.user.endsWith("\n\nDescription: write a haiku about rust")).toBe(true);
		const plain = await cast("write a haiku about rust", { kind: "prompt", text: "Write a haiku." }, catalogue());
		expect(plain.request.user).toBe(`${catalogue().render()}\n\nDescription: write a haiku about rust`);
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
		).toEqual({ docs: ["compaction.md"], settings: ["compaction.enabled", "tui.motion"], keywords: ["orchestrate"] });
	});

	test("fenced or bare JSON parses; no JSON picks nothing", () => {
		expect(parsePicks('```json\n{"keywords":["orchestrate"]}\n```', map).keywords).toEqual(["orchestrate"]);
		expect(parsePicks('Sure: {"docs":["settings"]} done', map).docs).toEqual(["settings.md"]);
		expect(parsePicks("no json here", map)).toEqual({ docs: [], settings: [], keywords: [] });
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

	test("a setting already at the asked value warns, says it changes nothing, and gets no undo line", async () => {
		const APPROVAL: SettingEntry = {
			id: "tools.approvalMode",
			type: "enum",
			values: ["always-ask", "write", "yolo"],
			default: '"always-ask"',
			description: "When to ask before a tool runs",
			experimental: false,
			warning: "",
			current: '"yolo"',
		};
		const { answer } = await cast(
			"make the agent stop asking me before it edits files",
			{
				kind: "setting",
				text: "omp config set tools.approvalMode yolo",
				explain: "Keeps yolo mode. To undo: !omp config set tools.approvalMode yolo",
			},
			withFixture({ settings: [APPROVAL] }),
		);
		expect(answer).toMatchObject({
			kind: "setting",
			text: "!omp config set tools.approvalMode yolo",
			explain: "Keeps yolo mode. It is already yolo, so this changes nothing.",
			warnings: ["tools.approvalMode is already yolo"],
		});
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
			picks: { docs: [], settings: [EXPERIMENTAL.id], keywords: [] },
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
			picks: { docs: [], settings: [RISKY.id], keywords: [] },
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
			`Make one the main verb of the prompt's first sentence when it reads as a verb (for example: "orchestrate a review of ...")`,
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
