/**
 * Local check for commands that destroy or overwrite data, run on every generated command so the
 * warning never depends on the model remembering to flag it.
 */
/** What may stand right before a program name: start, a separator, or a path or quote (`/bin/rm`, `\rm`, `"rm"`). */
const AT = String.raw`(^|[\s;&|(\x60/\\"'])`;

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
	[new RegExp(`${AT}(sudo\\s+)?rm["']?(\\s|$)`), "deletes files"],
	[new RegExp(`${AT}(rmdir|unlink|shred|srm)["']?(\\s|$)`), "deletes files"],
	[new RegExp(`${AT}(del|erase|rd)\\s`, "i"), "deletes files"],
	[new RegExp(`${AT}mv\\s`), "moves files, replacing any file already at the destination"],
	[/\bsed\s+(-[a-zA-Z]*i|--in-place)/, "edits files in place"],
	[new RegExp(`${AT}tee\\s+(?!-a\\b|--append\\b)`), "overwrites a file"],
	[/\bRemove-Item\b/i, "deletes files"],
	[/\bfind\b[^|;&]*\s-(delete|exec\s+rm)\b/, "deletes files"],
	[/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*[fdx])/, "throws away uncommitted work"],
	[/\bgit\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+)/, "rewrites remote history"],
	[/\bgit\s+(branch\s+-D|checkout\s+--\s|restore\s)/, "throws away changes"],
	[/\b(mkfs(\.\w+)?|fdisk|parted|wipefs|diskpart|format\s+[a-z]:)/i, "formats or repartitions a disk"],
	[/\bdd\s+[^|;&]*\bof=/, "overwrites a device or file"],
	[/(^|[^<>2&=-])>\s*(?!\/dev\/null\b|nul\b)[^>&\s|]/i, "overwrites a file"],
	[/\b(truncate)\s/, "empties a file"],
	[/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i, "deletes database data"],
	[/\b(shutdown|reboot|halt|poweroff)\b/, "shuts down or restarts the machine"],
	[/\b(kill|pkill|killall|taskkill)\b/i, "stops running processes"],
	[/\bchmod\s+(-R\s+)?[0-7]*7[0-7]*7\b|\bchmod\s+-R\b|\bchown\s+-R\b/, "changes permissions recursively"],
	[/\bdocker\s+(system\s+prune|volume\s+(rm|prune)|rm\s+-f)/, "deletes containers or volumes"],
	[/\b(systemctl|service)\s+\S*\s*(stop|restart|disable)\b/, "stops or restarts a service"],
	[/:\(\)\s*\{/, "fork bomb"],
];

/** Plain reason the command is destructive, or undefined when nothing in it looks destructive. */
export function destructiveReason(command: string): string | undefined {
	for (const [pattern, reason] of RULES) if (pattern.test(command)) return reason;
	return undefined;
}
