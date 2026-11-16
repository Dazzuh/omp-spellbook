# Changelog

## 0.3.0

- **The `?` writer gets your rules.** Each `?` cast reads omp's rules at that moment and gives the model every rule
  omp's agent always works under (your `RULES.md`, the project's `.omp/RULES.md`, other always-apply rules) word for
  word, after one line saying these are the rules the receiving agent works under. Rules that fire mid-turn (stream
  conditions, ast-grep conditions, judge questions) and rules scoped to other agents stay out. With no such rules the
  prompt is unchanged. `?!` and `?!!` never get rules.
- **Every cast is logged.** Each cast (`?`, `?!`, `?!!`, and `/spellbook cast|prompt` headless) is saved as an omp
  session file in `<omp agent dir>/spellbook/casts`: the full system prompt, model and thinking level, every lookup
  and its result, the reply, the answer and what landed, token use and cost, how long each step took, and the outcome
  (landed, superseded, aborted, model error, unparseable reply). Failed and abandoned casts are logged too. The folder
  is Spellbook's own, so casts never show in `/resume`, and `omp --continue` never picks one. Nothing is pruned.
- **`/spellbook` is one panel.** It opens over the session, stays until Esc (also while the agent works) and never
  enters the conversation. Spells: search, Enter lands a spell (a command after `!`, or `!!` when the composer holds
  `?!!`), Ctrl+X then Enter (or Ctrl+X again) forgets one, uses and last use
  shown. Now: each setting, the model `model` resolves to, the shell, the cast log folder, and where to change
  settings. Recent casts: read from the logs, with model, time, outcome, each lookup and the log's path. In Tern it is
  a native sheet you can click. `/spellbook list [words]` and `/spellbook <words>` open it on Spells. Toasts are left only for one-line
  errors; a failed cast's toast points at Recent casts, where the whole error is.
- **Fuzzy search for saved spells.** The Tab menu and the panel share one matcher, omp's own `fuzzyRank`: words in
  any order, partial words, and one typo (two letters swapped, `gti log`). A match in the spell's words, typo or not,
  ranks above one that needs its command or prompt; equal matches sort by uses, then last use.
- **README rewritten** in plain words, with how it works in one section at the end.
- **A cast no longer tears down your background agents.** The cast's helper session was a top-level session to omp,
  and disposing one disposes omp's process-wide agent lifecycle, which holds the session's adopted and parked
  subagents. It is now a sub-agent session, so ending a cast leaves them alone.
- **Settings on the Configure page.** `style` and `bookPath` are declared as omp plugin settings, so they show on
  Spellbook's `/plugins` Configure page and in `omp plugin config list omp-spellbook`. They are read on every use,
  so a change applies to the next cast without a restart. `<omp agent dir>/spellbook/settings.json` is no longer
  read, and `/spellbook style` and `/spellbook book` are gone. `SPELLBOOK_STYLE` and `SPELLBOOK_BOOK` still override,
  and a relative `bookPath` still sits in `<omp agent dir>/spellbook`.
- **The cast model is a setting.** `model` (default `@smol`) takes a model or role the way omp's prewalk settings do
  (`@smol`, `@slow`, `anthropic/claude-haiku-5-5:low`) and is resolved like a prewalk target, thinking level
  included. The `spellbook` role is no longer read: set `model` to `@spellbook` to keep using it. A value that
  doesn't resolve to a usable model falls back to the session's model and thinking level, and the line under the
  composer says why. `/spellbook` shows the configured value and what it resolved to.

## 0.2.1

- `?`, `?!` and `?!!` lines you press Enter on now go into omp's composer history (Up/Down, and omp's saved prompt
  history), in the order you sent them alongside your prompts and `!` commands. omp never recorded a line an
  extension took. Only what you pressed Enter on is recorded: a landed result you clear without sending stays out,
  and Enter that only finishes a morph records nothing. The Tern half only moves its version with the omp half.

## 0.2.0

- **Prompt spells.** `? <description>` writes the prompt omp's agent needs for it, using omp's docs, your skills and
  magic keywords where they help. It is only ever a prompt: a question about a setting becomes a prompt asking omp,
  whose agent reads `cfg://` and asks before changing anything. It morphs in like a command and waits for Enter.
- **The model looks things up itself.** Each cast (`?`, `?!` and `?!!` alike) runs the model in a throwaway omp
  session kept in memory, with omp's `read`, `grep` and `glob` as its only tools (no edit, write, shell or subagent
  tool): it can read your conversation so far from the session's log, omp's docs (`omp://`), your skills
  (`skill://`), omp's settings and current values (`cfg://`) and the project. Spellbook packs no context for it.
- **The model runs as its role is configured**, thinking level included: the `spellbook` role, else `smol`, else the
  session's model and thinking level. Spellbook sets no reasoning, temperature or token limits of its own.
- What lands is the model's text exactly as it wrote it; the line under the composer is its own explanation, with the
  ⚠ warning for destructive commands as before. Its reply is a small JSON envelope that only separates those parts.
  The line goes away once the composer is cleared or no longer holds what landed.
- The model is told which folders your skills are in (from omp's own skill discovery), so it can list and read them.
- `?!` no longer sends recent `!` commands, SSH host aliases or saved commands, and no longer strips `$`, `!` or
  backticks from the answer; the `recentCommands` setting is gone.
- **Shell commands moved to `?!`** (`!<command>`) and `?!!` (`!!<command>`); `??` is no longer a spell.
- Prompt spells you send are saved in the spellbook like commands; Tab on a `?` line offers saved prompts, Tab on a
  `?!`/`?!!` line saved commands. The spellbook file is now version 2 (`entries`, each with a `kind`); a 0.1 file is
  read as commands and saved back as version 2.
- The Tern half: the chip stands in for the typed prefix. `?` shows **✦ spellbook** in the accent; `?!` and `?!!`
  show **✦ spellbook !** and **✦ spellbook !!** in Tern's success green, glow included.
- `/spellbook prompt <description>` casts a prompt spell; headless (`omp -p`), it and `/spellbook cast` print the answer
  as JSON with the cast time. `/spellbook list` shows both kinds.
- README examples and demo in dark mode.

## 0.1.1

- A `?` line now looks like a spell while you type it: the `?` in your theme's accent, the description shimmering
  like one of omp's magic keywords; while the model answers, both pulse. Plain terminals get the `?` in accent and a
  purple hue sweep over the description.
- Spellbook's Tern half, a Tern plugin in `tern/`: a `✦ spellbook` chip where omp's bash chip sits and an accent glow
  around the composer while a spell is in it, the glow breathing while it casts. Install it with
  `tern plugin install github.com/Dazzuh/omp-spellbook/tern`.
- Reduce motion (omp's Motion setting or Tern's Reduce Motion) stops the shimmer and the pulse and leaves the glow
  still.

## 0.1.0

- `? <description>` turns plain words into a shell command in the omp composer as `!<command>`; `??` gives `!!`.
- A plain-words line under the composer explains the command and warns when it is destructive.
- The spellbook: commands sent after `?` are saved under your words; Tab on a `?` line recalls them without a model call.
- Morph styles `diff` (colour), `decode`, `rewind` and `none`; motion follows omp's Motion setting and Tern's Reduce Motion.
- Model from the `spellbook` role, else `smol`, else the session model; the request carries a small context packet only.
- Commands are written for the shell omp's `!` runs in on Windows, Linux and macOS.
