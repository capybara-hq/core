import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONNECTIONS_DIR,
  connectionsDir,
  listConnections,
  scanConnections,
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

  it("scans once: every credential lands in exactly one list", () => {
    writeCredential(conn("a"), cred("a"));
    writeCredential(conn("b"), cred("b"));
    chmodSync(credentialPath(conn("b")), 0o644);
    mkdirSync(conn("empty"), { recursive: true });
    const scan = scanConnections(m);
    expect(scan.readable.map((c) => c.deviceId)).toEqual(["a"]);
    expect(scan.unreadable.map((u) => u.deviceId)).toEqual(["b"]);
    expect(scan.credentialless).toEqual(["empty"]);
  });

  it("lists logged-out connection directories (no credential.json) by id, never links or bad names", () => {
    writeCredential(conn("a"), cred("a"));
    mkdirSync(conn("z-out"), { recursive: true });
    mkdirSync(conn("b-out"), { recursive: true });
    writeFileSync(join(conn("b-out"), "policy.json"), "{}");
    mkdirSync(join(m, "elsewhere"));
    symlinkSync(join(m, "elsewhere"), conn("link-out"));
    mkdirSync(conn("bad name"), { recursive: true });
    writeFileSync(conn("file-out"), "not a directory");
    const scan = scanConnections(m);
    expect(scan.credentialless).toEqual(["b-out", "z-out"]);
    expect(listConnections(m).map((c) => c.deviceId)).toEqual(["a"]);
    expect(unreadableConnections(m)).toEqual([]);
  });

  // root may search any directory: the locked directory is then readable
  it.skipIf(process.getuid?.() === 0)(
    "a connection whose credential cannot even be looked at is unreadable, never skipped",
    () => {
      writeCredential(conn("a"), cred("a"));
      writeCredential(conn("locked"), cred("locked"));
      chmodSync(conn("locked"), 0o000);
      try {
        const scan = scanConnections(m);
        expect(scan.readable.map((c) => c.deviceId)).toEqual(["a"]);
        expect(scan.unreadable.map((u) => u.deviceId)).toEqual(["locked"]);
      } finally {
        chmodSync(conn("locked"), 0o700);
      }
    },
  );

  it("only a missing connections directory means no connections; other errors throw", () => {
    expect(scanConnections(m)).toEqual({ readable: [], unreadable: [], credentialless: [] });
    writeFileSync(join(m, CONNECTIONS_DIR), "not a directory");
    expect(() => scanConnections(m)).toThrow(/ENOTDIR/);
    expect(() => listConnections(m)).toThrow(/ENOTDIR/);
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
