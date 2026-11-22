import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConnectionInfo,
  ConnectionSelectError,
  connectionDir,
  connectionLine,
  connectionsDir,
  controlSocketPathFor,
  ensureMachineFile,
  listConnections,
  machineDirOfConnection,
  resolveConnection,
  runDir,
  scanConnections,
  unreadableConnections,
} from "../src/connections.js";
import { controlSocketPath } from "../src/control/protocol.js";
import { pidPath } from "../src/pid.js";
import { type Credential, credentialPath, policyPath, writeCredential } from "../src/state.js";

let m: string;
beforeEach(() => {
  m = mkdtempSync(join(tmpdir(), "device-conn-"));
});
afterEach(() => rmSync(m, { recursive: true, force: true }));

const credOf = (deviceId: string, host: string, extra: Partial<Credential> = {}): Credential => ({
  url: `https://${host}`,
  connectUrl: `wss://${host}/device/connect`,
  credential: `cap_dev_${deviceId}`,
  orgId: `org-${deviceId}`,
  deviceId,
  dir: `/w/${deviceId}`,
  mode: "os",
  reconnectGraceSeconds: 120,
  maxFrameBytes: 1_000_000,
  ...extra,
});

const add = (deviceId: string, host: string, extra: Partial<Credential> = {}): void =>
  writeCredential(connectionDir(m, deviceId), credOf(deviceId, host, extra));

const catchError = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
};

/** The `i`th listed connection of `m`. */
const at = (i: number): ConnectionInfo => {
  const c = listConnections(m)[i];
  if (c === undefined) throw new Error(`no connection ${i}`);
  return c;
};

const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

describe("connections: listing", () => {
  it("lists every connection under connections/ and ignores the old flat files", () => {
    writeCredential(m, credOf("flat", "flat.example.com"));
    writeFileSync(policyPath(m), "{}");
    add("dev-b", "b.example.com", { deviceName: "Laptop B", orgName: "Org B" });
    add("dev-a", "a.example.com");
    expect(listConnections(m).map((c) => c.deviceId)).toEqual(["dev-a", "dev-b"]);
    expect(listConnections(m)[0]).toEqual({
      deviceId: "dev-a",
      orgId: "org-dev-a",
      url: "https://a.example.com",
      host: "a.example.com",
      deviceName: null,
      orgName: null,
      stateDir: join(m, "connections", "dev-a"),
      workDir: "/w/dev-a",
      mode: "os",
    });
    expect(listConnections(m)[1]).toMatchObject({ deviceName: "Laptop B", orgName: "Org B" });
    expect(unreadableConnections(m)).toEqual([]);
  });

  it("sorts by host, then device name, then device id; the host keeps its port", () => {
    add("z", "a.example.com:8443", { deviceName: "B" });
    add("y", "a.example.com:8443", { deviceName: "A" });
    add("x", "a.example.com:8443", { deviceName: "A" });
    add("w", "b.example.com");
    expect(listConnections(m).map((c) => [c.host, c.deviceId])).toEqual([
      ["a.example.com:8443", "x"],
      ["a.example.com:8443", "y"],
      ["a.example.com:8443", "z"],
      ["b.example.com", "w"],
    ]);
  });

  it("is empty without a connections directory", () => {
    expect(listConnections(m)).toEqual([]);
    expect(unreadableConnections(m)).toEqual([]);
    expect(listConnections(join(m, "missing"))).toEqual([]);
  });

  it("skips non-directories, unsafe names and directories without credential.json", () => {
    add("dev-a", "a.example.com");
    writeFileSync(join(connectionsDir(m), "file"), "x");
    mkdirSync(join(connectionsDir(m), "bad.name"));
    writeCredential(join(connectionsDir(m), "bad.name"), credOf("bad.name", "c.example.com"));
    mkdirSync(join(connectionsDir(m), "empty"));
    expect(listConnections(m).map((c) => c.deviceId)).toEqual(["dev-a"]);
    expect(unreadableConnections(m)).toEqual([]);
  });

  it("skips a connection directory that is a symlink and lists an unreadable one separately", () => {
    add("dev-a", "a.example.com");
    const elsewhere = join(m, "elsewhere");
    writeCredential(elsewhere, credOf("dev-s", "s.example.com"));
    symlinkSync(elsewhere, join(connectionsDir(m), "dev-s"));
    add("dev-u", "u.example.com");
    chmodSync(credentialPath(connectionDir(m, "dev-u")), 0o644);
    expect(listConnections(m).map((c) => c.deviceId)).toEqual(["dev-a"]);
    expect(unreadableConnections(m)).toEqual([
      { deviceId: "dev-u", reason: expect.stringContaining("readable by other users") },
    ]);
  });

  // root reads through mode 000: these need an ordinary user
  it.skipIf(process.getuid?.() === 0)(
    "a connection directory that cannot be examined is unreadable, never skipped",
    () => {
      add("dev-a", "a.example.com");
      add("dev-b", "b.example.com");
      chmodSync(connectionDir(m, "dev-b"), 0o000);
      try {
        expect(listConnections(m).map((c) => c.deviceId)).toEqual(["dev-a"]);
        expect(unreadableConnections(m)).toEqual([
          { deviceId: "dev-b", reason: expect.stringContaining("cannot be examined") },
        ]);
        // one snapshot gives both lists
        expect(scanConnections(m)).toEqual({
          readable: [expect.objectContaining({ deviceId: "dev-a" })],
          unreadable: [{ deviceId: "dev-b", reason: expect.stringContaining("EACCES") }],
          credentialless: [],
        });
      } finally {
        chmodSync(connectionDir(m, "dev-b"), 0o700);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "a connections directory that cannot be read, or is a symlink, throws",
    () => {
      add("dev-a", "a.example.com");
      chmodSync(connectionsDir(m), 0o000);
      try {
        expect(() => listConnections(m)).toThrow(/cannot be read/);
        expect(() => unreadableConnections(m)).toThrow(/cannot be read/);
        expect(() => resolveConnection(undefined, m)).toThrow(/cannot be read/);
      } finally {
        chmodSync(connectionsDir(m), 0o700);
      }
      // another machine dir whose connections/ links to this one's
      const linked = join(m, "linked");
      mkdirSync(linked);
      symlinkSync(connectionsDir(m), join(linked, "connections"));
      expect(() => listConnections(linked)).toThrow(/not a directory/);
    },
  );

  it("a credential that names another device, or a bad one, is unreadable", () => {
    writeCredential(connectionDir(m, "dev-x"), credOf("dev-other", "x.example.com"));
    mkdirSync(connectionDir(m, "dev-j"), { recursive: true });
    writeFileSync(credentialPath(connectionDir(m, "dev-j")), "{", { mode: 0o600 });
    expect(listConnections(m)).toEqual([]);
    expect(unreadableConnections(m)).toEqual([
      { deviceId: "dev-j", reason: expect.stringContaining("not valid JSON") },
      { deviceId: "dev-x", reason: expect.stringContaining("dev-other") },
    ]);
  });
});

describe("connections: resolving", () => {
  it("resolves by deviceId, device name or host", () => {
    add("dev-a", "a.example.com", { deviceName: "Laptop A" });
    add("dev-b", "b.example.com", { deviceName: "Laptop B" });
    expect(resolveConnection("dev-b", m).deviceId).toBe("dev-b");
    expect(resolveConnection("Laptop B", m).deviceId).toBe("dev-b");
    expect(resolveConnection("a.example.com", m).deviceId).toBe("dev-a");
  });

  it("a device id wins over a device name that equals it", () => {
    add("dev-a", "a.example.com", { deviceName: "dev-b" });
    add("dev-b", "b.example.com");
    expect(resolveConnection("dev-b", m).deviceId).toBe("dev-b");
  });

  it("a device id selector (a UUID) matches a device id only, never a name or host", () => {
    const gone = "0b6c1f4e-2d3a-4c5b-9e8f-7a6b5c4d3e2f";
    add("dev-a", "a.example.com", { deviceName: gone });
    add("dev-b", gone);
    // the intended connection was logged out: the id never falls back to another connection
    const e = catchError(() => resolveConnection(gone, m)) as ConnectionSelectError;
    expect(e.code).toBe("not_found");
    expect(
      (catchError(() => resolveConnection(gone.toUpperCase(), m)) as ConnectionSelectError).code,
    ).toBe("not_found");
    const id = "6f1e0a52-8f5b-4d5e-9a1c-1f0e2d3c4b51";
    add(id, "c.example.com");
    expect(resolveConnection(id, m).deviceId).toBe(id);
    // a selector of another shape still matches a name or a host
    add("dev-n", "n.example.com", { deviceName: "Laptop N" });
    expect(resolveConnection("Laptop N", m).deviceId).toBe("dev-n");
    expect(resolveConnection("n.example.com", m).deviceId).toBe("dev-n");
  });

  it("implies the only connection", () => {
    add("dev-a", "a.example.com");
    expect(resolveConnection(undefined, m).deviceId).toBe("dev-a");
  });

  it("refuses with several and none given, listing them", () => {
    add("dev-a", "a.example.com");
    add("dev-b", "b.example.com");
    const e = catchError(() => resolveConnection(undefined, m)) as ConnectionSelectError;
    expect(e).toBeInstanceOf(ConnectionSelectError);
    expect(e.code).toBe("ambiguous");
    expect(e.candidates.map((c) => c.deviceId)).toEqual(["dev-a", "dev-b"]);
    expect(e.message).toContain(connectionLine(at(0)));
    expect(e.message).toContain(connectionLine(at(1)));
    expect(e.message).toContain("--connection");
  });

  it("a host shared by two connections is ambiguous; an unknown selector is not_found; none is no_connection", () => {
    const none = catchError(() => resolveConnection(undefined, m)) as ConnectionSelectError;
    expect(none.code).toBe("no_connection");
    expect(none.candidates).toEqual([]);
    expect((catchError(() => resolveConnection("dev-a", m)) as ConnectionSelectError).code).toBe(
      "no_connection",
    );
    add("dev-a", "a.example.com");
    add("dev-b", "a.example.com");
    add("dev-c", "c.example.com");
    const shared = catchError(() => resolveConnection("a.example.com", m)) as ConnectionSelectError;
    expect(shared.code).toBe("ambiguous");
    expect(shared.candidates.map((c) => c.deviceId)).toEqual(["dev-a", "dev-b"]);
    expect(shared.message).toContain("--connection");
    const unknown = catchError(() => resolveConnection("nope", m)) as ConnectionSelectError;
    expect(unknown.code).toBe("not_found");
    expect(unknown.candidates.map((c) => c.deviceId)).toEqual(["dev-a", "dev-b", "dev-c"]);
    expect(unknown.message).toContain('"nope"');
    expect(unknown.message).toContain(connectionLine(at(2)));
  });

  it("a selector naming an unreadable connection says why it cannot be used", () => {
    add("dev-a", "a.example.com");
    add("dev-u", "u.example.com");
    chmodSync(credentialPath(connectionDir(m, "dev-u")), 0o644);
    const e = catchError(() => resolveConnection("dev-u", m)) as ConnectionSelectError;
    expect(e.code).toBe("not_found");
    expect(e.message).toContain("readable by other users");
  });

  it("connectionLine names the host, the org and the device", () => {
    add("dev-a", "a.example.com");
    add("dev-b", "b.example.com", { deviceName: "Laptop B", orgName: "Org B" });
    expect(connectionLine(at(0))).toBe("a.example.com · org-dev-a · dev-a (dev-a)");
    expect(connectionLine(at(1))).toBe("b.example.com · Org B · Laptop B (dev-b)");
  });
});

describe("connections: paths", () => {
  it("connectionDir refuses an id that is not a safe path segment", () => {
    for (const id of ["../x", "a/b", "", ".", "..", "x".repeat(129)]) {
      expect(() => connectionDir(m, id)).toThrow(/Invalid device id/);
      expect(() => controlSocketPathFor(m, id)).toThrow(/Invalid device id/);
    }
    expect(connectionDir(m, "x".repeat(128))).toBe(join(m, "connections", "x".repeat(128)));
    expect(connectionDir(m, "Ab_9-z")).toBe(join(connectionsDir(m), "Ab_9-z"));
  });

  it("machineDirOfConnection inverts connectionDir and refuses any other directory", () => {
    expect(machineDirOfConnection(connectionDir(m, "dev-a"))).toBe(m);
    expect(() => machineDirOfConnection(m)).toThrow(/not a connection directory/);
    expect(() => machineDirOfConnection(join(m, "other", "dev-a"))).toThrow(
      /not a connection directory/,
    );
    expect(() => machineDirOfConnection(join(m, "connections", "a.b"))).toThrow(
      /not a connection directory/,
    );
  });

  it("machine.json is written 0600 with version 1; another version is refused", () => {
    const machine = join(m, "machine");
    ensureMachineFile(machine);
    const file = join(machine, "machine.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(machine).mode & 0o777).toBe(0o700);
    ensureMachineFile(machine); // present and current: left as it is
    writeFileSync(file, JSON.stringify({ version: 2 }));
    expect(() => ensureMachineFile(machine)).toThrow(/version 2/);
    writeFileSync(file, "nope");
    expect(() => ensureMachineFile(machine)).toThrow(/not valid JSON/);
  });

  it("each connection's pid and policy live in its own directory, its control socket under run/", () => {
    const d = connectionDir(m, "dev-a");
    expect([pidPath(d), policyPath(d)]).toEqual([join(d, "pid"), join(d, "policy.json")]);
    const sock = join(m, "run", `${sha16("dev-a")}.sock`);
    expect(controlSocketPath(d)).toBe(sock);
    expect(controlSocketPathFor(m, "dev-a")).toBe(sock);
    expect(runDir(m)).toBe(join(m, "run"));
    expect(controlSocketPath(connectionDir(m, "dev-b"))).not.toBe(sock);
    // a long user name still fits: the socket name has a fixed length whatever the device id
    expect(controlSocketPath(connectionDir(m, "x".repeat(128)))).toHaveLength(
      join(m, "run").length + 1 + 16 + ".sock".length,
    );
  });

  it("controlSocketPath refuses a directory that is not a connection's", () => {
    expect(() => controlSocketPath(m)).toThrow(/not a connection directory/);
  });
});

describe("connections: one scan", () => {
  it("lands every connection directory in exactly one list, each credential read once", () => {
    add("a", "a.example.com");
    add("b", "b.example.com");
    chmodSync(credentialPath(connectionDir(m, "b")), 0o644);
    mkdirSync(connectionDir(m, "empty"), { recursive: true });
    const scan = scanConnections(m);
    expect(scan.readable.map((c) => c.deviceId)).toEqual(["a"]);
    expect(scan.unreadable.map((u) => u.deviceId)).toEqual(["b"]);
    expect(scan.credentialless).toEqual(["empty"]);
  });

  it("lists logged-out connection directories (no credential.json) by id, never links or bad names", () => {
    add("a", "a.example.com");
    mkdirSync(connectionDir(m, "z-out"), { recursive: true });
    mkdirSync(connectionDir(m, "b-out"), { recursive: true });
    writeFileSync(policyPath(connectionDir(m, "b-out")), "{}");
    mkdirSync(join(m, "elsewhere"));
    symlinkSync(join(m, "elsewhere"), join(connectionsDir(m), "link-out"));
    mkdirSync(join(connectionsDir(m), "bad name"));
    writeFileSync(join(connectionsDir(m), "file-out"), "not a directory");
    // the old flat credential is no connection at all
    writeCredential(m, credOf("flat", "flat.example.com"));
    const scan = scanConnections(m);
    expect(scan.credentialless).toEqual(["b-out", "z-out"]);
    expect(scan.readable.map((c) => c.deviceId)).toEqual(["a"]);
    expect(scan.unreadable).toEqual([]);
  });

  it("is empty in every list without a connections directory", () => {
    expect(scanConnections(m)).toEqual({ readable: [], unreadable: [], credentialless: [] });
  });
});
