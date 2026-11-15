import { describe, expect, test } from "bun:test";
import { destructiveReason } from "../src/danger";
import { detectShell, parseSshHosts, type ShellProbe } from "../src/platform";

function probe(over: Partial<ShellProbe> & { files?: string[]; path?: Record<string, string> }): ShellProbe {
	const files = new Set(over.files ?? []);
	return {
		platform: over.platform ?? "linux",
		env: over.env ?? {},
		exists: file => files.has(file),
		which: name => over.path?.[name],
		shellPath: over.shellPath,
		ompShell: over.ompShell,
	};
}

describe("detectShell (mirrors omp 18.20.2)", () => {
	test("Windows: Git for Windows under Program Files is bash", () => {
		const info = detectShell(
			probe({
				platform: "win32",
				env: { ProgramFiles: "C:\\Program Files" },
				files: ["C:\\Program Files\\Git\\bin\\bash.exe"],
			}),
		);
		expect(info).toMatchObject({ shell: "C:\\Program Files\\Git\\bin\\bash.exe", family: "bash" });
		expect(info.notes.join(" ")).toContain("Git Bash");
	});

	test("Windows: scoop's sh.exe shim prefers its sibling bash.exe", () => {
		const info = detectShell(
			probe({
				platform: "win32",
				env: {},
				path: { "sh.exe": "C:\\scoop\\shims\\sh.exe" },
				files: ["C:\\scoop\\shims\\bash.exe"],
			}),
		);
		expect(info.shell).toBe("C:\\scoop\\shims\\bash.exe");
	});

	test("Windows without bash: cmd.exe fallback means POSIX lines with Windows programs only", () => {
		const info = detectShell(probe({ platform: "win32", env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" } }));
		expect(info.family).toBe("sh");
		expect(info.shell).toContain("embedded POSIX shell");
		expect(info.notes.join(" ")).toContain("no ls");
	});

	test("Unix: $SHELL zsh or fish wins for ! lines; a shellPath setting overrides everything", () => {
		expect(
			detectShell(probe({ platform: "darwin", env: { SHELL: "/bin/zsh" }, files: ["/bin/zsh"] })),
		).toMatchObject({ shell: "/bin/zsh", family: "zsh" });
		expect(
			detectShell(
				probe({ env: { SHELL: "/usr/bin/fish" }, files: ["/usr/bin/fish"], path: { bash: "/usr/bin/bash" } }),
			),
		).toMatchObject({ shell: "/usr/bin/fish", family: "fish" });
		expect(
			detectShell(probe({ env: { SHELL: "/usr/bin/fish" }, files: ["/usr/bin/fish"], shellPath: "/bin/bash" })),
		).toMatchObject({ shell: "/bin/bash", family: "bash" });
	});

	test("omp's own resolution is used when readable", () => {
		expect(detectShell(probe({ platform: "win32", ompShell: "D:\\Git\\bin\\bash.exe" })).shell).toBe(
			"D:\\Git\\bin\\bash.exe",
		);
	});

	test("Unix without bash or zsh falls back to sh", () => {
		expect(detectShell(probe({ env: { SHELL: "/bin/tcsh" }, files: ["/bin/sh"] }))).toMatchObject({
			shell: "/bin/sh",
			family: "sh",
		});
	});
});

describe("parseSshHosts", () => {
	test("reads Host aliases from a CRLF config, skipping wildcards and duplicates", () => {
		const config = "Host donnager donnager-root\r\n  HostName 10.0.0.2\r\nHost *\r\n  User x\r\nhost  pi !bad\r\nHost donnager\r\n";
		expect(parseSshHosts(config)).toEqual(["donnager", "donnager-root", "pi"]);
	});
});

describe("destructiveReason", () => {
	test("flags deleting, overwriting and force-pushing commands", () => {
		for (const command of [
			"rm -rf build",
			"find . -name '*.log' -delete",
			"git reset --hard HEAD~1",
			"git push --force origin main",
			"echo hi > notes.txt",
			"dd if=/dev/zero of=/dev/sda",
			"del /s /q build",
			"powershell -NoProfile -Command \"Remove-Item -Recurse build\"",
			"sudo systemctl restart wings",
		]) {
			expect(destructiveReason(command)).toBeString();
		}
	});

	test("leaves read-only commands alone", () => {
		for (const command of [
			"ls -la",
			"git status",
			"grep -rn TODO src 2>/dev/null",
			"du -sh . >/dev/null",
			"find . -name package.json",
			"journalctl -u wings -n 50",
			"echo a => b",
		]) {
			expect(destructiveReason(command)).toBeUndefined();
		}
	});
});
