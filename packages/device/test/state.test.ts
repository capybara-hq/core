import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_DEFAULT_STATE_PATH } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Credential,
  credentialPath,
  DEFAULT_POLICY,
  ownerCeilingOfMode,
  policyMode,
  readCredential,
  readPolicy,
  readPolicyFile,
  stateDir,
  writeCredential,
  writePolicy,
} from "../src/state.js";

const cred: Credential = {
  url: "https://x.test",
  connectUrl: "wss://x.test/device/connect",
  credential: "cap_dev_abc",
  orgId: "o",
  deviceId: "e",
  dir: "/tmp/d",
  mode: "os",
  reconnectGraceSeconds: 120,
  maxFrameBytes: 1_000_000,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-state-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("state", () => {
  it("stateDir follows XDG_CONFIG_HOME, else ~/.config", () => {
    expect(stateDir({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/x/capybara-device");
    expect(stateDir({}, "/h")).toBe("/h/.config/capybara-device");
    // the kernel refuses approvals under the SDK's copy of this default
    expect(stateDir({}, "/h")).toBe(join("/h", DEVICE_DEFAULT_STATE_PATH.slice(2)));
  });

  it("writes the credential 0600 and reads it back", () => {
    writeCredential(dir, cred);
    expect(statSync(credentialPath(dir)).mode & 0o777).toBe(0o600);
    expect(readCredential(dir)).toEqual(cred);
  });

  it("writes 0600 under umask 0 and replaces a stale tmp file", () => {
    const old = process.umask(0);
    try {
      writeFileSync(`${credentialPath(dir)}.${process.pid}.tmp`, "stale", { mode: 0o666 });
      writeCredential(dir, cred);
      expect(statSync(credentialPath(dir)).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(["credential.json"]);
    } finally {
      process.umask(old);
    }
  });

  it("defaults reconnectGraceSeconds to 120 and validates it", () => {
    const { reconnectGraceSeconds: _g, ...rest } = cred;
    writeFileSync(credentialPath(dir), JSON.stringify(rest), { mode: 0o600 });
    expect(readCredential(dir)?.reconnectGraceSeconds).toBe(120);
    writeFileSync(credentialPath(dir), JSON.stringify({ ...cred, reconnectGraceSeconds: 0 }), {
      mode: 0o600,
    });
    expect(() => readCredential(dir)).toThrow(/positive integer/);
  });

  it("defaults maxFrameBytes to 16 MiB and validates it", () => {
    const { maxFrameBytes: _m, ...rest } = cred;
    writeFileSync(credentialPath(dir), JSON.stringify(rest), { mode: 0o600 });
    expect(readCredential(dir)?.maxFrameBytes).toBe(16_777_216);
    writeCredential(dir, cred);
    expect(readCredential(dir)?.maxFrameBytes).toBe(1_000_000);
    writeFileSync(credentialPath(dir), JSON.stringify({ ...cred, maxFrameBytes: "big" }), {
      mode: 0o600,
    });
    expect(() => readCredential(dir)).toThrow(/maxFrameBytes must be a positive integer/);
  });

  it("names the file when the JSON is invalid", () => {
    writeFileSync(credentialPath(dir), "{nope", { mode: 0o600 });
    expect(() => readCredential(dir)).toThrow(/credential\.json is not valid JSON/);
  });

  it("refuses a credential file readable by others", () => {
    writeCredential(dir, cred);
    chmodSync(credentialPath(dir), 0o644);
    expect(() => readCredential(dir)).toThrow(/readable by other users/);
  });

  it("rejects an incomplete credential file", () => {
    writeFileSync(credentialPath(dir), "{}", { mode: 0o600 });
    expect(() => readCredential(dir)).toThrow(/missing url/);
  });

  it("policy defaults and round trip", () => {
    expect(readPolicy(dir)).toEqual({
      allowedDomains: [],
      allowCredentials: [],
      cpu: null,
      memoryMb: null,
      // the restricted default ceiling of a new setup (B-14)
      ownerCeiling: { fullAccess: false, restrictedProjectReach: "workspace" },
    });
    writePolicy(dir, {
      allowedDomains: ["a.test"],
      allowCredentials: [],
      cpu: 2,
      memoryMb: null,
      ownerCeiling: { fullAccess: false, restrictedProjectReach: "os-user" },
    });
    expect(readPolicy(dir)).toEqual({
      allowedDomains: ["a.test"],
      allowCredentials: [],
      cpu: 2,
      memoryMb: null,
      ownerCeiling: { fullAccess: false, restrictedProjectReach: "os-user" },
    });
    expect(readPolicyFile(dir).legacy).toBe(false);
  });

  it("migrates a legacy policy file to a mode, once", () => {
    const file = join(dir, "policy.json");
    const table: [Record<string, unknown>, "auto" | "sandbox"][] = [
      [{ isolation: "none" }, "auto"],
      [{ tier: "open" }, "auto"],
      [{ tier: "open", isolation: "sandbox" }, "auto"],
      [{ isolation: "none", tier: "strict" }, "auto"],
      [{ tier: "dev" }, "sandbox"],
      [{ tier: "strict" }, "sandbox"],
      [{ isolation: "sandbox" }, "sandbox"],
      [{}, "sandbox"],
    ];
    for (const [body, mode] of table) {
      writeFileSync(file, JSON.stringify(body));
      const got = readPolicyFile(dir);
      expect(policyMode(got.policy), JSON.stringify(body)).toBe(mode);
      expect(got.legacy, JSON.stringify(body)).toBe(true);
    }
    // a file with `mode` is the old format too: it translates exactly and is converted later
    writeFileSync(file, JSON.stringify({ mode: "sandbox" }));
    expect(readPolicyFile(dir).legacy).toBe(true);
    expect(policyMode(readPolicyFile(dir).policy)).toBe("sandbox");
    writeFileSync(file, JSON.stringify({ mode: "auto" }));
    expect(policyMode(readPolicyFile(dir).policy)).toBe("auto");
  });

  it("drops the legacy keys at the next write and keeps unknown ones", () => {
    const file = join(dir, "policy.json");
    writeFileSync(
      file,
      JSON.stringify({
        allowedDomains: ["a.test"],
        network: "open",
        tier: "open",
        isolation: "none",
        localhost: "allow",
        remoteGrants: "off",
        allowLocalBinding: true,
        allowUnixSockets: ["/tmp/x.sock"],
        future: 1,
      }),
    );
    const got = readPolicyFile(dir);
    expect(got.policy).toEqual({
      ...DEFAULT_POLICY,
      allowedDomains: ["a.test"],
      ownerCeiling: ownerCeilingOfMode("auto"),
    });
    expect(got.extra).toEqual({ future: 1 });
    writePolicy(dir, got.policy, { ...got.extra, tier: "open", isolation: "none" });
    const written = JSON.parse(readFileSync(file, "utf8"));
    for (const key of [
      "network",
      "tier",
      "isolation",
      "localhost",
      "remoteGrants",
      "allowLocalBinding",
      "allowUnixSockets",
    ]) {
      expect(written).not.toHaveProperty(key);
    }
    expect(written.future).toBe(1);
    expect(readPolicyFile(dir).legacy).toBe(false);
    // a legacy value of any type is ignored, never an error
    writeFileSync(file, JSON.stringify({ network: 42, tier: 7 }));
    expect(readPolicy(dir)).toEqual({
      ...DEFAULT_POLICY,
      ownerCeiling: ownerCeilingOfMode("sandbox"),
    });
  });

  it("readPolicy names the file on bad JSON and on wrong field types", () => {
    const file = join(dir, "policy.json");
    writeFileSync(file, "{nope");
    expect(() => readPolicy(dir)).toThrow(/policy\.json is not valid JSON/);
    for (const [body, field] of [
      [{ allowedDomains: "a.test" }, "allowedDomains"],
      [{ allowedDomains: [1] }, "allowedDomains"],
      [{ allowCredentials: null }, "allowCredentials"],
      [{ cpu: "2" }, "cpu"],
      [{ cpu: 0 }, "cpu"],
      [{ memoryMb: -1 }, "memoryMb"],
      [{ mode: "any" }, "mode"],
      [{ mode: null }, "mode"],
    ] as const) {
      writeFileSync(file, JSON.stringify(body));
      expect(() => readPolicy(dir)).toThrow(new RegExp(`policy\\.json is invalid: ${field} must`));
    }
    writeFileSync(file, "[]");
    expect(() => readPolicy(dir)).toThrow(/policy\.json is invalid: expected a JSON object/);
    writeFileSync(file, JSON.stringify({ cpu: 1.5, extra: true }));
    expect(readPolicy(dir)).toEqual({
      ...DEFAULT_POLICY,
      cpu: 1.5,
      ownerCeiling: ownerCeilingOfMode("sandbox"),
    });
  });
});
