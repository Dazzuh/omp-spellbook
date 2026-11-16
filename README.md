# Spellbook

Spellbook is an [omp](https://omp.sh) plugin. You describe what you want in plain words, and a model writes it for
you: a prompt for omp's agent, or a shell command. The answer appears in the composer, and nothing is sent or run
until you press Enter.

![In Tern's dark theme, "? get a few agents to review this repo for bugs" morphs into a prompt that has omp start three subagents in parallel (reviewer, security-reviewer and scout), each reading the repo from a different angle, then merge their findings into one report; then "?! find files bigger than 1 MB under here" morphs into "!find . -type f -size +1M -exec ls -lh {} +"](docs/demo.gif)

## The three prefixes

Type one of these at the start of the composer and press Enter:

- `? <description>` writes a prompt for omp's agent. It is always a prompt. If you ask about a setting, you get a
  prompt that asks omp's agent about it.
- `?! <description>` writes a shell command and puts it after omp's `!`. Its output goes into the model's context,
  as with any `!` line.
- `?!! <description>` does the same after `!!`. Its output stays out of the model's context.

The answer replaces your description with a short animation. A line under the composer says what the text does. If a
command deletes, overwrites, force-pushes or stops something, that line starts with a **⚠ Destructive** warning. The
line goes away when you clear or replace what landed. Pressing Enter while the animation plays only finishes it.

When you send a prompt or command that Spellbook wrote, it is saved under your words. Later, type `?` or `?!` with a
few of those words and press **Tab**. The list shows matching saved spells, and picking one costs no model call. The
search forgives a typo and words in any order.

Spell lines you press Enter on go into omp's composer history. Press **Up** to bring back `? <description>` and cast
it again.

## Install

You need omp 18.20.2 or later and `git` on your PATH. On Windows, Linux and macOS:

```sh
omp plugin install github:Dazzuh/omp-spellbook
```

Restart omp or open a new session. To remove it, run `omp plugin uninstall omp-spellbook`. To try it without
installing, run `omp -e /path/to/omp-spellbook`.

Commands are written for the shell that omp's `!` uses:

- **Linux and macOS:** your `$SHELL` if it is bash, zsh or fish, else omp's default shell. zsh and fish run for real.
  bash lines run in omp's built-in bash engine, with a snapshot of your bash setup.
- **Windows:** omp's built-in bash engine. It has common tools built in, such as `ls`, `find`, `grep`, `sed` and `awk`.
  With [Git for Windows](https://git-scm.com/download/win) installed, Git Bash's programs work too. Without it,
  anything else has to be a Windows program.

## The Tern half

In [Tern](https://docs.stencil.so/tern), an optional Tern plugin gives spell lines their full look. Install it once:

```sh
tern plugin install github.com/Dazzuh/omp-spellbook/tern
```

With it, a `?` line shows a **✦ spellbook** chip and a glow around the composer in your theme's accent. A `?!` line
shows **✦ spellbook !** and a `?!!` line **✦ spellbook !!**, both in Tern's success green. The glow breathes while
the model answers. `tern plugin remove spellbook` removes it.

Without the Tern plugin, the prefix is still coloured and the description shimmers. Other terminals show the prefix
in colour and a purple sweep over the description.

## Settings

Spellbook's settings are on its Configure page: run `/plugins`, select Spellbook (omp-spellbook), then Configure. A change
applies to the next cast without a restart.

| Setting | What it does | Default |
| --- | --- | --- |
| `style` | The animation: `diff`, `decode`, `rewind` or `none` | `diff` |
| `bookPath` | Where saved spells are kept. `~` is your home folder. A relative path is inside `<omp agent dir>/spellbook`. | `book.json` |
| `model` | The model that writes, as a role (`@smol`, `@slow`) or a model (`anthropic/claude-haiku-5-5:low`) | `@smol` |

The styles:

- `diff` keeps the letters both texts share. The rest of your words fade out in red while the answer grows in green.
- `decode` sweeps scrambled glyphs left to right until they settle into the answer.
- `rewind` erases your words backwards, then types the answer.
- `none` shows the answer at once.

The animation turns off when omp's Motion setting (`tui.motion`) is `reduced` or `none`, or when Tern's Reduce Motion
is on.

`model` runs the cast with that model's thinking level, so `@smol` uses whatever your `smol` role sets. If the value
doesn't give a usable model, for example a typo or a provider with no API key, the cast uses the session's model. The
line under the composer then says why.

Two environment variables override settings: `SPELLBOOK_STYLE` for `style` and `SPELLBOOK_BOOK` for `bookPath`.
`SPELLBOOK_STYLE` also takes the letters `D`, `B`, `C` and `off`.

From a shell, `omp plugin config list omp-spellbook` shows the settings, and
`omp plugin config set omp-spellbook style decode` changes one.

## The /spellbook panel

`/spellbook` opens a panel over the session. It stays open until you press Esc, and it works while omp's agent is
busy. Nothing in it goes into the conversation. Tab moves between its three parts:

- **Spells:** your saved spells. Type to search. Enter puts the selected spell in the composer, a command after `!`.
  Ctrl+X twice forgets it. Each spell shows how often you used it and when.
- **Now:** each setting's value, the model `model` resolves to, the shell, where cast logs go, and where to change
  settings.
- **Recent casts:** the latest casts with their model, time taken and outcome. The selected cast shows each file and
  page the model looked up, and the path of its log.

In Tern the panel is a native sheet that you can also click. `/spellbook list <words>`, or `/spellbook <words>`, opens
it on Spells with `<words>` already in the search.

`/spellbook prompt <description>` is the same as typing `? <description>`. `/spellbook cast <description>` is the same
as `?! <description>`. When omp runs headless (`omp -p`), both print the answer as JSON, and `/spellbook` prints the
Now part.

## The spellbook file

Saved spells live in a plain JSON file that you can read, edit or copy between machines:

```json
{
	"version": 2,
	"entries": [
		{ "kind": "command", "words": "show the last 10 commits, one line each", "command": "git log -10 --oneline", "uses": 3, "lastUsed": "2026-11-15T17:20:33.530Z" },
		{ "kind": "prompt", "words": "review this repo with agents", "prompt": "orchestrate a bug review of this repo, one subagent per package.", "uses": 1, "lastUsed": "2026-11-15T21:04:10.112Z" }
	]
}
```

Spellbook saves what you actually sent, edits included. A command is saved if it still starts with the same program.
A prompt is saved if it keeps at least half of the words Spellbook wrote.

A file from Spellbook 0.1 is read as commands and saved back in this format. If the file stops being valid JSON, or
an entry lacks its kind, words or text, Spellbook warns you and doesn't overwrite it.

## Cast logs

Every cast is saved as an omp session file in `<omp agent dir>/spellbook/casts`, one file per cast. This folder is
separate from omp's own sessions, so casts never appear in `/resume`.

A log holds what you asked, the full system prompt, the model and thinking level, each lookup with its result, the
model's reply, what landed in the composer, token use and cost, and how long each step took. Casts that fail or that
you abandon are logged too, with their outcome. A cast that looks things up a lot can make a log of a few hundred KB.
Spellbook doesn't delete old logs.

## How it works

Each cast runs the model in a small omp session of its own. Its only tools are omp's `read`, `grep` and `glob`, so
it can look things up but can't edit files, run commands or start agents. `read` is omp's own tool, so it also
reaches web pages and omp's internal URLs.

The model is told where to look:

- your conversation so far, from the session's log;
- omp's documentation (`omp://`);
- your skills (`skill://<name>`) and the folders they are in;
- omp's settings and their values (`cfg://`);
- the project you're in.

That is why `? fix that flaky test I mentioned` works: the model reads back what you said earlier.

For `?`, the model also gets your rules: every rule that omp's agent always works under, such as your `RULES.md` and
the project's `.omp/RULES.md`, word for word. The prompt it writes then fits how you work. Rules that fire only
mid-turn, and rules meant for other agents, are left out. For `?!` and `?!!`, it is told which shell runs the line on
which OS.

The model replies with the text and a sentence for the line under the composer, and the text lands exactly as written.
How long a cast takes depends on how much the model looks up. With Haiku, a `?!` command took about 3 seconds, and a
`?` prompt that read 25 files took about a minute.

## Development

```sh
bun install
bun test
bun run typecheck
SPELLBOOK_LIVE=1 bun test test/live.test.ts
```

The last line is a live test against a real model through stock omp. It runs the commands it gets in your `!` shell.
It starts omp with `bun x @oh-my-pi/pi-coding-agent@18.20.2` unless `SPELLBOOK_OMP` names another command. It uses
`anthropic/claude-haiku-5-5:low` for the `smol` role unless `SPELLBOOK_MODEL` says otherwise.

CI runs the unit tests, a load check in stock omp and a GitHub install on Windows, Linux and macOS. The live test
runs there too when the repository has an `ANTHROPIC_API_KEY` secret.

## Licence

MIT
