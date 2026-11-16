# Changelog

## 0.2.0

- **Prompt spells.** `? <description>` writes the prompt omp's agent needs for it, using omp's docs, your skills and
  magic keywords where they help. It is only ever a prompt: a question about a setting becomes a prompt asking omp,
  whose agent reads `cfg://` and asks before changing anything. It morphs in like a command and waits for Enter.
- **The model looks things up itself.** Each cast (`?`, `?!` and `?!!` alike) runs the model in a throwaway omp
  session kept in memory, with read-only tools only (`read`, `grep`, `glob`): it can read your conversation so far
  from the session's log, omp's docs (`omp://`), your skills (`skill://`), omp's settings and current values
  (`cfg://`) and the project. Spellbook packs no context for it and nothing it can do writes or runs anything.
- **The model runs as its role is configured**, thinking level included: the `spellbook` role, else `smol`, else the
  session's model and thinking level. Spellbook sets no reasoning, temperature or token limits of its own.
- What lands is the model's text exactly as it wrote it; the line under the composer is its own explanation, with the
  ⚠ warning for destructive commands as before. Its reply is a small JSON envelope that only separates those parts.
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
