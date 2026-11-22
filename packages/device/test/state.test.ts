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
  createMissingPolicyFile,
  credentialPath,
  DEFAULT_POLICY,
  MISSING_POLICY_OWNER_CEILING,
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
  it("an absent policy.json reads as the closed allowlist, and start writes it once", () => {
    const read = readPolicyFile(dir);
    expect(read.policy.ownerCeiling).toEqual(MISSING_POLICY_OWNER_CEILING);
    expect(read.policy.ownerCeiling).toEqual({
      outsideSandbox: false,
      network: "allowlist",
      projectReach: "workspace",
    });
    expect(read.policy.allowedDomains).toEqual([]);
    expect(read.policy.projectPaths).toEqual([]);
    expect(readPolicy(dir).ownerCeiling.network).toBe("allowlist");
    expect(createMissingPolicyFile(dir)).toBe(true);
    const written = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8"));
    expect(written).toMatchObject({
      version: 4,
      allowedDomains: [],
      ownerCeiling: MISSING_POLICY_OWNER_CEILING,
      projectPaths: [],
    });
    expect(createMissingPolicyFile(dir)).toBe(false);
    // an existing file is left alone, whatever it holds
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ version: 3 }));
    expect(createMissingPolicyFile(dir)).toBe(false);
    expect(readFileSync(join(dir, "policy.json"), "utf8")).toBe('{"version":3}');
    // a new setup (login) still writes the open default
    expect(DEFAULT_POLICY.ownerCeiling.network).toBe("open");
  });

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

  it("keeps the device and organization names when present and refuses names that are not strings", () => {
    writeCredential(dir, { ...cred, deviceName: "Laptop", orgName: "Acme" });
    expect(readCredential(dir)).toMatchObject({ deviceName: "Laptop", orgName: "Acme" });
    writeCredential(dir, { ...cred, deviceName: 7 } as unknown as Credential);
    expect(() => readCredential(dir)).toThrow(/deviceName must be a string/);
    writeCredential(dir, { ...cred, orgName: null } as unknown as Credential);
    expect(() => readCredential(dir)).toThrow(/orgName must be a string/);
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
      // no file: no running outside the sandbox, the allowlist network with no host
      ownerCeiling: { outsideSandbox: false, network: "allowlist", projectReach: "workspace" },
      keepAwake: "while-busy",
      projectPaths: [],
    });
    const policy = {
      allowedDomains: ["a.test"],
      allowCredentials: [],
      cpu: 2,
      memoryMb: null,
      ownerCeiling: { outsideSandbox: false, network: "allowlist", projectReach: "paths" },
      keepAwake: "connected",
      projectPaths: ["/src/a", "/src/b"],
    } as const;
    writePolicy(dir, {
      ...policy,
      allowCredentials: [],
      allowedDomains: ["a.test"],
      projectPaths: ["/src/a", "/src/b"],
    });
    expect(readPolicy(dir)).toEqual(policy);
    expect(JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")).version).toBe(4);
  });

  it("keeps unknown top-level keys on write", () => {
    writePolicy(dir, DEFAULT_POLICY, { future: 1 });
    const got = readPolicyFile(dir);
    expect(got.policy).toEqual(DEFAULT_POLICY);
    expect(got.extra).toEqual({ future: 1 });
  });

  it("readPolicy names the file on bad JSON and on wrong field types", () => {
    const file = join(dir, "policy.json");
    writeFileSync(file, "{nope");
    expect(() => readPolicy(dir)).toThrow(/policy\.json is not valid JSON/);
    const base = {
      version: 4,
      ownerCeiling: { outsideSandbox: false, network: "allowlist", projectReach: "workspace" },
    };
    for (const [body, field] of [
      [{ allowedDomains: "a.test" }, "allowedDomains"],
      [{ allowedDomains: [1] }, "allowedDomains"],
      [{ allowCredentials: null }, "allowCredentials"],
      [{ cpu: "2" }, "cpu"],
      [{ cpu: 0 }, "cpu"],
      [{ memoryMb: -1 }, "memoryMb"],
      [{ keepAwake: "always" }, "keepAwake"],
      [{ projectPaths: ["rel"] }, "projectPaths"],
      [{ ownerCeiling: null }, "ownerCeiling"],
      [
        { ownerCeiling: { ...base.ownerCeiling, outsideSandbox: "no" } },
        "ownerCeiling.outsideSandbox",
      ],
    ] as const) {
      writeFileSync(file, JSON.stringify({ ...base, ...body }));
      expect(() => readPolicy(dir)).toThrow(new RegExp(`policy\\.json is invalid: ${field} must`));
    }
    writeFileSync(file, "[]");
    expect(() => readPolicy(dir)).toThrow(/policy\.json is invalid: expected a JSON object/);
    writeFileSync(file, JSON.stringify({ ...base, cpu: 1.5, extra: true }));
    expect(readPolicy(dir)).toEqual({
      ...DEFAULT_POLICY,
      cpu: 1.5,
      ownerCeiling: base.ownerCeiling,
    });
  });
});
