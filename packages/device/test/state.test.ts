import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Credential,
  credentialPath,
  readCredential,
  readPolicy,
  stateDir,
  writeCredential,
  writePolicy,
} from "../src/state.js";

const cred: Credential = {
  url: "https://x.test",
  connectUrl: "wss://x.test/device/connect",
  credential: "cap_dev_abc",
  orgId: "o",
  environmentId: "e",
  dir: "/tmp/d",
  mode: "os",
  reconnectGraceSeconds: 120,
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
    });
    writePolicy(dir, { allowedDomains: ["a.test"], allowCredentials: [], cpu: 2, memoryMb: null });
    expect(readPolicy(dir).allowedDomains).toEqual(["a.test"]);
  });
});
