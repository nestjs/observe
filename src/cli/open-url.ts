import { spawn } from "node:child_process";

/**
 * `value` as an http(s) URL, parsed and written back out - or undefined for
 * anything else.
 *
 * The link page comes from whoever answers the link request, and is handed
 * to the desktop's opener before anything has been approved: a local file, a
 * script, or another scheme's handler is not that party's to open on the
 * person's machine. Written back out, whitespace and control characters are
 * percent-encoded, so what is printed and opened is one plain address.
 */
export function webAddress(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The command that opens `url` in the default browser on `platform` - never
 * through a shell.
 *
 * On Windows not `cmd /c start`: cmd.exe reads `&`, `|`, `^` and `%` in the
 * URL as its own syntax, and a valid https URL can hold every one of them.
 * `rundll32 url.dll,FileProtocolHandler` hands it to the same handler `start`
 * does, as one plain argument.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
): [string, string[]] {
  if (platform === "darwin") {
    return ["open", [url]];
  }
  if (platform === "win32") {
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  }
  return ["xdg-open", [url]];
}

/**
 * Opens the link page in the default browser, best effort: a headless box or
 * a missing opener just means the person opens the printed URL themselves.
 * Only a web address is opened.
 */
export function openUrl(url: string) {
  const address = webAddress(url);
  if (!address) {
    return;
  }
  const [command, args] = browserCommand(address, process.platform);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Printed already; nothing else to do.
  }
}
