import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { status } from "../src/commands/status.js";
import { connectionDir } from "../src/connections.js";
import { controlSocketPath, type LiveStatus } from "../src/control/protocol.js";
import { startControlServer } from "../src/control/server.js";
import { writeCredential } from "../src/state.js";

/** The machine directory, and `dir` the connection directory in it. */
let m: string;
let dir: string;
let close: (() => Promise<void>) | undefined;
beforeEach(() => {
  m = realpathSync(mkdtempSync(join(tmpdir(), "device-status-")));
  chmodSync(m, 0o700);
  dir = connectionDir(m, "e1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  await close?.();
  close = undefined;
  rmSync(m, { recursive: true, force: true });
});

const cred = {
  url: "http://x.test",
  connectUrl: "ws://x.test/device/connect",
  credential: "cap_dev_secret_value",
  orgId: "o",
  deviceId: "e1",
  dir: "/w",
  mode: "os" as const,
  reconnectGraceSeconds: 120,
  maxFrameBytes: 16 * 1024 * 1024,
};
const LIVE: LiveStatus = {
  pid: 4242,
  version: "0.1.0",
  url: cred.url,
  orgId: cred.orgId,
  deviceId: cred.deviceId,
  mode: "os",
  connection: "online",
  since: "2026-11-19T00:00:00.000Z",
  keepAwake: { mode: "while-busy", held: false },
};

async function run(
  machineDir: string,
  json: boolean,
  opts: Partial<Parameters<typeof status>[5]> = {},
  selector?: string,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await status(
    machineDir,
    selector,
    json,
    (l) => out.push(l),
    (l) => err.push(l),
    { home: m, platform: "linux", ...opts },
  );
  return { code, out, err };
}

async function serve(stateDir: string, live: LiveStatus) {
  const server = await startControlServer({
    stateDir,
    status: () => live,
    running: () => [],
    drain: () => {},
    stop: () => {},
  });
  if (!("close" in server)) throw new Error(server.unavailable);
  const prev = close;
  close = async () => {
    await prev?.();
    await server.close();
  };
}

function addConnection(id: string, extra: Partial<typeof cred> & Record<string, unknown> = {}) {
  const d = connectionDir(m, id);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  writeCredential(d, { ...cred, deviceId: id, ...extra });
  return d;
}

describe("status: the running program's live state", () => {
  it("with a running program, status --json has control ok and the live fields", async () => {
    writeCredential(dir, cred);
    const server = await startControlServer({
      stateDir: dir,
      status: () => LIVE,
      running: () => [],
      drain: () => {},
      stop: () => {},
    });
    if (!("close" in server)) throw new Error(server.unavailable);
    close = () => server.close();
    const { code, out } = await run(m, true);
    expect(code).toBe(0);
    expect(JSON.parse(out[0] as string).connections[0]).toMatchObject({
      deviceId: "e1",
      control: "ok",
      live: LIVE,
      controlSocket: controlSocketPath(dir),
    });
    const text = await run(m, false);
    expect(text.out.join("\n")).toContain("online");
  });

  it("with no running program, control is absent and live is null", async () => {
    writeCredential(dir, cred);
    const { code, out } = await run(m, true, { kill: () => true, ps: () => undefined });
    expect(code).toBe(0);
    const shown = JSON.parse(out[0] as string).connections[0];
    expect(shown).toMatchObject({ control: "absent", live: null });
    expect(shown).not.toHaveProperty("controlReason");
  });

  it("a connection whose socket path is too long reports why there is no live state", async () => {
    const longMachine = join(m, "h".repeat(80), "capybara-device");
    const base = connectionDir(longMachine, "e1");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    writeCredential(base, cred);
    const { out } = await run(longMachine, true, { running: () => 4242 });
    expect(JSON.parse(out[0] as string).connections[0]).toMatchObject({
      control: "unavailable",
      controlReason: expect.stringContaining("103 bytes"),
      live: null,
    });
  });

  it("an answer that is not a live status is treated as no answer", async () => {
    writeCredential(dir, cred);
    const server = await startControlServer({
      stateDir: dir,
      status: () => ({ junk: true }) as unknown as LiveStatus,
      running: () => [],
      drain: () => {},
      stop: () => {},
    });
    if (!("close" in server)) throw new Error(server.unavailable);
    close = () => server.close();
    const absent = await run(m, true, { running: () => undefined });
    expect(JSON.parse(absent.out[0] as string).connections[0]).toMatchObject({
      control: "absent",
      live: null,
    });
    const runner = await run(m, true, { running: () => 4242 });
    expect(JSON.parse(runner.out[0] as string).connections[0]).toMatchObject({
      control: "unavailable",
      controlReason: expect.stringContaining("does not answer"),
      live: null,
    });
  });

  it("the credential is never printed", async () => {
    writeCredential(dir, cred);
    const server = await startControlServer({
      stateDir: dir,
      status: () => LIVE,
      running: () => [],
      drain: () => {},
      stop: () => {},
    });
    if (!("close" in server)) throw new Error(server.unavailable);
    close = () => server.close();
    for (const json of [true, false]) {
      const { out, err } = await run(m, json);
      expect([...out, ...err].join("\n")).not.toContain("cap_dev_secret_value");
    }
  });
});

describe("status: every connection of the machine", () => {
  it("lists every connection, one line each: host, org, device, state", async () => {
    const a = addConnection("dev-a", {
      url: "http://a.test",
      orgName: "Acme",
      deviceName: "Laptop",
    });
    addConnection("dev-b", { url: "http://b.test" });
    await serve(a, { ...LIVE, deviceId: "dev-a" });
    const { code, out } = await run(m, false, { running: () => undefined });
    expect(code).toBe(0);
    expect(out).toEqual([
      "a.test · Acme · Laptop (dev-a) · online",
      "b.test · o · dev-b (dev-b) · stopped",
    ]);
  });

  it("one connection that cannot be examined never hides the others", async () => {
    const a = addConnection("dev-a");
    addConnection("dev-b");
    const running = (d: string) => {
      if (d === a) throw new Error("boom");
      return undefined;
    };
    const text = await run(m, false, { running });
    expect(text.code).toBe(0);
    expect(text.out[0]).toContain("dev-a");
    expect(text.out[0]).toContain("boom");
    expect(text.out[1]).toContain("dev-b");
    expect(text.out[1]).toContain("stopped");
    const json = await run(m, true, { running });
    const shown = JSON.parse(json.out[0] ?? "").connections;
    expect(shown[0]).toMatchObject({ deviceId: "dev-a", control: "unavailable", live: null });
    expect(shown[0].controlReason).toContain("boom");
    expect(shown[1]).toMatchObject({ deviceId: "dev-b", control: "absent" });
  });

  it("--json lists every connection with its live state and never a credential", async () => {
    addConnection("dev-a");
    addConnection("dev-b");
    const { code, out } = await run(m, true, { running: () => undefined });
    expect(code).toBe(0);
    const shown = JSON.parse(out[0] as string);
    expect(shown.connections).toHaveLength(2);
    expect(shown.connections[0]).toMatchObject({ serviceInstalled: false, control: "absent" });
    expect(out.join("\n")).not.toContain("cap_dev_secret_value");
  });

  it("-c dev-b --json answers that connection alone", async () => {
    addConnection("dev-a");
    addConnection("dev-b");
    const { code, out } = await run(m, true, { running: () => undefined }, "dev-b");
    expect(code).toBe(0);
    const shown = JSON.parse(out[0] as string);
    expect(shown.deviceId).toBe("dev-b");
    expect(shown).not.toHaveProperty("connections");
  });

  it("a selector that matches nothing prints why on stderr and exits 1", async () => {
    addConnection("dev-a");
    const { code, err } = await run(m, false, {}, "nope");
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("No connection matches");
  });

  it("with no connection says so and exits 1; the old flat credential.json is ignored", async () => {
    writeCredential(m, cred);
    const text = await run(m, false);
    expect(text.code).toBe(1);
    expect(text.out).toEqual(["No connection. Run capybara-device login --url <url>."]);
    const json = await run(m, true);
    expect(json.code).toBe(1);
    expect(json.out).toEqual(['{"connections":[],"unreadable":[]}']);
  });

  it("an unreadable connection is named with its reason and the others are still shown", async () => {
    addConnection("dev-a");
    const bad = connectionDir(m, "dev-bad");
    mkdirSync(bad, { recursive: true, mode: 0o700 });
    writeFileSync(join(bad, "credential.json"), "not json", { mode: 0o644 });
    chmodSync(join(bad, "credential.json"), 0o644);
    const text = await run(m, false, { running: () => undefined });
    expect(text.code).toBe(0);
    expect(text.out[0]).toContain("dev-a");
    expect(text.out[1]).toMatch(/^dev-bad: unreadable \(/);
    const json = JSON.parse((await run(m, true, { running: () => undefined })).out[0] as string);
    expect(json.connections).toHaveLength(1);
    expect(json.unreadable[0].deviceId).toBe("dev-bad");
  });

  it("a connections/ directory that cannot be read is a fatal message", async () => {
    rmSync(join(m, "connections"), { recursive: true });
    writeFileSync(join(m, "connections"), "x");
    const { code, err, out } = await run(m, false);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("cannot be read");
  });
});
