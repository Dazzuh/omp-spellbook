import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The shell omp's `!` runs a line in, as far as the command's syntax is concerned. */
export interface ShellInfo {
	/** `win32`, `linux`, `darwin`, ... */
	platform: NodeJS.Platform;
	/** Executable path, or a description when omp runs the line itself. */
	shell: string;
	/** Syntax family the command must be written in. */
	family: "bash" | "zsh" | "fish" | "sh";
	/** Extra facts for the model about this shell. */
	notes: string[];
}

export interface ShellProbe {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	exists(file: string): boolean;
	which(name: string): string | undefined;
	/** omp's `shellPath` setting, when set. */
	shellPath?: string;
	/** The shell omp itself resolved (`settings.getShellConfig().shell`), when readable; else Spellbook mirrors omp's search. */
	ompShell?: string;
}

function basename(shell: string): string {
	return (shell.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
}

/**
 * Mirror of omp 18.20.2 `procmgr.resolveWindowsShell`: Git for Windows install roots, scoop,
 * `bash.exe` on PATH, `sh.exe` on PATH (preferring a sibling `bash.exe`), else `cmd.exe`.
 */
export function resolveWindowsShell(probe: ShellProbe): string {
	const { env } = probe;
	const join = path.win32.join;
	const roots = [
		env.ProgramFiles && join(env.ProgramFiles, "Git"),
		env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Git"),
		env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Git"),
		env.GIT_INSTALL_ROOT,
		env.SCOOP && join(env.SCOOP, "apps", "git", "current"),
		env.USERPROFILE && join(env.USERPROFILE, "scoop", "apps", "git", "current"),
	];
	for (const root of roots) {
		if (!root) continue;
		const candidate = join(root, "bin", "bash.exe");
		if (probe.exists(candidate)) return candidate;
	}
	const bash = probe.which("bash.exe");
	if (bash) return bash;
	const sh = probe.which("sh.exe");
	if (sh) {
		const sibling = join(path.win32.dirname(sh), "bash.exe");
		return probe.exists(sibling) ? sibling : sh;
	}
	return env.ComSpec || env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
}

function resolveUnixDefault(probe: ShellProbe): string {
	const userShell = probe.env.SHELL;
	if (userShell && (userShell.includes("bash") || userShell.includes("zsh")) && probe.exists(userShell)) {
		return userShell;
	}
	for (const name of ["bash", "sh"]) {
		const found = probe.which(name);
		if (found) return found;
	}
	for (const dir of ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]) {
		for (const name of ["bash", "sh"]) {
			const candidate = path.posix.join(dir, name);
			if (probe.exists(candidate)) return candidate;
		}
	}
	return "sh";
}

/**
 * The shell omp 18.20.2 runs `!` lines in (`exec/bash-executor.ts` `resolveUserShellConfig` over
 * `procmgr.getShellConfig`): `shellPath` when set; on Unix `$SHELL` when it is bash, zsh or fish,
 * else the default; on Windows the default, where a cmd.exe fallback still runs the line as POSIX in
 * omp's embedded shell.
 */
export function detectShell(probe: ShellProbe): ShellInfo {
	const { platform } = probe;
	let shell: string;
	if (probe.shellPath) {
		shell = probe.shellPath;
	} else if (platform === "win32") {
		shell = probe.ompShell ?? resolveWindowsShell(probe);
	} else {
		shell = probe.ompShell ?? resolveUnixDefault(probe);
		const envShell = probe.env.SHELL;
		const name = envShell ? basename(envShell) : "";
		if (
			envShell &&
			envShell !== shell &&
			(name.includes("bash") || name.includes("zsh") || name.includes("fish")) &&
			probe.exists(envShell)
		) {
			shell = envShell;
		}
	}

	const name = basename(shell);
	const notes: string[] = [];
	let family: ShellInfo["family"];
	if (name.includes("fish")) family = "fish";
	else if (name.includes("zsh")) family = "zsh";
	else if (name.includes("bash")) family = "bash";
	else family = "sh";

	// omp 18.20.2 (exec/bash-executor.ts) runs bash `!` lines, and the Windows no-bash fallback, in its
	// embedded bash engine, whose builtins cover the common tools on every OS; zsh and fish run for real.
	const builtins =
		"omp's embedded shell has these built in on every OS: ls, find, grep, sed, awk, cat, head, tail, wc, sort, uniq, cut, tr, xargs, tee, mkdir, rm, mv, cp, date, jq.";
	if (platform === "win32") {
		if (name === "cmd.exe" || name === "cmd" || name.startsWith("powershell") || name.startsWith("pwsh")) {
			// omp never wraps `!` lines in cmd.exe; its embedded POSIX shell runs them.
			shell = "omp's embedded POSIX shell (no Git Bash found)";
			family = "sh";
			notes.push(
				builtins,
				"No Git Bash: any other program must be a Windows one on PATH, e.g. `where`, `tasklist`, `ipconfig`, or `powershell -NoProfile -Command \"...\"`.",
			);
		} else {
			notes.push(
				builtins,
				"Windows with Git Bash: lines run in omp's embedded bash engine, not a Git Bash process, so MSYS-only extras (`pwd -W`, `cygpath`) fail; `pwd` already prints a Windows path. Git Bash programs and Windows programs on PATH run too.",
			);
		}
	} else if (family === "bash") {
		notes.push(builtins);
	}
	return { platform, shell, family, notes };
}

/** Probe for the running process, for {@link detectShell}. */
export function liveProbe(omp: { shellPath?: string; ompShell?: string } = {}): ShellProbe {
	return {
		platform: process.platform,
		env: process.env,
		exists: file => {
			try {
				return fs.statSync(file).isFile();
			} catch {
				return false;
			}
		},
		which: name => Bun.which(name) ?? undefined,
		shellPath: omp.shellPath,
		ompShell: omp.ompShell,
	};
}

/** Human OS name for the request, e.g. `Windows 10.0.26200`, `macOS 15.1`, `Linux 6.8 (Ubuntu 24.04)`. */
export function describeOs(): string {
	const release = os.release();
	switch (process.platform) {
		case "win32":
			return `Windows ${release}`;
		case "darwin":
			return `macOS (Darwin ${release})`;
		case "linux": {
			try {
				const osRelease = fs.readFileSync("/etc/os-release", "utf8");
				const pretty = /^PRETTY_NAME="?([^"\r\n]*)"?/m.exec(osRelease)?.[1];
				if (pretty) return `Linux ${release} (${pretty})`;
			} catch {}
			return `Linux ${release}`;
		}
		default:
			return `${process.platform} ${release}`;
	}
}
