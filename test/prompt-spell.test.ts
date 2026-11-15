import { describe, expect, test } from "bun:test";
import { buildCatalogue, type Catalogue, type CatalogueSources, DOC_PAGE_BYTES, MAX_DOC_PAGES, type SettingEntry } from "../src/catalogue";
import type { OmpMap } from "../src/omp-map";
import {
	buildPromptRequest,
	castPrompt,
	hasKeyword,
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
		expect(request.user.endsWith("as a standalone lowercase word: orchestrate")).toBe(true);
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
