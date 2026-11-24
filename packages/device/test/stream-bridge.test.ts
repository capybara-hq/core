import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIAL_IN_STREAM_INITIAL_CREDIT } from "@capybara-hq/plugin-sdk";
import type { DeviceHello } from "@capybara-hq/plugin-sdk/device-protocol";
import { afterEach, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { DialInStreamBridge } from "../src/services/stream-bridge.js";
import { ServiceSupervisor } from "../src/services/supervisor.js";
import { createStagedSessionState, serveStagedSession } from "../src/staged-session.js";
import { readyFrame, stagedHello } from "./dial-in-wire.js";
import { bytes, echoLauncher } from "./service-fixture.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const signal = () => AbortSignal.timeout(10_000);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

type Frame = {
  type: string;
  streamId: string;
  data?: string;
  messages?: number;
  reason?: string;
  ok?: boolean;
  error?: string;
};

/** The kernel's end: every frame the bridge sends, and a way to wait for one. */
function kernelEnd(maxFrameBytes = 65536) {
  const frames: Frame[] = [];
  const waiters: { pred: (f: Frame[]) => boolean; resolve: () => void }[] = [];
  const check = () => {
    for (const w of [...waiters])
      if (w.pred(frames)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
  };
  return {
    frames,
    transport: {
      send(text: string) {
        frames.push(JSON.parse(text) as Frame);
        check();
        return true;
      },
      maxFrameBytes: () => maxFrameBytes,
    },
    /** Resolves once `pred` holds for the frames sent so far. */
    until(pred: (f: Frame[]) => boolean) {
      return new Promise<void>((resolve) => {
        waiters.push({ pred, resolve });
        check();
      });
    },
    of: (type: string) => frames.filter((f) => f.type === type),
  };
}

async function fixture(maxFrameBytes?: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-bridge-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const echo = echoLauncher();
  const supervisor = new ServiceSupervisor({
    deviceDir: root,
    workspace,
    launcher: () => echo.launcher,
    socketAliasRoot: join(root, "a"),
  });
  cleanups.push(() => supervisor.stopAll(signal()));
  await supervisor.ensure(
    { name: "browser", entry: "main.js", args: [], files: { "main.js": bytes("//") } },
    undefined,
    signal(),
  );
  const kernel = kernelEnd(maxFrameBytes);
  const bridge = new DialInStreamBridge(kernel.transport, (body, sig) =>
    supervisor.openStream(body, sig),
  );
  cleanups.push(async () => bridge.closeAll("test over"));
  return { supervisor, echo, kernel, bridge };
}

const open = async (
  f: Awaited<ReturnType<typeof fixture>>,
  streamId = "s1",
  body: unknown = { service: "browser" },
) => {
  f.bridge.onFrame({ type: "stream-open", streamId, body });
  await f.kernel.until((fs) =>
    fs.some((x) => x.type === "stream-opened" && x.streamId === streamId),
  );
  return f.kernel.frames.find((x) => x.type === "stream-opened" && x.streamId === streamId);
};

it("stream bridge relays messages and honours credit", async () => {
  const f = await fixture();
  expect(await open(f)).toEqual({ type: "stream-opened", streamId: "s1", ok: true });
  // kernel -> service -> kernel, and one credit per message the machine consumed
  for (const m of ["a", "b", "c"])
    f.bridge.onFrame({ type: "stream-data", streamId: "s1", data: b64(m) });
  await f.kernel.until((fs) => fs.filter((x) => x.type === "stream-data").length === 3);
  await f.kernel.until((fs) => fs.filter((x) => x.type === "stream-credit").length === 3);
  expect(f.kernel.of("stream-data").map((x) => unb64(x.data as string))).toEqual(["a", "b", "c"]);
  expect(f.kernel.of("stream-credit").every((x) => x.messages === 1)).toBe(true);
  // the machine holds 8 - 3 = 5 credits now: a burst of 20 sends 5 and waits for more
  f.bridge.onFrame({ type: "stream-data", streamId: "s1", data: b64("burst:20") });
  const sentBefore = () => f.kernel.of("stream-data").length;
  await f.kernel.until(() => sentBefore() === DIAL_IN_STREAM_INITIAL_CREDIT);
  // nothing more goes out until the kernel grants credit: a later echo round trip proves it
  // (the service has written all 20, the bridge holds them)
  await f.kernel.until((fs) => fs.filter((x) => x.type === "stream-credit").length === 4);
  expect(sentBefore()).toBe(DIAL_IN_STREAM_INITIAL_CREDIT);
  f.bridge.onFrame({ type: "stream-credit", streamId: "s1", messages: 4 });
  await f.kernel.until(() => sentBefore() === DIAL_IN_STREAM_INITIAL_CREDIT + 4);
  f.bridge.onFrame({ type: "stream-credit", streamId: "s1", messages: 100 });
  await f.kernel.until(() => sentBefore() === 3 + 20);
  expect(
    f.kernel
      .of("stream-data")
      .slice(3)
      .map((x) => unb64(x.data as string)),
  ).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
  expect(f.kernel.of("stream-close")).toEqual([]);
});

it("a kernel exceeding its credit gets the stream closed", async () => {
  const f = await fixture();
  await open(f);
  // nine messages in one go: the machine granted eight, none consumed yet
  for (let i = 0; i < DIAL_IN_STREAM_INITIAL_CREDIT + 1; i++)
    f.bridge.onFrame({ type: "stream-data", streamId: "s1", data: b64(`x${i}`) });
  await f.kernel.until((fs) => fs.some((x) => x.type === "stream-close"));
  expect(f.kernel.of("stream-close")).toEqual([
    { type: "stream-close", streamId: "s1", reason: "credit exceeded" },
  ]);
  await f.echo.untilStreamEnds(1);
});

it("a service message larger than the frame capacity closes the stream, never split", async () => {
  const f = await fixture(2048);
  await open(f);
  f.bridge.onFrame({ type: "stream-data", streamId: "s1", data: b64("big:4000") });
  await f.kernel.until((fs) => fs.some((x) => x.type === "stream-close"));
  expect(f.kernel.of("stream-data")).toEqual([]);
  expect(f.kernel.of("stream-close")[0]?.reason).toMatch(/frame capacity/);
});

it("stream closes when the service exits", async () => {
  const f = await fixture();
  await open(f);
  f.echo.exitAll(0);
  await f.kernel.until((fs) => fs.some((x) => x.type === "stream-close"));
  expect(f.kernel.of("stream-close")[0]).toMatchObject({ streamId: "s1" });
  // frames after the close reach nothing and send nothing
  f.bridge.onFrame({ type: "stream-data", streamId: "s1", data: b64("late") });
  expect(f.kernel.of("stream-close")).toHaveLength(1);
});

it("a kernel close ends the service connection", async () => {
  const f = await fixture();
  await open(f);
  f.bridge.onFrame({ type: "stream-close", streamId: "s1", reason: "viewer left" });
  await f.echo.untilStreamEnds(1);
  expect(f.kernel.of("stream-close")).toEqual([]);
});

it("the dial-in socket closing ends every stream's service connection", async () => {
  const f = await fixture();
  await open(f, "s1");
  await open(f, "s2");
  f.bridge.closeAll("socket closed");
  await f.echo.untilStreamEnds(2);
});

it("refuses a stream to a service that is not running or a malformed target", async () => {
  const f = await fixture();
  expect(await open(f, "s1", { service: "other" })).toMatchObject({
    ok: false,
    error: expect.stringMatching(/not running/),
  });
  expect(await open(f, "s2", { unixSocket: "/var/run/docker.sock" })).toMatchObject({ ok: false });
  expect(await open(f, "s3", { service: "Bad Name" })).toMatchObject({ ok: false });
});

it("the staged session serves service bodies and stream frames on its socket", async () => {
  const f = await fixture();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw Error("no address");
  cleanups.push(async () => {
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const accepted = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(client, "open");
  const [socket] = (await accepted) as [WebSocket];
  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];
  const until = async (pred: () => boolean) => {
    while (!pred()) await new Promise<void>((r) => waiters.push(r));
  };
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame & { id?: string; body?: unknown };
    if (frame.type === "hello") socket.send(readyFrame("c1"));
    frames.push(frame);
    for (const w of waiters.splice(0)) w();
  });
  const roots = { workspace: "/w", skills: "/s", tmp: "/t" };
  const body: DeviceHello = {
    mode: "os",
    roots,
    sessionIsolation: false,
    permissionSupport: {
      version: 2,
      restricted: null,
      boundary: "operation",
      network: { openPublic: false, allowlist: false, perOperationHosts: false },
      outsideSandbox: false,
      background: false,
    },
    ownerCeiling: {
      version: 3,
      sequence: 0,
      projectReach: "workspace",
      revision: "r",
      outsideSandbox: false,
      network: "allowlist",
      allowedDomains: [],
    },
    instanceGeneration: "g",
  };
  serveStagedSession(
    client,
    stagedHello(body),
    { maxFrameBytes: 69632 },
    // services and streams never reach the operation backend
    {} as MacOperationBackend,
    { id: "d" },
    createStagedSessionState({ graceMs: 0 }),
    undefined,
    undefined,
    undefined,
    f.supervisor,
  );
  await until(() => frames.some((x) => x.type === "hello"));
  socket.send(
    JSON.stringify({
      type: "req",
      id: "r1",
      deadlineMs: 5000,
      body: { op: "service.request", name: "browser", body: b64("ping"), timeoutMs: 5000 },
    }),
  );
  await until(() => frames.some((x) => x.type === "res"));
  expect(frames.find((x) => x.type === "res")).toEqual({
    type: "res",
    id: "r1",
    body: { ok: true, result: { body: b64("echo:ping") } },
  });
  socket.send(
    JSON.stringify({ type: "stream-open", streamId: "s1", body: { service: "browser" } }),
  );
  await until(() => frames.some((x) => x.type === "stream-opened"));
  socket.send(JSON.stringify({ type: "stream-data", streamId: "s1", data: b64("hi") }));
  await until(() => frames.some((x) => x.type === "stream-data"));
  expect(frames.filter((x) => x.type.startsWith("stream-"))).toEqual(
    expect.arrayContaining([
      { type: "stream-opened", streamId: "s1", ok: true },
      { type: "stream-data", streamId: "s1", data: b64("hi") },
    ]),
  );
  // the socket's close ends the service connection
  client.close();
  await f.echo.untilStreamEnds(1);
});

it("data before the stream opened closes it", async () => {
  const kernel = kernelEnd();
  // an opener that never finishes: the service connection is still being made
  const bridge = new DialInStreamBridge(kernel.transport, () => new Promise(() => {}));
  bridge.onFrame({ type: "stream-open", streamId: "s1", body: { service: "browser" } });
  bridge.onFrame({ type: "stream-data", streamId: "s1", data: b64("early") });
  expect(kernel.of("stream-close")).toEqual([
    { type: "stream-close", streamId: "s1", reason: "data before open" },
  ]);
});
