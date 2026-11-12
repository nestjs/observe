import { describe, expect, it } from "vitest";
import { browserCommand, webAddress } from "./open-url.js";

describe("webAddress", () => {
  it("keeps an http(s) URL, written back out as parsed", () => {
    expect(webAddress("https://observe.nestjs.com/link")).toBe(
      "https://observe.nestjs.com/link",
    );
    expect(webAddress("http://localhost:3000/link?a=1&b=%25")).toBe(
      "http://localhost:3000/link?a=1&b=%25",
    );
    expect(webAddress('https://observe.nestjs.com/link?a="b c"\n')).toBe(
      "https://observe.nestjs.com/link?a=%22b%20c%22",
    );
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ms-settings:",
    "/etc/passwd",
    "C:\\Windows\\System32\\calc.exe",
    "\\\\attacker\\share\\payload.exe",
    "observe.nestjs.com/link",
    "",
  ])("refuses %s", (value) => {
    expect(webAddress(value)).toBeUndefined();
  });

  it("refuses what is not a string", () => {
    expect(webAddress(undefined)).toBeUndefined();
    expect(webAddress(42)).toBeUndefined();
    expect(webAddress(["https://observe.nestjs.com/link"])).toBeUndefined();
  });
});

describe("browserCommand", () => {
  // `cmd /c start "" <url>` would run whatever follows an `&` in the URL.
  it("opens a URL on Windows without cmd.exe, as one plain argument", () => {
    const url = "https://observe.nestjs.com/link?a=1&calc|x^y%PATH%";
    const [command, args] = browserCommand(url, "win32");

    expect(command).toBe("rundll32");
    expect(args).toEqual(["url.dll,FileProtocolHandler", url]);
  });

  it("uses open on macOS and xdg-open elsewhere", () => {
    const url = "https://observe.nestjs.com/link";
    expect(browserCommand(url, "darwin")).toEqual(["open", [url]]);
    expect(browserCommand(url, "linux")).toEqual(["xdg-open", [url]]);
  });
});
