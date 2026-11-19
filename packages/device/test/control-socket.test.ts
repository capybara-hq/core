import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunningOperation } from "../src/activity.js";
import { queryControl } from "../src/control/client.js";
import {
  CONTROL_PATH_MAX_BYTES,
  controlSocketPath,
  type LiveStatus,
} from "../src/control/protocol.js";
import { startControlServer } from "../src/control/server.js";

let dir: string;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "device-ctl-")));
  chmodSync(dir, 0o700);
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  rmSync(dir, { recursive: true, force: true });
});

const STATUS: LiveStatus = {
  pid: 4242,
  version: "0.1.0",
  url: "http://x.test",
  orgId: "o",
  deviceId: "e1",
  mode: "os",
  connection: "online",
  since: "2026-11-19T00:00:00.000Z",
  keepAwake: { mode: "while-busy", held: false },
};
const RUNNING: RunningOperation[] = [
  {
    tag: "t1",
    conversationId: "c",
    accountId: "a",
    isolation: "restricted",
    startedAt: "2026-11-19T00:00:00.000Z",
  },
];

async function serve(stateDir = dir, calls: string[] = []) {
  const server = await startControlServer({
    stateDir,
    status: () => STATUS,
    running: () => RUNNING,
    drain: () => calls.push("drain"),
    stop: () => calls.push("stop"),
  });
  if ("close" in server) closers.push(() => server.close());
  return server;
}

/** A raw connection to the socket that collects every line it receives. */
async function connect(stateDir = dir) {
  const sock: Socket = createConnection(controlSocketPath(stateDir));
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  sock.setEncoding("utf8");
  const lines: unknown[] = [];
  const waiters: (() => void)[] = [];
  let buf = "";
  sock.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
    for (const w of waiters.splice(0)) w();
  });
  closers.push(async () => {
    sock.destroy();
  });
  /** Waits until `n` lines arrived in total. */
  const next = async (n: number): Promise<unknown[]> => {
    while (lines.length < n) await new Promise<void>((r) => waiters.push(r));
    return lines.slice(0, n);
  };
  return { sock, lines, next, send: (text: string) => sock.write(text) };
}

describe("control socket: where and with which permissions", () => {
  it("the socket is 0600 in an owner-only state dir", async () => {
    const server = await serve();
    expect(server).not.toHaveProperty("unavailable");
    const st = lstatSync(controlSocketPath(dir));
    expect(controlSocketPath(dir)).toBe(join(dir, "control.sock"));
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.uid).toBe(process.getuid?.());
  });

  it("a state dir readable by others gets no socket", async () => {
    chmodSync(dir, 0o755);
    const server = await serve();
    expect(server).toEqual({ unavailable: expect.stringContaining("0755") });
    expect(existsSync(controlSocketPath(dir))).toBe(false);
  });

  it("a stale socket file is replaced", async () => {
    // a socket file nothing listens on: a hard link to a bound socket outlives its server
    const other = join(dir, "other.sock");
    const old = createServer();
    await new Promise<void>((r) => old.listen(other, r));
    linkSync(other, controlSocketPath(dir));
    await new Promise<void>((r) => old.close(() => r()));
    expect(lstatSync(controlSocketPath(dir)).isSocket()).toBe(true);
    const server = await serve();
    expect(server).not.toHaveProperty("unavailable");
    expect(await queryControl(dir, "status")).toEqual(STATUS);
  });

  it("a live socket is not replaced", async () => {
    const first = await serve();
    expect(first).not.toHaveProperty("unavailable");
    const second = await serve();
    expect(second).toEqual({ unavailable: expect.stringContaining("already answers") });
    // the first keeps answering on its socket
    expect(await queryControl(dir, "status")).toEqual(STATUS);
  });

  it("a file at the path that is not a socket is left alone", async () => {
    writeFileSync(controlSocketPath(dir), "keep me");
    const server = await serve();
    expect(server).toEqual({ unavailable: expect.stringContaining("not a socket") });
    expect(readFileSync(controlSocketPath(dir), "utf8")).toBe("keep me");
  });

  it("a path over 103 bytes is unavailable", async () => {
    const base = join(dir, "x".repeat(Math.max(1, CONTROL_PATH_MAX_BYTES - dir.length)));
    mkdirSync(base, { mode: 0o700 });
    expect(Buffer.byteLength(controlSocketPath(base))).toBeGreaterThan(103);
    const server = await serve(base);
    expect(server).toEqual({ unavailable: expect.stringContaining("103 bytes") });
    expect(existsSync(controlSocketPath(base))).toBe(false);
  });

  it("close removes the socket file", async () => {
    const server = await serve();
    if (!("close" in server)) throw new Error("unavailable");
    await server.close();
    expect(existsSync(controlSocketPath(dir))).toBe(false);
  });
});

describe("control socket: the protocol", () => {
  it("status, running, drain and stop answer by id", async () => {
    const calls: string[] = [];
    await serve(dir, calls);
    const c = await connect();
    c.send(
      `${JSON.stringify({ id: 1, op: "status" })}\n${JSON.stringify({ id: 2, op: "running" })}\n`,
    );
    c.send(`${JSON.stringify({ id: 3, op: "drain" })}\n${JSON.stringify({ id: 4, op: "stop" })}\n`);
    expect(await c.next(4)).toEqual([
      { id: 1, ok: true, result: STATUS },
      { id: 2, ok: true, result: RUNNING },
      { id: 3, ok: true, result: null },
      { id: 4, ok: true, result: null },
    ]);
    expect(calls).toEqual(["drain", "stop"]);
  });

  it("subscribe receives status events", async () => {
    const server = await serve();
    if (!("publish" in server)) throw new Error("unavailable");
    const c = await connect();
    c.send(`${JSON.stringify({ id: 7, op: "subscribe" })}\n`);
    expect(await c.next(1)).toEqual([{ id: 7, ok: true, result: STATUS }]);
    const offline: LiveStatus = { ...STATUS, connection: "offline", offlineReason: "gone" };
    server.publish(offline);
    expect((await c.next(2))[1]).toEqual({ event: "status", status: offline });
    // a connection that did not subscribe gets no events
    const quiet = await connect();
    server.publish(STATUS);
    quiet.send(`${JSON.stringify({ id: 1, op: "status" })}\n`);
    expect(await quiet.next(1)).toEqual([{ id: 1, ok: true, result: STATUS }]);
    expect((await c.next(3))[2]).toEqual({ event: "status", status: STATUS });
  });

  it("an unknown op answers ok false", async () => {
    await serve();
    const c = await connect();
    c.send(`${JSON.stringify({ id: 5, op: "exec" })}\n`);
    expect(await c.next(1)).toEqual([
      { id: 5, ok: false, error: { code: "unknown_op", message: expect.any(String) } },
    ]);
  });

  it("a malformed line answers an error and keeps the connection", async () => {
    await serve();
    const c = await connect();
    c.send("{not json\n");
    c.send(`${JSON.stringify({ op: "status" })}\n`);
    c.send(`${JSON.stringify({ id: 9, op: "status" })}\n`);
    expect(await c.next(3)).toEqual([
      { id: 0, ok: false, error: { code: "bad_request", message: expect.any(String) } },
      { id: 0, ok: false, error: { code: "bad_request", message: expect.any(String) } },
      { id: 9, ok: true, result: STATUS },
    ]);
  });

  it("the line limit counts bytes: a line of fewer characters but more bytes ends the connection", async () => {
    await serve();
    const c = await connect();
    const closed = new Promise<void>((r) => c.sock.once("close", () => r()));
    // 40000 characters, 80000 bytes in UTF-8: under the limit in characters, over it in bytes
    c.send(`${JSON.stringify({ id: 1, op: "status", pad: "é".repeat(40_000) })}\n`);
    await closed;
    expect(c.lines).toEqual([
      {
        id: 0,
        ok: false,
        error: { code: "bad_request", message: expect.stringContaining("bytes") },
      },
    ]);
  });

  it("a subscriber that stops reading is disconnected once its unread answers pass 1 MiB", async () => {
    const server = await serve();
    if (!("publish" in server)) throw new Error("unavailable");
    const c = await connect();
    c.send(`${JSON.stringify({ id: 1, op: "subscribe" })}\n`);
    await c.next(1);
    c.sock.pause();
    const closed = new Promise<void>((r) => c.sock.once("close", () => r()));
    const big: LiveStatus = { ...STATUS, connection: "offline", offlineReason: "x".repeat(8192) };
    // 4 MiB of events while the peer reads nothing
    for (let i = 0; i < 512; i++) server.publish(big);
    c.sock.resume();
    await closed;
    // it never received all of them: the server closed the connection
    expect(c.lines.length).toBeLessThan(513);
    // the server keeps answering others
    expect(await queryControl(dir, "status")).toEqual(STATUS);
  });

  it("queryControl answers undefined when no runner listens", async () => {
    expect(await queryControl(dir, "status")).toBeUndefined();
    expect(await queryControl(join(dir, "missing"), "status")).toBeUndefined();
  });

  it("queryControl answers the result of one op", async () => {
    const calls: string[] = [];
    await serve(dir, calls);
    expect(await queryControl(dir, "running")).toEqual(RUNNING);
    expect(await queryControl(dir, "drain")).toBeNull();
    expect(calls).toEqual(["drain"]);
  });
});
