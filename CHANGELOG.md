# Changelog

## 0.2.0

- **Prompt spells.** `? <description>` now writes what to type into omp for it: a prompt for the agent that names the
  installed skills that apply as `skill://<name>` and uses an enabled magic keyword where the task fits one (a request
  to fan work out gets `orchestrate`); a slash command when that's what you described; or a setting as
  `!omp config set <key> <value>`. It morphs in like a command and waits for Enter.
- The model sees a catalogue of your omp setup (skills, slash commands, enabled magic keywords, doc page names, and
  when the description calls for them up to two doc pages and the matching settings), never the conversation; the
  request is capped at 32,000 bytes. Spellbook checks the answer before it lands: only installed skills, only enabled
  keywords, `/skill:` written as `skill://`, settings with their `!`.
- **Shell commands moved to `?!`** (`!<command>`) and `?!!` (`!!<command>`); `??` is no longer a spell.
- Prompt spells you send are saved in the spellbook like commands; Tab on a `?` line offers saved prompts, Tab on a
  `?!`/`?!!` line saved commands. The spellbook file is now version 2 (`entries`, each with a `kind`); a 0.1 file is
  read as commands and saved back as version 2.
- The Tern half: the chip stands in for the typed prefix. `?` shows **✦ spellbook** in the accent; `?!` and `?!!`
  show **✦ spellbook !** and **✦ spellbook !!** in Tern's success green, glow included.
- `/spellbook prompt <description>` casts a prompt spell (JSON when headless); `/spellbook list` shows both kinds.
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
