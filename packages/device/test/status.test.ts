import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { status } from "../src/commands/status.js";
import { CONTROL_PATH_MAX_BYTES, type LiveStatus } from "../src/control/protocol.js";
import { startControlServer } from "../src/control/server.js";
import { writeCredential } from "../src/state.js";

let dir: string;
let close: (() => Promise<void>) | undefined;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "device-status-")));
  chmodSync(dir, 0o700);
});
afterEach(async () => {
  await close?.();
  close = undefined;
  rmSync(dir, { recursive: true, force: true });
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
};

async function run(stateDir: string, json: boolean, opts: Parameters<typeof status>[4] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await status(
    stateDir,
    json,
    (l) => out.push(l),
    (l) => err.push(l),
    opts,
  );
  return { code, out, err };
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
    const { code, out } = await run(dir, true);
    expect(code).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      loggedIn: true,
      deviceId: "e1",
      control: "ok",
      live: LIVE,
    });
    const text = await run(dir, false);
    expect(text.out.join("\n")).toContain("online");
  });

  it("with no running program, control is absent and live is null", async () => {
    writeCredential(dir, cred);
    const { code, out } = await run(dir, true, { kill: () => true, ps: () => undefined });
    expect(code).toBe(0);
    const shown = JSON.parse(out[0] as string);
    expect(shown).toMatchObject({ control: "absent", live: null });
    expect(shown).not.toHaveProperty("controlReason");
  });

  it("a running program whose socket path is too long is unavailable, with the reason", async () => {
    const base = join(dir, "x".repeat(Math.max(1, CONTROL_PATH_MAX_BYTES - dir.length)));
    mkdirSync(base, { mode: 0o700 });
    writeCredential(base, cred);
    const { out } = await run(base, true, { running: () => 4242 });
    expect(JSON.parse(out[0] as string)).toMatchObject({
      control: "unavailable",
      controlReason: expect.stringContaining("103 bytes"),
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
      const { out, err } = await run(dir, json);
      expect([...out, ...err].join("\n")).not.toContain("cap_dev_secret_value");
    }
  });
});
