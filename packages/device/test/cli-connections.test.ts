import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { connectionDir, connectionLine, listConnections } from "../src/connections.js";
import { writePid } from "../src/pid.js";
import {
  type Credential,
  credentialPath,
  DEFAULT_POLICY,
  readCredential,
  readPolicy,
  writeCredential,
  writePolicy,
} from "../src/state.js";

let home: string;
let out: string[];
let err: string[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "device-cli-conn-"));
  out = [];
  err = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const machine = () => join(home, "cfg", "capybara-device");
const ps = () => ({ command: "node /x/bin/capybara-device.mjs start", started: new Date(0) });
const cred = (deviceId: string, host = "x.test"): Credential => ({
  url: `https://${host}`,
  connectUrl: `wss://${host}/device/connect`,
  credential: `cap_dev_${deviceId}`,
  orgId: "org-1",
  deviceId,
  dir: join(home, "work", deviceId),
  mode: "os",
  reconnectGraceSeconds: 90,
  maxFrameBytes: 16_777_216,
});
const connect = (deviceId: string, host?: string, extra: Partial<typeof DEFAULT_POLICY> = {}) => {
  const d = connectionDir(machine(), deviceId);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  writeCredential(d, cred(deviceId, host));
  writePolicy(d, { ...DEFAULT_POLICY, ...extra });
  return d;
};
const run = (argv: string[], over: Parameters<typeof runCli>[1] = {}) =>
  runCli(argv, {
    env: { XDG_CONFIG_HOME: join(home, "cfg") },
    home,
    platform: "linux",
    ps,
    stdinIsTTY: false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  });

describe("connection selection", () => {
  it("with one connection the selector is implied", async () => {
    connect("dev-a", "x.test", { allowedDomains: ["only-a.test"] });
    expect(await run(["policy"])).toBe(0);
    expect(JSON.parse(out[0] ?? "").allowedDomains).toEqual(["only-a.test"]);
  });

  it("with two and none given, a command refuses and lists both", async () => {
    connect("dev-a", "x.test");
    connect("dev-b", "y.test");
    for (const argv of [
      ["policy"],
      ["stop"],
      ["drain"],
      ["ceiling", "show"],
      ["service", "status"],
    ]) {
      out.length = err.length = 0;
      expect(await run(argv)).toBe(1);
      for (const c of listConnections(machine()))
        expect(err.join("\n")).toContain(connectionLine(c));
    }
  });

  it("a selector by device id or host picks one; an unknown one exits 1", async () => {
    connect("dev-a", "x.test", { allowedDomains: ["a.test"] });
    connect("dev-b", "y.test", { allowedDomains: ["b.test"] });
    expect(await run(["policy", "-c", "dev-b"])).toBe(0);
    expect(JSON.parse(out[0] ?? "").allowedDomains).toEqual(["b.test"]);
    out.length = 0;
    expect(await run(["policy", "--connection", "x.test"])).toBe(0);
    expect(JSON.parse(out[0] ?? "").allowedDomains).toEqual(["a.test"]);
    expect(await run(["policy", "-c", "nope"])).toBe(1);
    expect(err.join("\n")).toContain("No connection matches");
  });

  it("every command without any connection exits 1", async () => {
    for (const argv of [
      ["policy"],
      ["stop"],
      ["drain"],
      ["ceiling", "show"],
      ["keep-awake"],
      ["service", "status"],
    ]) {
      expect(await run(argv)).toBe(1);
    }
  });

  it("start without any connection exits 0, and so does start -c of a logged-out connection", async () => {
    expect(await run(["start"])).toBe(0);
    expect(err.join("\n")).toContain("Not logged in");
    err.length = 0;
    const d = connect("dev-a");
    expect(await run(["start", "-c", "dev-zzz"])).toBe(0);
    expect(err.join("\n")).toContain("No connection dev-zzz on this machine; nothing to start.");
    // logged out: the credential is gone, the directory (policy) stays
    err.length = 0;
    rmSync(credentialPath(d));
    expect(await run(["start", "-c", "dev-a"])).toBe(0);
  });

  it("start refuses an ambiguous choice and a connection that cannot be read", async () => {
    connect("dev-a", "x.test");
    connect("dev-b", "y.test");
    expect(await run(["start"])).toBe(1);
    const broken = connectionDir(machine(), "dev-c");
    mkdirSync(broken, { recursive: true });
    writeFileSync(credentialPath(broken), "{not json", { mode: 0o600 });
    expect(await run(["start", "-c", "dev-c"])).toBe(1);
    expect(err.join("\n")).toContain("dev-c");
  });
});

describe("logout -c", () => {
  it("stops its runner and removes only its credential, keeping dev-b and its own policy", async () => {
    const a = connect("dev-a", "x.test");
    const b = connect("dev-b", "y.test");
    writePid(a, 999_101);
    const alive = new Set([999_101]);
    const sent: Array<[number, string | number | undefined]> = [];
    const kill = ((pid: number, sig?: string | number) => {
      sent.push([pid, sig]);
      if (!alive.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (sig === "SIGTERM") alive.delete(pid);
      return true;
    }) as typeof process.kill;
    expect(await run(["logout", "-c", "dev-a"], { kill })).toBe(0);
    expect(sent).toContainEqual([999_101, "SIGTERM"]);
    expect(readCredential(a)).toBeUndefined();
    expect(readPolicy(a)).toBeDefined();
    expect(readCredential(b)?.deviceId).toBe("dev-b");
  });

  it("removes the connection's login service first", async () => {
    const a = connect("dev-a");
    const unitDir = join(home, ".config", "systemd", "user");
    mkdirSync(join(unitDir, "default.target.wants"), { recursive: true });
    writeFileSync(join(unitDir, "capybara-device@.service"), "unit");
    writeFileSync(join(unitDir, "default.target.wants", "capybara-device@dev-a.service"), "");
    const ran: string[] = [];
    const runSystem = ((cmd: string, args: string[]) => {
      ran.push([cmd, ...args].join(" "));
      return "";
    }) as never;
    expect(await run(["logout"], { runSystem, sleep: async () => {} })).toBe(0);
    expect(ran.some((c) => c.includes("disable") && c.includes("capybara-device@dev-a"))).toBe(
      true,
    );
    expect(readCredential(a)).toBeUndefined();
  });

  it("names an unreadable connection by its id and still removes it", async () => {
    connect("dev-a", "x.test");
    connect("dev-b", "y.test");
    const broken = connectionDir(machine(), "dev-c");
    mkdirSync(broken, { recursive: true });
    writeFileSync(credentialPath(broken), "{not json", { mode: 0o600 });
    expect(await run(["logout", "-c", "dev-c"])).toBe(0);
    expect(() => readCredential(broken)).not.toThrow();
    expect(readCredential(broken)).toBeUndefined();
    expect(listConnections(machine())).toHaveLength(2);
  });
});

describe("logout -c of every unreadable shape", () => {
  it("removes a dangling symlinked credential.json itself", async () => {
    connect("dev-b", "y.test");
    const broken = connectionDir(machine(), "dev-c");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "policy.json"), "{}");
    symlinkSync(join(home, "nowhere.json"), credentialPath(broken));
    expect(await run(["logout", "-c", "dev-c"])).toBe(0);
    expect(out.join("\n")).toContain("Logged out");
    expect(() => lstatSync(credentialPath(broken))).toThrow();
    expect(existsSync(join(broken, "policy.json"))).toBe(true);
    expect(listConnections(machine()).map((c) => c.deviceId)).toEqual(["dev-b"]);
  });

  it("a directory at credential.json is reported with exit 1, never a crash", async () => {
    const broken = connectionDir(machine(), "dev-c");
    mkdirSync(credentialPath(broken), { recursive: true });
    expect(await run(["logout", "-c", "dev-c"])).toBe(1);
    expect(err.join("\n")).toContain("is not a file");
    expect(lstatSync(credentialPath(broken)).isDirectory()).toBe(true);
  });
});

describe("keep-awake and ceiling per connection", () => {
  it("keep-awake is set per connection", async () => {
    connect("dev-a", "x.test");
    connect("dev-b", "y.test");
    expect(await run(["keep-awake", "connected", "--yes", "-c", "dev-a"])).toBe(0);
    expect(readPolicy(connectionDir(machine(), "dev-a")).keepAwake).toBe("connected");
    expect(readPolicy(connectionDir(machine(), "dev-b")).keepAwake).toBe("while-busy");
  });

  it("ceiling show takes -c", async () => {
    connect("dev-a", "x.test");
    connect("dev-b", "y.test");
    expect(await run(["ceiling", "show", "--json", "-c", "dev-b"])).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toHaveProperty("revision");
  });
});
