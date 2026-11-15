import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SHELL_SIGIL_TOKENS, SPELL_SIGIL_TOKENS } from "../src/editor";

const root = path.join(import.meta.dir, "..");
const ternDir = path.join(root, "tern");
const manifest = fs.readFileSync(path.join(ternDir, "plugin.toml"), "utf8");
const field = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(manifest)?.[1];

describe("the Tern half", () => {
	test("ships the same version as the omp plugin, with its id and entries in place", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		expect(field("version")).toBe(pkg.version);
		expect(field("id")).toBe("spellbook");
		const window = field("window");
		expect(window && fs.existsSync(path.join(ternDir, window))).toBe(true);
		const styles = /^styles\s*=\s*\[([^\]]*)\]/m.exec(manifest)?.[1]?.match(/"([^"]+)"/g)?.map(s => s.slice(1, -1));
		expect(styles).toEqual(["spellbook.css"]);
	});

	const css = fs.readFileSync(path.join(ternDir, "spellbook.css"), "utf8");
	const marker = (tokens: string) =>
		tokens
			.split(" ")
			.map(token => `.sf-t-${token}`)
			.join("");
	const prompt = marker(SPELL_SIGIL_TOKENS);
	const shell = marker(SHELL_SIGIL_TOKENS["!"]);
	const quietOnly = SHELL_SIGIL_TOKENS["!!"].split(" ").find(t => !SHELL_SIGIL_TOKENS["!"].split(" ").includes(t))!;
	/** Each rule as [selector, body], comments stripped; @-rule bodies are searched as rules of their own. */
	const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(m => [m[1]!.trim(), m[2]!] as const);

	test("its sheet keys every :has() rule on a marker the omp plugin puts on the prefix", () => {
		const keyed = rules.filter(([s]) => s.includes(":has("));
		expect(keyed.length).toBeGreaterThan(0);
		for (const [selector] of keyed) expect(selector.includes(prompt) || selector.includes(shell)).toBe(true);
		const pulse = keyed.find(([s]) => s.includes(".sf-fx-pulse"));
		expect(pulse?.[0]).toContain(prompt);
		expect(pulse?.[0]).toContain(shell);
	});

	test("a chip per kind: ✦ spellbook, ✦ spellbook ! and ✦ spellbook !!", () => {
		const chip = (content: string) => rules.find(([s, body]) => s.endsWith("::before") && body.includes(`content: '${content}'`))?.[0];
		expect(chip("✦ spellbook")).toContain(prompt);
		expect(chip("✦ spellbook !")).toContain(`${shell}:not(.sf-t-${quietOnly})`);
		expect(chip("✦ spellbook !!")).toContain(`${shell}.sf-t-${quietOnly}`);
	});

	test("the sheet hides the typed prefix of every kind itself, never through omp's hide token", () => {
		const hidden = rules.filter(([, body]) => /display:\s*none/.test(body)).map(([s]) => s);
		expect(hidden.some(s => s.includes(prompt) && s.includes(shell) && !s.includes(":has("))).toBe(true);
		expect(css).not.toContain(".sf-t-hide");
	});

	test("shell spells glow in Tern's success green", () => {
		const green = rules.find(([s, body]) => s.includes(`:has(.sf-editor ${shell})`) && body.includes("--spellbook-accent"));
		expect(green?.[1]).toContain("var(--ok");
	});
});
