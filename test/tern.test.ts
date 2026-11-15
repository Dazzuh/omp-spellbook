import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SPELL_SIGIL_TOKENS } from "../src/editor";

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

	test("its sheet keys on the marker pair the omp plugin puts on the sigil", () => {
		const css = fs.readFileSync(path.join(ternDir, "spellbook.css"), "utf8");
		const marker = SPELL_SIGIL_TOKENS.split(" ")
			.map(token => `.sf-t-${token}`)
			.join("");
		const selectors = css.match(/^[^\s/@{}][^{]*\{/gm) ?? [];
		const keyed = selectors.filter(s => s.includes(":has(")).map(s => s.slice(0, -1).trim());
		expect(keyed.length).toBeGreaterThan(0);
		for (const selector of keyed) expect(selector).toContain(marker);
		expect(css).toContain(`${marker}.sf-fx-pulse`);
	});
});
