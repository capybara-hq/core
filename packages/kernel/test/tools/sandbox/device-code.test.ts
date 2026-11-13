import { describe, expect, it } from "vitest";
import {
  DEVICE_CODE_PATTERN,
  deviceCodeIdemKey,
  GITHUB_DEVICE_LOGIN_URL,
  parseDeviceCode,
} from "../../../src/tools/builtins/sandbox/device-code.js";

/**
 * `gh auth login --web`'s device-code prompt (auto mode spec §6, P-D13). The fixtures are recorded
 * output of `gh auth login --web` (gh 2.63, GitHub.com, 2026-11-14); other CLIs' device flows are
 * deliberately not recognised.
 */

/** Recorded `gh auth login --web` output, the prompt the parser must find. */
const GH_RECORDED = [
  "! First copy your one-time code: 1A2B-C3D4",
  "- Press Enter to open https://github.com/login/device in your browser...",
  "✓ Authentication complete.",
  "✓ Logged in as octocat",
  "",
].join("\n");

describe("parseDeviceCode: gh auth login --web", () => {
  it("finds the URL and the code in the recorded prompt", () => {
    expect(parseDeviceCode(GH_RECORDED)).toEqual({
      url: GITHUB_DEVICE_LOGIN_URL,
      code: "1A2B-C3D4",
    });
  });

  it("finds it among unrelated output and on stderr (the caller concatenates both)", () => {
    const output = `warning: no browser\n${GH_RECORDED}\n[stderr]\nsome diagnostics\n`;
    expect(parseDeviceCode(output)).toEqual({ url: GITHUB_DEVICE_LOGIN_URL, code: "1A2B-C3D4" });
  });

  it("matches the accepted code alphabet (digits and upper-case letters)", () => {
    expect(DEVICE_CODE_PATTERN.test("0Z9Y-8X7W")).toBe(true);
    expect(parseDeviceCode(GH_RECORDED.replace("1A2B-C3D4", "0Z9Y-8X7W"))?.code).toBe("0Z9Y-8X7W");
  });
});

describe("parseDeviceCode: other outputs are not recognised (P-D13)", () => {
  it("an Azure CLI device login prints a different URL and no gh code line", () => {
    const az =
      "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCDEFGH to authenticate.\n";
    expect(parseDeviceCode(az)).toBeNull();
  });

  it("the GitHub URL alone is not enough", () => {
    expect(parseDeviceCode("Open https://github.com/login/device to continue.\n")).toBeNull();
  });

  it("the code line alone is not enough", () => {
    expect(parseDeviceCode("! First copy your one-time code: 1A2B-C3D4\n")).toBeNull();
  });

  it("a malformed code (lower case, wrong length) is rejected", () => {
    expect(parseDeviceCode(GH_RECORDED.replace("1A2B-C3D4", "1a2b-c3d4"))).toBeNull();
    expect(parseDeviceCode(GH_RECORDED.replace("1A2B-C3D4", "1A2B-C3D"))).toBeNull();
    expect(parseDeviceCode(GH_RECORDED.replace("1A2B-C3D4", "1A2B-C3D4-5E6F"))).toBeNull();
  });

  it("a similar sentence from another program does not match the anchored gh line", () => {
    const other =
      "Please note: First copy your one-time code: 1A2B-C3D4\nhttps://github.com/login/device\n";
    expect(parseDeviceCode(other)).toBeNull();
  });

  it("a URL that merely starts with the device path is not the device URL", () => {
    const lookalike = GH_RECORDED.replace(
      "https://github.com/login/device",
      "https://github.com/login/device-help",
    );
    expect(parseDeviceCode(lookalike)).toBeNull();
  });
});

describe("deviceCodeIdemKey", () => {
  it("is deterministic per run and call (a retry writes the event once)", () => {
    expect(deviceCodeIdemKey("r1", "call-1")).toBe("device_code:r1:call-1");
    expect(deviceCodeIdemKey("r1", "call-1")).toBe(deviceCodeIdemKey("r1", "call-1"));
    expect(deviceCodeIdemKey("r2", "call-1")).not.toBe(deviceCodeIdemKey("r1", "call-1"));
  });
});
