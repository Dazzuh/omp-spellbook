# Spellbook

Forget the flags, keep the words. Spellbook is an [omp](https://omp.sh) plugin: type `?` and what you want in
plain words, and a model that looks omp up for itself turns it into the prompt omp's agent needs, naming the skills,
docs and magic keywords that help; with `?!` it writes the shell command instead. It morphs into the composer; you
read it, edit it if you like, and press Enter. Nothing is sent or run until you do; Enter while the morph is still
playing only finishes it.

![In Tern's dark theme, "? get a few agents to review this repo for bugs" morphs into a prompt that has omp start three subagents in parallel (reviewer, security-reviewer and scout), each reading the repo from a different angle, then merge their findings into one report; then "?! find files bigger than 1 MB under here" morphs into "!find . -type f -size +1M -exec ls -lh {} +"](docs/demo.gif)

- `? <description>` → a **prompt** for omp's agent, and only ever a prompt. Ask about a setting and you get a prompt
  asking omp about it: omp's agent reads your settings and asks before it changes one.
- `?! <description>` → `!<command>` (runs in your shell, output goes to the model's context, as omp's `!` does)
- `?!! <description>` → `!!<command>` (output kept out of the model's context)
- A line under the composer says in the model's words what the text does, with a **⚠ Destructive** warning when a
  command deletes, moves over, overwrites, force-pushes or stops something (a local check of the command, plus the
  model's own flag). It goes away once you clear the composer or replace what landed.
- Every prompt and command you send after a spell is saved in your **spellbook** under your own words. Next time,
  type `?` (prompts) or `?!` (commands) and a few of those words and press **Tab**: pick the saved one, no model call.
- Spell lines you press Enter on go into omp's composer history with everything else you send, in the order you sent
  them: **Up** brings back `? <description>` and Enter casts it again. A result you clear without sending stays out.

Works on Windows, Linux and macOS, with stock omp 18.20.2 or later, in any terminal; the morph is drawn in colour in
Tern and in omp's ANSI renderer alike.

## Install

You need omp 18.20.2 or later and `git` on your PATH.

**Windows** (PowerShell, cmd or Git Bash):

```sh
omp plugin install github:Dazzuh/omp-spellbook
```

omp runs `!` lines in its own embedded bash engine, which has the common tools built in (`ls`, `find`, `grep`, `sed`,
`awk`, `head`, `wc` and more), so Spellbook writes Bash commands on Windows too. With
[Git for Windows](https://git-scm.com/download/win) installed, omp loads Git Bash's setup and its programs; without it,
anything beyond the built-ins has to be a Windows program (`where`, `tasklist`, `powershell -Command`).

**Linux and macOS**:

```sh
omp plugin install github:Dazzuh/omp-spellbook
```

Commands are written for the shell omp's `!` uses: your `$SHELL` when it is zsh or fish (omp runs those for real),
else omp's embedded bash engine with your bash setup loaded.

Restart omp (or open a new session) and run `/spellbook` to see what it picked: style, spellbook file, model and
shell.

To try it without installing: `omp -e /path/to/omp-spellbook`. To remove it: `omp plugin uninstall omp-spellbook`.

### The Tern half (optional)

In [Tern](https://docs.stencil.so/tern), Spellbook has a second part: a small Tern plugin that gives a spell line its full
look. The chip stands in for the typed prefix, the way omp's bash chip stands in for `!`:

- a `?` line shows a **✦ spellbook** chip and a glow around the composer in your theme's accent;
- a `?!` line shows **✦ spellbook !**, a `?!!` line **✦ spellbook !!**, in Tern's success green (`--ok`), the colour a
  landed `!` command takes in a theme that turns omp's bash chip green.

While the model answers, the glow breathes; when the answer lands, both go (omp's bash chip takes over for a `!`
line). Install it once (any OS):

```sh
tern plugin install github.com/Dazzuh/omp-spellbook/tern
```

`tern plugin list` then shows `spellbook 0.2.0`; `tern plugin remove spellbook` removes it. Its look is plain CSS
(`tern/spellbook.css`) shipped as the plugin's manifest styles, so it also reaches remote hosts and Tern's web tab.
The words keep omp's magic-keyword rainbow.

Without the plugin, Tern still shows the prefix (`?` in accent, `?!` and `?!!` in green) and the description
shimmering like a magic keyword; plain terminals show the prefix in colour and a purple hue sweep over the description.

## Choosing the model

Spellbook uses omp's model roles, like the rest of omp, and runs the model exactly as the role is configured,
thinking level included:

1. the `spellbook` role, when you set one;
2. else the `smol` role;
3. else the model the session runs on, at the session's thinking level.

Give Spellbook its own model in your omp `config.yml`:

```yaml
modelRoles:
  spellbook: anthropic/claude-haiku-5-5:low
```

Any model you are logged in to works (`/login`, or the provider's API key in the environment).

### What the model sees

Your description, and tools to look the rest up itself. Each cast runs the model in a small omp session of its own,
kept in memory and thrown away after, whose only tools are omp's `read`, `grep` and `glob`: no edit, write, shell or
subagent tool. `read` is omp's own, so it reaches what omp's `read` reaches: files, omp's internal URLs, and also web
pages and remote URLs such as `ssh://` or `issue://`. Nothing it writes is sent to omp's agent or run in your shell
until you press Enter. Its instructions tell it where to look:

- your conversation so far, from the session's own log file;
- omp's documentation (`omp://`);
- your skills (`skill://<name>`), with the folders omp found them in, so it can list them;
- omp's settings and their current values (`cfg://`);
- the project you're in.

So `? fix that flaky test I mentioned` can work: the model reads back what you said. It replies with the text to land
and a sentence for the line under the composer (plus, for a command, whether it destroys anything), and that text
lands as written. For `?!`/`?!!` the instructions also say which shell `!` runs in on which OS, with what omp's
shell has built in.

A cast takes as long as the model spends looking things up. Measured with Haiku on Windows: 1.5 to 4.5 seconds for a
`?!` command, 6 to 13 seconds for a `?` prompt.

## Settings

Change them with `/spellbook`, or edit `<omp agent dir>/spellbook/settings.json` (`~/.omp/agent/spellbook/settings.json`
by default):

| Setting | Values | Default | `/spellbook` command |
| --- | --- | --- | --- |
| `style` | `diff`, `decode`, `rewind`, `none` | `diff` | `/spellbook style decode` |
| `bookPath` | a path; `~` is your home folder, a relative path sits beside `settings.json` | `book.json` | `/spellbook book ~/notes/spellbook.json` |

The environment variables `SPELLBOOK_STYLE` and `SPELLBOOK_BOOK` override the file.

### Morph styles

- **`diff`** (default): letters both texts share stay put; the rest of your words turn red and dissolve while the
  answer's letters grow in, green as they arrive.
- **`decode`**: scrambled glyphs sweep left to right and settle into the answer.
- **`rewind`**: your words erase backwards, then the answer types itself out.
- **`none`**: the answer just appears.

Prompts and shell commands morph the same way. Motion turns off by itself when omp's
**Motion** setting (`tui.motion`) is `reduced` or `none`, or when Tern's Reduce Motion is on: no morph, no shimmer or
pulse on the spell line, and the Tern half's glow stays still. Colour shows in Tern and in terminals omp draws in
ANSI; when another extension has replaced omp's composer, Spellbook plays the morph as plain text and leaves the spell
line unstyled.

## The spellbook file

A plain JSON file you can read, edit, copy between machines or keep in your dotfiles:

```json
{
	"version": 2,
	"entries": [
		{ "kind": "command", "words": "show the last 10 commits, one line each", "command": "git log -10 --oneline", "uses": 3, "lastUsed": "2026-11-15T17:20:33.530Z" },
		{ "kind": "prompt", "words": "review this repo with agents", "prompt": "orchestrate a bug review of this repo, one subagent per package.", "uses": 1, "lastUsed": "2026-11-15T21:04:10.112Z" }
	]
}
```

What's saved is what you actually sent, edits included: a command as long as it still starts with the same program,
a prompt as long as it keeps at least half of the words Spellbook wrote. Something
else typed instead isn't filed under those words. A 0.1 file (`"version": 1`, `"spells"`) reads as commands and is
saved back as version 2; 0.1 can't read a version 2 file and says so instead of overwriting it. If the file stops
being valid (bad JSON, or an entry without its `kind`, `words` and text), Spellbook warns you and leaves it alone
rather than overwrite your edits.

`/spellbook list [words]` shows saved spells; `/spellbook prompt <description>` is the same as typing
`? <description>`, and `/spellbook cast <description>` the same as `?! <description>` (both print the answer as JSON
when omp runs headless, `omp -p`).

## Development

```sh
bun install
bun test                      # unit tests
bun run typecheck
SPELLBOOK_LIVE=1 bun test test/live.test.ts   # real model through stock omp: runs the commands in your ! shell, casts prompts, some from a resumed conversation
```

The live test starts omp with `bun x @oh-my-pi/pi-coding-agent@18.20.2` unless `SPELLBOOK_OMP` names another command,
and uses `anthropic/claude-haiku-5-5:low` for the `spellbook` role unless `SPELLBOOK_MODEL` says otherwise. CI runs the unit tests, a load check in
stock omp and a GitHub install on Windows, Linux and macOS; the live test runs there when the repository has an
`ANTHROPIC_API_KEY` secret.

## Licence

MIT
