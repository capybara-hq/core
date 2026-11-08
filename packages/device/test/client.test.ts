import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backoffMs, type Connection, type ConnectOptions, connect } from "../src/client.js";
import { CommandLog } from "../src/command-log.js";
import type { Credential } from "../src/state.js";
import { execArgs, FakeExecutor, FakeKernel, OK_EXEC, ROOTS, req } from "./fake-kernel.js";

let kernel: FakeKernel;
let exec: FakeExecutor;
let dir: string;
let errs: string[];
let conn: Connection | undefined;

const cred = (): Credential => ({
  url: "http://x.test",
  connectUrl: kernel.url,
  credential: "cap_dev_secret",
  orgId: "o",
  environmentId: "e1",
  dir: "/work/e1",
  mode: "os",
  reconnectGraceSeconds: 120,
  maxFrameBytes: 16 * 1024 * 1024,
});

const start = (extra: Partial<ConnectOptions> = {}, over: Partial<Credential> = {}): Connection => {
  conn = connect({ ...cred(), ...over }, exec, {
    err: (l) => errs.push(l),
    log: new CommandLog(dir),
    sleep: () => new Promise((r) => setTimeout(r, 10)),
    ...extra,
  });
  return conn;
};

beforeEach(async () => {
  kernel = new FakeKernel();
  await kernel.start();
  exec = new FakeExecutor();
  dir = mkdtempSync(join(tmpdir(), "device-client-"));
  errs = [];
  conn = undefined;
});
afterEach(async () => {
  conn?.stop();
  await conn?.done;
  await kernel.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("client", () => {
  it("sends hello and answers an exec", async () => {
    start();
    const hello = await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    expect(kernel.headers[0]?.authorization).toBe("Bearer cap_dev_secret");
    expect(kernel.headers[0]?.["x-capybara-device-protocol"]).toBe("1");
    expect(hello).toMatchObject({
      protocol: 1,
      os: process.platform === "darwin" ? "darwin" : "linux",
      mode: "os",
      roots: ROOTS,
      sessionIsolation: false,
    });
    expect(typeof hello.programVersion).toBe("string");
    kernel.send(0, req("r1", "exec", execArgs("now")));
    const res = await kernel.waitFor("res", () => kernel.of("res")[0]);
    expect(res).toEqual({ type: "res", id: "r1", ok: true, result: OK_EXEC });
    const line = JSON.parse(readFileSync(join(dir, "commands.log"), "utf8").trim());
    expect(Object.keys(line).sort()).toEqual(["actor", "exitCode", "op", "tag", "time"]);
    expect(line).toEqual({
      time: expect.any(String),
      op: "exec",
      tag: "t1",
      actor: { accountId: "acc" },
      exitCode: 0,
    });
  });

  it("answers the file operations and create", async () => {
    start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    const send = (id: string, op: string, args: unknown) => kernel.send(0, req(id, op, args));
    send("a", "writeFile", {
      path: "/work/e1/f",
      dataB64: Buffer.from("hello").toString("base64"),
    });
    send("b", "readFile", { path: "/work/e1/f", maxBytes: 3 });
    send("c", "stat", { path: "/work/e1/none" });
    send("d", "killTagged", { tags: ["t"] });
    send("e", "create", { limits: execArgs("x").limits });
    await kernel.waitFor("5 results", () => kernel.of("res").length === 5);
    const byId = Object.fromEntries(kernel.of("res").map((r) => [r.id, r]));
    expect(byId.a.result).toBeNull();
    expect(byId.b.result).toEqual({
      dataB64: Buffer.from("hel").toString("base64"),
      truncated: true,
    });
    expect(byId.c.result).toBeNull();
    expect(byId.d.result).toBeNull();
    expect(byId.e.result).toEqual({ roots: ROOTS });
  });

  it("result produced while disconnected is sent after reconnect", async () => {
    start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.send(0, req("r1", "exec", execArgs("slow")));
    await kernel.waitFor("exec started", () => exec.started.includes("slow"));
    kernel.sockets[0]?.close(1001);
    await kernel.waitFor("reconnect", () => kernel.of("hello", 1)[0]);
    // The program is connected again; but finish while disconnected: drop again first.
    const closed = new Promise((r) => kernel.sockets[1]?.once("close", r));
    kernel.sockets[1]?.close(1001);
    await closed;
    exec.release("slow");
    await kernel.waitFor("third connection", () => kernel.of("hello", 2)[0]);
    const res = await kernel.waitFor("res", () => kernel.of("res", 2)[0]);
    expect(res).toMatchObject({ id: "r1", ok: true, result: { stdout: "slow\n" } });
    expect(kernel.of("res", 0)).toHaveLength(0);
  });

  it("late reconnect receives the cancel and kills the process", async () => {
    start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.send(0, req("r1", "exec", execArgs("hang")));
    await kernel.waitFor("exec started", () => exec.started.includes("hang"));
    kernel.sockets[0]?.terminate();
    await kernel.waitFor("reconnect", () => kernel.of("hello", 1)[0]);
    kernel.send(1, { type: "cancel", id: "r1" });
    await kernel.waitFor("abort", () => exec.aborted.includes("hang"));
    await new Promise((r) => setTimeout(r, 50));
    expect(kernel.of("res")).toHaveLength(0);
  });

  it("a cancel for a request that has not started means never start it", async () => {
    start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.send(0, { type: "cancel", id: "ghost" });
    kernel.send(0, req("ghost", "exec", execArgs("never")));
    kernel.send(0, req("after", "exec", execArgs("now")));
    await kernel.waitFor("after answered", () => kernel.of("res").find((r) => r.id === "after"));
    expect(exec.started).toEqual(["now"]);
    expect(kernel.of("res").some((r) => r.id === "ghost")).toBe(false);
  });

  it("a cancel that arrives while ensureRoot runs means the command never starts", async () => {
    let open!: () => void;
    exec.rootGate = new Promise((r) => {
      open = r;
    });
    start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.send(0, req("r1", "exec", execArgs("never")));
    await new Promise((r) => setTimeout(r, 30));
    kernel.send(0, { type: "cancel", id: "r1" });
    await new Promise((r) => setTimeout(r, 30));
    open();
    exec.rootGate = undefined;
    kernel.send(0, req("r2", "exec", execArgs("now")));
    await kernel.waitFor("r2", () => kernel.of("res").find((r) => r.id === "r2"));
    expect(exec.started).toEqual(["now"]);
    expect(kernel.of("res").some((r) => r.id === "r1")).toBe(false);
  });

  it("a stop between sockets ends the backoff sleep at once", async () => {
    const c = start({
      sleep: (_ms, signal) =>
        new Promise((r) => {
          signal.addEventListener("abort", () => r(), { once: true });
          setTimeout(r, 30_000).unref();
        }),
    });
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.sockets[0]?.close(1001);
    await new Promise((r) => setTimeout(r, 100));
    c.stop();
    expect(await c.done).toBe(0);
  });

  it("a drain that ends with unsent results waits for the reconnect, then exits", async () => {
    const c = start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.send(0, req("r1", "exec", execArgs("slow")));
    await kernel.waitFor("started", () => exec.started.includes("slow"));
    const closed = new Promise((r) => kernel.sockets[0]?.once("close", r));
    kernel.sockets[0]?.close(4001);
    await closed;
    c.drain();
    exec.release("slow");
    expect(await c.done).toBe(0);
    const res = await kernel.waitFor("r1", () => kernel.of("res", 1).find((r) => r.id === "r1"));
    expect(res).toMatchObject({ ok: true });
  });

  it("the backoff keeps growing when connections close at once", async () => {
    const sleeps: number[] = [];
    const c = start({
      random: () => 1,
      stableMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    for (let i = 0; i < 4; i++) {
      await kernel.waitFor(`hello ${i}`, () => kernel.of("hello", i)[0]);
      kernel.sockets[i]?.close(1001);
    }
    await kernel.waitFor("4 sleeps", () => sleeps.length >= 4);
    expect(sleeps.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    c.stop();
  });

  it("the backoff resets once a connection stayed up", async () => {
    const sleeps: number[] = [];
    start({
      random: () => 1,
      stableMs: 20,
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    for (let i = 0; i < 3; i++) {
      await kernel.waitFor(`hello ${i}`, () => kernel.of("hello", i)[0]);
      await new Promise((r) => setTimeout(r, 60));
      kernel.sockets[i]?.close(1001);
    }
    await kernel.waitFor("3 sleeps", () => sleeps.length >= 3);
    expect(sleeps.slice(0, 3)).toEqual([1000, 1000, 1000]);
  });

  it("a socket that hears nothing from the server is terminated and reconnected", async () => {
    start({ livenessMs: 100 });
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    await kernel.waitFor("second hello", () => kernel.of("hello", 1)[0]);
  });

  it("a vanished root answers fs_gone", async () => {
    exec.root = "gone";
    start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.send(0, req("r1", "exec", execArgs("now")));
    kernel.send(0, req("r2", "readFile", { path: "/work/e1/x", maxBytes: 1 }));
    await kernel.waitFor("2 results", () => kernel.of("res").length === 2);
    for (const r of kernel.of("res")) {
      expect(r).toMatchObject({ ok: false, error: { kind: "fs_gone" } });
    }
    expect(exec.started).toEqual([]);
  });

  it("426 exits 0 (terminal) with the upgrade message", async () => {
    kernel.rejectWith = 426;
    const c = start();
    expect(await c.done).toBe(0);
    expect(errs).toEqual([
      "This capybara-device is too old for the deployment. Upgrade it: npm install -g @capybara-hq/device",
    ]);
  });

  it("401 and close 4003 exit 0 (terminal) with the disconnected message", async () => {
    const msg =
      "This machine was disconnected from the deployment. Run capybara-device logout, then capybara-device login.";
    kernel.rejectWith = 401;
    expect(await start().done).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(errs).toEqual([msg]);

    kernel.rejectWith = undefined;
    errs.length = 0;
    const c = start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.sockets.at(-1)?.close(4003);
    expect(await c.done).toBe(0);
    expect(errs).toEqual([msg]);
  });

  it("close 4002 exits 0 (terminal) saying the machine connected elsewhere", async () => {
    const c = start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.sockets[0]?.close(4002);
    expect(await c.done).toBe(0);
    expect(errs[0]).toContain("connected elsewhere");
  });

  it("reconnects after 4001 and 1001", async () => {
    start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.sockets[0]?.close(4001);
    await kernel.waitFor("second hello", () => kernel.of("hello", 1)[0]);
    kernel.sockets[1]?.close(1001);
    await kernel.waitFor("third hello", () => kernel.of("hello", 2)[0]);
  });

  it("a stop op is answered, then the program exits 0 (terminal)", async () => {
    const c = start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.send(0, req("s1", "stop", { reason: "revoked" }));
    expect(await c.done).toBe(0);
    const res = await kernel.waitFor("res", () => kernel.of("res")[0]);
    expect(res).toEqual({ type: "res", id: "s1", ok: true, result: null });
    expect(errs[0]).toContain("disconnected");
  });

  it("drain refuses new ops and exits after running ones", async () => {
    const c = start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.send(0, req("r1", "exec", execArgs("slow")));
    await kernel.waitFor("started", () => exec.started.includes("slow"));
    c.drain();
    kernel.send(0, req("r2", "exec", execArgs("now")));
    const refused = await kernel.waitFor("r2", () => kernel.of("res").find((r) => r.id === "r2"));
    expect(refused).toMatchObject({ ok: false, error: { kind: "error", message: "draining" } });
    expect(exec.started).toEqual(["slow"]);
    exec.release("slow");
    expect(await c.done).toBe(0);
    await kernel.waitFor("r1", () => kernel.of("res").find((r) => r.id === "r1"));
  });

  it("a stop op for a deleted environment exits 0 with the deleted message", async () => {
    const c = start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.send(0, req("s1", "stop", { reason: "deleted" }));
    expect(await c.done).toBe(0);
    expect(errs[0]).toContain("deleted");
  });

  it("a 404 upgrade keeps retrying and says /device/connect must be routed, once a minute", async () => {
    kernel.rejectWith = 404;
    let clock = 0;
    start({ now: () => clock });
    await kernel.waitFor("3 attempts", () => kernel.headers.length >= 3);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("HTTP 404");
    expect(errs[0]).toContain("must route /device/connect to its gateway");
    clock = 61_000;
    const seen = kernel.headers.length;
    await kernel.waitFor("another attempt", () => kernel.headers.length > seen + 1);
    expect(errs).toHaveLength(2);
    kernel.rejectWith = undefined;
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
  });

  it("another non-101 answer is reported with its status and retried", async () => {
    kernel.rejectWith = 502;
    start();
    await kernel.waitFor("2 attempts", () => kernel.headers.length >= 2);
    expect(errs).toEqual([`Connecting to ${kernel.url} failed: HTTP 502. Retrying.`]);
    kernel.rejectWith = undefined;
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
  });

  it("close 4400 is reported with its reason and retried", async () => {
    start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.sockets[0]?.close(4400, "not authenticated");
    await kernel.waitFor("second hello", () => kernel.of("hello", 1)[0]);
    expect(errs).toEqual([
      "The deployment closed the connection: 4400 not authenticated. Retrying.",
    ]);
  });

  it("an unreachable deployment is reported and retried", async () => {
    const clock = 0;
    let attempts = 0;
    const c = start(
      {
        now: () => clock,
        sleep: () => {
          attempts++;
          return new Promise((r) => setTimeout(r, 5));
        },
      },
      { connectUrl: "ws://127.0.0.1:1/device/connect" },
    );
    await kernel.waitFor("3 attempts", () => attempts >= 3);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^Cannot reach ws:\/\/127\.0\.0\.1:1\/device\/connect: .*Retrying\.$/);
    c.stop();
    expect(await c.done).toBe(0);
  });

  it("a result larger than the frame limit is answered with an error", async () => {
    start({}, { maxFrameBytes: 200 });
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    exec.files.set("/work/e1/big", new Uint8Array(1000));
    kernel.send(0, req("r1", "readFile", { path: "/work/e1/big", maxBytes: 1000 }));
    kernel.send(0, req("r2", "readFile", { path: "/work/e1/big", maxBytes: 10 }));
    await kernel.waitFor("2 results", () => kernel.of("res").length === 2);
    const byId = Object.fromEntries(kernel.of("res").map((r) => [r.id, r]));
    expect(byId.r1).toEqual({
      type: "res",
      id: "r1",
      ok: false,
      error: { kind: "error", message: "result larger than the connection's frame limit" },
    });
    expect(byId.r2).toMatchObject({ ok: true, result: { truncated: true } });
  });

  it("answers an invalid request with an error", async () => {
    start();
    await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    kernel.send(0, { type: "req", id: "bad", op: "exec", args: {}, deadlineMs: 1 });
    const r = await kernel.waitFor("res", () => kernel.of("res")[0]);
    expect(r).toMatchObject({ id: "bad", ok: false, error: { kind: "error" } });
  });
});

describe("backoff", () => {
  it("doubles from 1 s to 60 s with jitter", () => {
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(10, () => 1)).toBe(60_000);
    expect(backoffMs(0, () => 0)).toBe(500);
  });
});
