# omp `!` shell and CI gotchas (omp 18.20.2)

- omp runs bash `!` lines (Linux, macOS bash, Windows Git Bash) and the Windows no-bash fallback in its **embedded bash engine** with the rc snapshot, not a real bash process (`exec/bash-executor.ts` ~705-760). zsh/fish run in a real PTY. Builtins include ls, find, grep, sed, awk, cat, head, tail, wc, sort, uniq, cut, tr, xargs, tee, mkdir, rm, mv, cp, date, jq (natives CHANGELOG). MSYS-only extras such as `pwd -W` and `cygpath` fail there.
- To test commands exactly as `!` runs them: `import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor"` and call `executeBash(cmd, { cwd, useUserShell: true })` (test-only, devDependency).
- GitHub Actions Windows `shell: bash` (Git Bash) rewrites args like `/spellbook` into Windows paths. Set `MSYS_NO_PATHCONV: "1"`.
- A `bun.lock` written by bun 1.4 is lockfileVersion 2. CI on bun 1.3 fails `--frozen-lockfile`, so pin setup-bun to `1.4.x`.
- On ovnfs checkouts (O: drive), `sed -i` fails to rename its temp file and **deletes the target**. Use the edit tool. `bun install` there needs `--backend=copyfile`.
- omp input hooks run after the editor resets. Returning `{ handled: true }` means nothing is sent or run, so an extension can take Enter, e.g. to finish an animation.
