import type { ExecResult } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  ESCALATION_DEVICE_OFF_WHY,
  ESCALATION_ORG_OFF_WHY,
  ESCALATION_RETRY_HINT,
} from "../../../src/sandbox/review/permission-candidate.js";
import {
  SCOPE_DENIED_ESCALATION_TEXT,
  sandboxDenialHint,
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
    // curl 8 (macOS /usr/bin/curl) words the same refusal differently (R3 Mac dogfood)
    ["the proxy refusing a tunnel (curl 8)", "curl: (56) CONNECT tunnel failed, response 403"],
  ])("%s is a sandbox signal", (_name, stderr) => {
    expect(sandboxDenied(failed(stderr))).toBe(true);
  });

  // R3 Mac dogfood (2026-11-20): a direct connect to a closed address (a tool that ignores the
  // proxy variables, or `--noproxy`) is refused by Seatbelt, and curl prints only "Couldn't
  // connect to server": no EPERM text and no `network.blocked` entry (the proxy never saw it)
  it.each([
    [
      "a LAN address",
      "curl: (7) Failed to connect to 192.168.3.1 port 80 after 0 ms: Couldn't connect to server",
    ],
    [
      "loopback",
      "curl: (7) Failed to connect to 127.0.0.1 port 5173 after 0 ms: Couldn't connect to server",
    ],
    [
      "an IPv6 ULA",
      "curl: (7) Failed to connect to fd12::1 port 80 after 0 ms: Couldn't connect to server",
    ],
  ])("a direct connect to %s the sandbox closed is a sandbox signal", (_name, stderr) => {
    expect(sandboxDenied(failed(stderr, { exitCode: 7 }))).toBe(true);
  });

  it("a public address that refused the connection is not a sandbox signal", () => {
    expect(
      sandboxDenied(
        failed(
          "curl: (7) Failed to connect to 93.184.215.14 port 81 after 120 ms: Couldn't connect to server",
          { exitCode: 7 },
        ),
      ),
    ).toBe(false);
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

describe("the sandbox hint after a denied command", () => {
  const tunnel = failed("curl: (56) CONNECT tunnel failed, response 403", { exitCode: 56 });
  const write = failed("touch: /etc/x: Operation not permitted");

  it("invites the escalation where this device and org allow it", () => {
    expect(sandboxDenialHint(write, { escalation: "available" })).toBe(
      `\n[sandbox] The OS sandbox may have blocked this command.${ESCALATION_RETRY_HINT}`,
    );
    expect(sandboxDenialHint(tunnel, { escalation: "available" })).toBe(
      `\n[sandbox] The OS sandbox may have blocked this command's connection: private and local addresses are closed inside the sandbox, and so is any host the sandbox network does not allow.${ESCALATION_RETRY_HINT}`,
    );
  });

  // R3 Mac dogfood: with running outside the sandbox off, a network denial got no explanation
  it("explains a denial where running outside the sandbox is off, naming who turns it on", () => {
    expect(sandboxDenialHint(tunnel, { refusal: ESCALATION_DEVICE_OFF_WHY })).toBe(
      `\n[sandbox] The OS sandbox may have blocked this command's connection: private and local addresses are closed inside the sandbox, and so is any host the sandbox network does not allow. Running it outside the sandbox is not possible here: ${ESCALATION_DEVICE_OFF_WHY}.`,
    );
    expect(sandboxDenialHint(write, { refusal: ESCALATION_ORG_OFF_WHY })).toBe(
      `\n[sandbox] The OS sandbox may have blocked this command. Running it outside the sandbox is not possible here: ${ESCALATION_ORG_OFF_WHY}.`,
    );
  });

  it("says nothing for an escalated call, a call without escalation facts, or no signal", () => {
    expect(sandboxDenialHint(tunnel, { escalation: "escalated" })).toBe("");
    expect(sandboxDenialHint(tunnel, {})).toBe("");
    expect(sandboxDenialHint(failed("make: *** [all] Error 2"), { escalation: "available" })).toBe(
      "",
    );
  });
});
