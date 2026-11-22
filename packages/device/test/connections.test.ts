import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONNECTIONS_DIR,
  connectionsDir,
  listConnections,
  unreadableConnections,
} from "../src/connections.js";
import { type Credential, credentialPath, writeCredential } from "../src/state.js";

let m: string;
beforeEach(() => {
  m = mkdtempSync(join(tmpdir(), "cap-conn-"));
});
afterEach(() => {
  rmSync(m, { recursive: true, force: true });
});

function cred(id: string, extra: Record<string, unknown> = {}): Credential {
  return {
    url: `https://${id}.example.com:8443/x`,
    connectUrl: "wss://example.com/ws",
    credential: "secret",
    orgId: `org-${id}`,
    deviceId: id,
    dir: `/work/${id}`,
    mode: "os",
    reconnectGraceSeconds: 120,
    maxFrameBytes: 1024,
    ...extra,
  } as Credential;
}
const conn = (id: string) => join(m, CONNECTIONS_DIR, id);

describe("listConnections", () => {
  it("lists every connections/<id> with its workDir and stateDir, sorted", () => {
    writeCredential(conn("b"), cred("b"));
    writeCredential(conn("a"), cred("a", { deviceName: "Laptop", orgName: "Acme" }));
    writeCredential(m, cred("legacy"));
    const list = listConnections(m);
    expect(list.map((c) => c.deviceId)).toEqual(["a", "b"]);
    expect(list[0]).toMatchObject({
      orgId: "org-a",
      url: "https://a.example.com:8443/x",
      host: "a.example.com:8443",
      deviceName: "Laptop",
      orgName: "Acme",
      stateDir: conn("a"),
      workDir: "/work/a",
      mode: "os",
    });
    expect(list[1]).toMatchObject({ deviceName: null, orgName: null });
    expect(connectionsDir(m)).toBe(join(m, "connections"));
  });

  it("returns [] when there is no connections directory", () => {
    expect(listConnections(m)).toEqual([]);
    expect(unreadableConnections(m)).toEqual([]);
  });

  it("an unreadable credential is absent from the list and reported", () => {
    writeCredential(conn("a"), cred("a"));
    writeCredential(conn("b"), cred("b"));
    chmodSync(credentialPath(conn("b")), 0o644);
    mkdirSync(conn("empty"), { recursive: true });
    expect(listConnections(m).map((c) => c.deviceId)).toEqual(["a"]);
    const bad = unreadableConnections(m);
    expect(bad.map((b) => b.deviceId)).toEqual(["b"]);
    expect(bad[0]?.reason).toContain("readable by other users");
  });

  it("skips symlinked directories and names failing the id pattern", () => {
    writeCredential(conn("real"), cred("real"));
    symlinkSync(conn("real"), conn("link"));
    writeCredential(conn("bad name"), cred("bad name"));
    expect(listConnections(m).map((c) => c.deviceId)).toEqual(["real"]);
    expect(unreadableConnections(m)).toEqual([]);
  });

  it("defaults the machine directory to stateDir()", () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = m;
    try {
      writeCredential(join(m, "capybara-device", "connections", "x"), cred("x"));
      expect(listConnections().map((c) => c.deviceId)).toEqual(["x"]);
      expect(unreadableConnections()).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });
});
