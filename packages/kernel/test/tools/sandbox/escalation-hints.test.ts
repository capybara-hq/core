import type { ExecResult } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { ESCALATION_RETRY_HINT } from "../../../src/sandbox/review/permission-candidate.js";
import {
  SCOPE_DENIED_ESCALATION_TEXT,
  sandboxDenied,
} from "../../../src/tools/builtins/sandbox/bash.js";
import { SCOPE_DENIED_TOOL_TEXT } from "../../../src/tools/builtins/sandbox/common.js";

// The Bash hints that invite a per-call sandbox escalation (approval profiles design, "Per-call
// sandbox escalation"): only a sandbox signal invites it, never a credential or auth failure.

const failed = (stderr: string, over: Partial<ExecResult> = {}): ExecResult => ({
  exitCode: 1,
  stdout: "",
  stderr,
  truncated: false,
  timedOut: false,
  ...over,
});

describe("the sandbox denial signal", () => {
  it.each([
    ["Seatbelt / Landlock EPERM", "touch: /etc/x: Operation not permitted"],
    ["a read-only bind", "mkdir: cannot create directory '/usr/x': Read-only file system"],
    ["Seatbelt's own deny report", "Sandbox: bash(4242) deny(1) file-write-create /etc/x"],
    ["the proxy's allowlist refusal", "curl: (56) Connection blocked by network allowlist"],
    ["the proxy refusing a tunnel", "curl: (56) Received HTTP code 403 from proxy after CONNECT"],
  ])("%s is a sandbox signal", (_name, stderr) => {
    expect(sandboxDenied(failed(stderr))).toBe(true);
  });

  it("a host the device refused (network.blocked) is a sandbox signal", () => {
    expect(
      sandboxDenied(
        failed("curl: (6) Could not resolve host", {
          network: { blocked: [{ host: "example.com", port: 443, layer: "device" }] },
        } as Partial<ExecResult>),
      ),
    ).toBe(true);
  });

  it.each([
    ["ssh publickey", "git@github.com: Permission denied (publickey)."],
    [
      "a git 403",
      "remote: Permission to acme/app.git denied to bot.\nfatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403",
    ],
    ["a plain EACCES", "bash: ./run.sh: Permission denied"],
    ["git auth", "fatal: Authentication failed for 'https://github.com/acme/app.git/'"],
    [
      "no credentials",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ],
    ["an HTTP 401", "npm ERR! 401 Unauthorized - GET https://registry.example/pkg"],
  ])("%s never invites an escalation", (_name, stderr) => {
    expect(sandboxDenied(failed(stderr))).toBe(false);
  });

  it("an auth failure wins over an EPERM in the same output", () => {
    expect(sandboxDenied(failed("Operation not permitted\nPermission denied (publickey)."))).toBe(
      false,
    );
  });

  it("a successful command is never a denial", () => {
    expect(sandboxDenied(failed("Operation not permitted", { exitCode: 0 }))).toBe(false);
  });
});

it("the scope refusal's escalation text is the shared hint (two copies for the literal rule)", () => {
  expect(SCOPE_DENIED_ESCALATION_TEXT).toBe(`${SCOPE_DENIED_TOOL_TEXT}${ESCALATION_RETRY_HINT}`);
});
