/**
 * The `/spellbook` panel: an overlay that stays until Esc, also mid-turn, and never enters the
 * session. Three sections: Spells (saved spells, searchable; Enter lands one, Ctrl+X forgets one),
 * Now (settings, the cast model, the shell, where to change them) and Recent casts (read from the
 * cast logs). In Tern it is a native picker sheet; in a plain terminal, rows.
 */
import {
	type Component,
	type DescribeContext,
	Input,
	kv,
	matchesKey,
	type NativeNode,
	type NativeUiEvent,
	node,
	text,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import type { Spell } from "./book";
import type { CastSummary } from "./castlog";

export type PanelSection = "spells" | "now" | "casts";
const SECTIONS: readonly { id: PanelSection; label: string }[] = [
	{ id: "spells", label: "Spells" },
	{ id: "now", label: "Now" },
	{ id: "casts", label: "Recent casts" },
];

/** One saved spell as the panel lists it; `id` is stable while the list is shown. */
export interface PanelSpell {
	id: string;
	spell: Spell;
}

/** One `Now` row. */
export interface NowRow {
	label: string;
	value: string;
	/** Shown in the warning colour (a settings problem, a model that fell back). */
	warn?: boolean;
}

/**
 * The panel's Spells list for `query`: saved commands, then saved prompts, each kind in the order
 * `find` gives (the Tab menu's own matcher, `findSpells`).
 */
export function panelSpells(find: (query: string, kind: Spell["kind"]) => Spell[], query: string): PanelSpell[] {
	return [
		...find(query, "command").map((spell, i) => ({ id: `command:${i}`, spell })),
		...find(query, "prompt").map((spell, i) => ({ id: `prompt:${i}`, spell })),
	];
}

/** What the Now section shows, from the values in use. */
export interface NowState {
	style: string;
	bookFile: string;
	/** The `model` setting as configured. */
	modelSetting: string;
	/** What it resolved to (`provider/id:level`), or the session's model a fallback uses. */
	model: string | undefined;
	/** Why the setting wasn't used, when it wasn't. */
	fallback: string | undefined;
	shell: string;
	castsDir: string;
	problems: readonly string[];
	/** Environment variables overriding a setting (`SPELLBOOK_STYLE=decode`). */
	overrides: readonly string[];
}

/** The Now rows: each setting's value, the model in use, the shell, where logs go and where to change settings. */
export function nowRows(now: NowState): NowRow[] {
	const model = now.fallback
		? { value: `${now.modelSetting} not usable (${now.fallback}); casts use the session's ${now.model ?? "model"}`, warn: true }
		: { value: `${now.modelSetting} → ${now.model ?? "unknown"}` };
	return [
		{ label: "Style", value: now.style },
		{ label: "Spellbook file", value: now.bookFile },
		{ label: "Model", ...model },
		{ label: "Shell", value: now.shell },
		{ label: "Cast logs", value: now.castsDir },
		{ label: "Change settings", value: "/plugins → omp-spellbook → Configure" },
		...now.overrides.map(override => ({ label: "Set by environment", value: override })),
		...now.problems.map(problem => ({ label: "Settings problem", value: problem, warn: true })),
	];
}

/** A compact age: `now`, `5m`, `2h`, `3d`, `2w`, `6mo`, `1y`. */
export function age(at: string | number, now = Date.now()): string {
	const ms = now - (typeof at === "number" ? at : Date.parse(at));
	if (!Number.isFinite(ms) || ms < 60_000) return "now";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 14) return `${days}d`;
	if (days < 60) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

/** Seconds with one decimal: `8.2s`; `?` when unknown. */
export function took(ms: number | undefined): string {
	return ms === undefined ? "?" : `${(ms / 1000).toFixed(1)}s`;
}

/** A cast's prefix as typed: `?`, `?!` or `?!!`. */
function castPrefix(cast: CastSummary): string {
	if (cast.kind === "prompt") return "?";
	return cast.sigil === "!!" ? "?!!" : "?!";
}

/** One Recent casts row: what was asked, then model, time and outcome. */
export function castLine(cast: CastSummary): { label: string; detail: string } {
	const model = `${cast.model ?? "?"}${cast.thinkingLevel ? `:${cast.thinkingLevel}` : ""}`;
	const looked = cast.lookups.length === 1 ? "1 lookup" : `${cast.lookups.length} lookups`;
	return { label: `${castPrefix(cast)} ${cast.description}`, detail: `${model} · ${took(cast.totalMs)} · ${cast.outcome} · ${looked}` };
}

/** A recent cast in full, as label/value pairs; lookups and the log path last. */
export function castDetail(cast: CastSummary): [string, string][] {
	const pairs: [string, string | undefined][] = [
		["Asked", `${castPrefix(cast)} ${cast.description}`],
		["Model", `${cast.model ?? "?"}${cast.thinkingLevel ? `:${cast.thinkingLevel}` : ""}`],
		["Note", cast.note],
		["Outcome", cast.reason ? `${cast.outcome}: ${cast.reason}` : cast.outcome],
		["Landed", cast.landed],
		["Took", took(cast.totalMs)],
		["Tokens", cast.totalTokens === undefined ? undefined : String(cast.totalTokens)],
		["Cost", cast.cost === undefined ? undefined : `$${cast.cost.toFixed(4)}`],
		["Started", cast.at],
		...cast.lookups.map((lookup, i): [string, string] => [i === 0 ? "Looked up" : "", lookup]),
		["Log", cast.file],
	];
	return pairs.filter((pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== "");
}

export interface PanelDeps {
	/** Saved spells of a kind matching a query, best first (`findSpells`). */
	find(query: string, kind: Spell["kind"]): Spell[];
	now(): NowRow[];
	casts(): CastSummary[];
	/** Put a spell in the composer, as a Tab pick does. */
	land(spell: Spell): void;
	/** Take a spell out of the book; whether it was there. */
	forget(spell: Spell): boolean;
	/** Close the panel. */
	close(): void;
	requestRender(): void;
	paint(color: string, text: string): string;
}

/** Rows of the selected list shown at once in a plain terminal. */
const VISIBLE = 12;

export class SpellbookPanel implements Component {
	readonly #deps: PanelDeps;
	readonly #search = new Input();
	#section: PanelSection;
	#spells: PanelSpell[] = [];
	#now: NowRow[] = [];
	#casts: CastSummary[] = [];
	#selected: Record<PanelSection, number> = { spells: 0, now: 0, casts: 0 };
	/** The spell Ctrl+X asked to forget, waiting for a second Ctrl+X. */
	#forgetting: PanelSpell | undefined;
	#status: string | undefined;
	#focused = false;
	#version = 0;
	#memo: { version: number; sheet: boolean; node: NativeNode | null } | undefined;

	constructor(deps: PanelDeps, section: PanelSection = "spells", query = "") {
		this.#deps = deps;
		this.#section = section;
		this.#search.prompt = "Search: ";
		this.#search.placeholder = "Search saved spells…";
		this.#search.setValue(query);
		this.#refresh();
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		this.#search.focused = value && this.#section === "spells";
	}

	get section(): PanelSection {
		return this.#section;
	}

	/** Re-read every section's data (the book, the settings, the cast logs). */
	#refresh(): void {
		this.#spells = panelSpells(this.#deps.find, this.#search.getValue());
		this.#now = this.#deps.now();
		this.#casts = this.#deps.casts();
		this.#clamp();
	}

	#clamp(): void {
		const lengths = { spells: this.#spells.length, now: this.#now.length, casts: this.#casts.length };
		for (const id of ["spells", "now", "casts"] as const) {
			this.#selected[id] = Math.max(0, Math.min(this.#selected[id], lengths[id] - 1));
		}
	}

	#changed(): void {
		this.#version++;
		this.#deps.requestRender();
	}

	#setSection(section: PanelSection): void {
		if (section === this.#section) return;
		this.#section = section;
		this.#forgetting = undefined;
		this.#search.focused = this.#focused && section === "spells";
		this.#refresh();
		this.#changed();
	}

	#move(by: number): void {
		const length = this.#section === "spells" ? this.#spells.length : this.#section === "now" ? this.#now.length : this.#casts.length;
		if (length === 0) return;
		this.#selected[this.#section] = (this.#selected[this.#section] + by + length) % length;
		this.#forgetting = undefined;
		this.#changed();
	}

	#selectedSpell(): PanelSpell | undefined {
		return this.#section === "spells" ? this.#spells[this.#selected.spells] : undefined;
	}

	#land(): void {
		const picked = this.#selectedSpell();
		if (!picked) return;
		// Enter answers the forget question: Ctrl+X, then Enter, forgets.
		if (this.#forgetting?.id === picked.id) return this.#forget(true);
		this.#forgetting = undefined;
		this.#deps.close();
		this.#deps.land(picked.spell);
	}

	/** Ctrl+X asks; Enter or a second Ctrl+X forgets. */
	#forget(confirmed: boolean): void {
		const picked = this.#selectedSpell();
		if (!picked) return;
		if (!confirmed && this.#forgetting?.id !== picked.id) {
			this.#forgetting = picked;
			this.#changed();
			return;
		}
		this.#forgetting = undefined;
		this.#status = this.#deps.forget(picked.spell) ? `Forgot "${picked.spell.words}".` : `"${picked.spell.words}" was not in the book.`;
		this.#refresh();
		this.#changed();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.#forgetting) {
				this.#forgetting = undefined;
				this.#changed();
				return;
			}
			this.#deps.close();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			const index = SECTIONS.findIndex(section => section.id === this.#section);
			const next = (index + (matchesKey(data, "tab") ? 1 : SECTIONS.length - 1)) % SECTIONS.length;
			this.#setSection(SECTIONS[next]!.id);
			return;
		}
		if (matchesKey(data, "up")) return this.#move(-1);
		if (matchesKey(data, "down")) return this.#move(1);
		if (matchesKey(data, "enter")) return this.#land();
		if (matchesKey(data, "ctrl+x")) return this.#forget(false);
		if (this.#section !== "spells") return;
		const before = this.#search.getValue();
		this.#search.handleInput(data);
		if (this.#search.getValue() !== before) {
			this.#selected.spells = 0;
			this.#forgetting = undefined;
			this.#status = undefined;
			this.#spells = panelSpells(this.#deps.find, this.#search.getValue());
		}
		this.#changed();
	}

	invalidate(): void {
		this.#memo = undefined;
	}

	// ─── Plain terminal ──────────────────────────────────────────────────────────

	render(width: number): readonly string[] {
		const { paint } = this.#deps;
		const fit = (line: string) => truncateToWidth(line, width);
		const tabs = SECTIONS.map(section =>
			section.id === this.#section ? paint("accent", `[${section.label}]`) : paint("dim", ` ${section.label} `),
		).join(" ");
		const lines = [fit(`${paint("accent", "✦ Spellbook")}  ${tabs}`), ""];
		if (this.#section === "spells") lines.push(...this.#renderSpells(width));
		else if (this.#section === "now") lines.push(...this.#renderNow(width));
		else lines.push(...this.#renderCasts(width));
		lines.push("");
		const keys =
			this.#section === "spells"
				? "Enter land · Ctrl+X forget · ↑↓ select · Tab section · Esc close"
				: "↑↓ select · Tab section · Esc close";
		lines.push(fit(paint("dim", keys)));
		return lines;
	}

	/** The rows of `count` items around the selection, `line(i)` each, `›` on the selected one. */
	#window(count: number, selected: number, line: (i: number) => string): string[] {
		const start = Math.max(0, Math.min(selected - Math.floor(VISIBLE / 2), count - VISIBLE));
		const out: string[] = [];
		for (let i = start; i < Math.min(count, start + VISIBLE); i++) {
			out.push(`${i === selected ? this.#deps.paint("accent", "›") : " "} ${line(i)}`);
		}
		return out;
	}

	#renderSpells(width: number): string[] {
		const { paint } = this.#deps;
		const lines = [...this.#search.render(width)];
		if (this.#spells.length === 0) {
			lines.push(paint("dim", this.#search.getValue() ? "  No saved spell matches." : "  No saved spells yet."));
		} else {
			const selected = this.#selected.spells;
			lines.push(
				...this.#window(this.#spells.length, selected, i => {
					const { spell } = this.#spells[i]!;
					const body = spell.kind === "command" ? `! ${spell.command}` : `? ${spell.prompt.split(/\r?\n/, 1)[0]}`;
					const facts = paint("dim", `  ${spell.uses}× · ${age(spell.lastUsed)}`);
					return truncateToWidth(`${spell.words} ${paint("dim", "→")} ${body}${facts}`, width - 2);
				}),
			);
			const picked = this.#spells[selected];
			if (picked) {
				const full = picked.spell.kind === "command" ? picked.spell.command : picked.spell.prompt;
				lines.push("", ...full.split(/\r?\n/).slice(0, 4).map(line => paint("muted", `  ${line}`)));
			}
		}
		if (this.#forgetting) lines.push("", paint("warning", `  Forget "${this.#forgetting.spell.words}"? Enter or Ctrl+X to forget, Esc to keep.`));
		else if (this.#status) lines.push("", paint("dim", `  ${this.#status}`));
		return lines.map(line => truncateToWidth(line, width));
	}

	#renderNow(width: number): string[] {
		const { paint } = this.#deps;
		const pad = Math.max(...this.#now.map(row => row.label.length));
		return this.#now.map((row, i) =>
			truncateToWidth(
				`${i === this.#selected.now ? paint("accent", "›") : " "} ${paint("dim", row.label.padEnd(pad))}  ${row.warn ? paint("warning", row.value) : row.value}`,
				width,
			),
		);
	}

	#renderCasts(width: number): string[] {
		const { paint } = this.#deps;
		if (this.#casts.length === 0) return [paint("dim", "  No casts logged yet.")];
		const selected = this.#selected.casts;
		const lines = this.#window(this.#casts.length, selected, i => {
			const cast = this.#casts[i]!;
			const { label, detail } = castLine(cast);
			return truncateToWidth(`${label} ${paint("dim", `· ${detail} · ${age(cast.at)}`)}`, width - 2);
		});
		const picked = this.#casts[selected];
		if (picked) {
			const pairs = castDetail(picked);
			const pad = Math.max(...pairs.map(([label]) => label.length));
			lines.push("", ...pairs.map(([label, value]) => `  ${paint("dim", label.padEnd(pad))}  ${value.split(/\r?\n/, 1)[0]}`));
		}
		return lines.map(line => truncateToWidth(line, width));
	}

	// ─── Tern ────────────────────────────────────────────────────────────────────

	/** A native picker sheet wherever Tern draws pickers; elsewhere the rows above. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}

	describe(cx: DescribeContext): NativeNode | null {
		const sheet = this.nativeSheet(cx);
		const memo = this.#memo;
		if (memo && memo.version === this.#version && memo.sheet === sheet) return memo.node;
		const described = sheet ? this.#describePicker() : null;
		this.#memo = { version: this.#version, sheet, node: described };
		return described;
	}

	#describePicker(): NativeNode {
		const tabs = SECTIONS.map(section => ({
			id: section.id,
			label: section.label,
			count: section.id === "spells" ? this.#spells.length : section.id === "casts" ? this.#casts.length : undefined,
		}));
		const close = { id: "close", label: "Close", keys: ["esc"], end: true };
		const base = { title: "Spellbook", noun: "spells", size: "lg" as const, layout: "rows" as const, tabs, tab: this.#section };
		if (this.#section === "spells") {
			const picked = this.#spells[this.#selected.spells];
			const commands = this.#spells.filter(entry => entry.spell.kind === "command");
			const prompts = this.#spells.filter(entry => entry.spell.kind === "prompt");
			return node(
				"picker",
				{
					...base,
					query: this.#search.getValue(),
					cursor: this.#search.getCursor(),
					placeholder: "Search saved spells…",
					columns: [
						{ id: "uses", head: "Uses", format: "num" },
						{ id: "last", head: "Last used", format: "time" },
					],
					items: this.#spells.map(({ id, spell }) => ({
						id,
						label: spell.words,
						detail: spell.kind === "command" ? `! ${spell.command}` : `? ${spell.prompt.split(/\r?\n/, 1)[0]}`,
						facts: { uses: spell.uses, last: age(spell.lastUsed) },
					})),
					order: [
						...(commands.length ? [{ group: "command", label: "Commands", count: commands.length }, ...commands.map(e => e.id)] : []),
						...(prompts.length ? [{ group: "prompt", label: "Prompts", count: prompts.length }, ...prompts.map(e => e.id)] : []),
					],
					selected: picked?.id ?? null,
					empty: this.#search.getValue() ? "No saved spell matches." : "No saved spells yet.",
					message: this.#status,
					preview: "side",
					confirm: this.#forgetting
						? { text: `Forget "${this.#forgetting.spell.words}"?`, act: "forget-confirm", label: "Forget" }
						: null,
					actions: [
						{ id: "land", label: "Land", keys: ["enter"], primary: true, disabled: picked ? undefined : "Select a spell" },
						{ id: "forget", label: "Forget", keys: ["ctrl", "x"], danger: true, disabled: picked ? undefined : "Select a spell" },
						close,
					],
					focus: "list",
				},
				picked ? [text(picked.spell.kind === "command" ? picked.spell.command : picked.spell.prompt, { wrap: "word" })] : [],
			);
		}
		if (this.#section === "now") {
			return node("picker", {
				...base,
				query: null,
				items: this.#now.map((row, i) => ({ id: `now:${i}`, label: row.label, detail: row.value, tone: row.warn ? ("warning" as const) : undefined })),
				selected: `now:${this.#selected.now}`,
				preview: "none",
				actions: [close],
				focus: "list",
			});
		}
		const picked = this.#casts[this.#selected.casts];
		return node(
			"picker",
			{
				...base,
				query: null,
				columns: [
					{ id: "took", head: "Took", format: "text" },
					{ id: "when", head: "When", format: "time" },
				],
				items: this.#casts.map((cast, i) => ({
					id: `cast:${i}`,
					...castLine(cast),
					tone: cast.outcome === "landed" ? undefined : cast.outcome === "model error" || cast.outcome === "unparseable reply" ? ("error" as const) : ("warning" as const),
					facts: { took: took(cast.totalMs), when: age(cast.at) },
				})),
				selected: picked ? `cast:${this.#selected.casts}` : null,
				empty: "No casts logged yet.",
				preview: "side",
				actions: [close],
				focus: "list",
			},
			picked ? [kv(castDetail(picked)) ?? text("")] : [],
		);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.key.replaceAll("^", "") !== "") return;
		if (event.type === "select" || event.type === "activate") {
			const index = Number(event.item.slice(event.item.indexOf(":") + 1));
			const ids =
				this.#section === "spells" ? this.#spells.map(entry => entry.id) : this.#section === "now" ? this.#now.map((_, i) => `now:${i}`) : this.#casts.map((_, i) => `cast:${i}`);
			const at = ids.indexOf(event.item);
			if (at === -1 || !Number.isFinite(index)) return;
			const moved = this.#selected[this.#section] !== at;
			this.#selected[this.#section] = at;
			if (event.type === "activate" && this.#section === "spells") return this.#land();
			if (moved) this.#forgetting = undefined;
			this.#changed();
			return;
		}
		if (event.type !== "action") return;
		switch (event.act) {
			case "tab":
				if (SECTIONS.some(section => section.id === event.value)) this.#setSection(event.value as PanelSection);
				return;
			case "land":
				return this.#land();
			case "forget":
				return this.#forget(false);
			case "forget-confirm":
				return this.#forget(true);
			case "close":
			case "cancel":
				// Esc on the forget question keeps the spell and the panel.
				if (event.act === "cancel" && this.#forgetting) {
					this.#forgetting = undefined;
					this.#changed();
					return;
				}
				this.#deps.close();
				return;
		}
	}
}
