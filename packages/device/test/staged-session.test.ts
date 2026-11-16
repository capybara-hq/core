import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceHelloV3,
  type DeviceResponseV3,
  parseDeviceFrameV3,
  type SandboxExecutionRef,
} from "@capybara-hq/plugin-sdk";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createStagedSessionState, serveStagedSession } from "../src/client.js";
import { createMacOperationBackend } from "../src/exec/mac-operation-backend.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const signal = () => AbortSignal.timeout(10000);
async function fixture(negotiate = true, bound = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-output-session-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const roots = {
    workspace: join(root, "work"),
    skills: join(root, "skills"),
    tmp: join(root, "tmp"),
  };
  await Promise.all(Object.values(roots).map((p) => mkdir(p)));
  let now = 1,
    emit: MacWorkerRequest["onOutput"],
    finish!: () => void;
  const cancelled = vi.fn(),
    launched = vi.fn();
  const result = { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  const backend = await createMacOperationBackend(
    {
      deviceId: "d",
      instanceGeneration: "g",
      stateDir: root,
      roots,
      pythonPath: "/usr/bin/python3",
      readOwnerCeiling: async () => ({
        revision: "r",
        fullAccess: true,
        roots,
        restrictedProjectReach: "os-user",
        restrictedAllowedDomains: [],
        restrictedDeniedReadRoots: [],
        preparation: {
          skillsRoot: roots.skills,
          attachmentsBase: join(roots.workspace, "attachments"),
        },
        fullNetwork: "environment",
      }),
    },
    {
      platform: "darwin",
      now: () => now,
      watch: () => () => {},
      startWorker: async (r) => {
        await r.beforeLaunch();
        await r.onLaunch({ pid: 123, token: "owned-fixture-worker" });
        launched();
        emit = r.onOutput;
        return {
          ready: Promise.resolve(),
          completion: new Promise((resolve) => {
            finish = () => resolve(result);
          }),
          cancel: async () => {
            cancelled();
            finish();
          },
        };
      },
    },
  );
  const handle = { id: "d" };
  const scope = {
    operationId: "op",
    admitBeforeMs: 1000,
    deviceId: "d",
    rootConversationId: "r",
    profileRevision: 1,
    ceilingRevision: "c",
    profile: "full-access" as const,
    actor: { accountId: "a", conversationId: "r" },
    tag: "op",
    filesystem: { kind: "device" as const },
    network: { kind: "environment" as const },
  };
  const ref = await backend
    .forExecution({ operationId: "op", orgNetwork: { kind: "open-public", hosts: [] } })
    .background.start(handle, scope, {
      command: "fixture",
      timeoutMs: 10000,
      maxOutputBytes: 4,
      taskId: "task",
      outputPath: join(roots.tmp, "task.out"),
      retainUntilMs: 2000,
      signal: signal(),
    });
  cleanups.push(async () => {
    finish();
    await backend.background.stop(handle, ref, { graceMs: 0, signal: signal() });
  });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw Error();
  cleanups.push(async () => {
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  });
  let id = 0;
  const answers = new Map<string, (r: DeviceResponseV3) => void>();
  // every response the kernel side received, in order, with the connection it arrived on
  const responses: { connection: number; res: DeviceResponseV3 }[] = [];
  let connections = 0;
  const open = async () => {
    const accepted = once(server, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(client, "open");
    const [socket] = (await accepted) as [WebSocket];
    const connection = ++connections;
    socket.on("message", (raw) => {
      const f = parseDeviceFrameV3(raw.toString(), "device", 69632);
      if (f.type === "hello" && negotiate)
        socket.send(
          JSON.stringify({
            type: "ready",
            connectionId: `connection-${connection}`,
            maxFrameBytes: 69632,
          }),
        );
      else if (f.type === "res") {
        responses.push({ connection, res: f });
        answers.get(f.id)?.(f);
      }
    });
    return { client, socket };
  };
  let { client, socket } = await open();
  const hello: DeviceHelloV3 = {
    type: "hello",
    protocol: 3,
    programVersion: "fixture",
    os: "darwin",
    arch: "arm64",
    mode: "os",
    roots,
    sessionIsolation: false,
    transport: { maxFrameBytes: 100000 },
    permissionSupport: { version: 1, restricted: null, fullAccess: false, background: false },
    ownerCeiling: {
      version: 2,
      sequence: 0,
      restrictedProjectReach: "workspace",
      revision: "r",
      fullAccess: false,
      restrictedAllowedDomains: [],
    },
    instanceGeneration: "g",
    ...(!bound && {
      instanceGeneration: null,
      permissionSupport: {
        version: 1,
        restricted: null,
        fullAccess: false,
        background: false,
        unavailableReason: "Instance binding pending",
      },
    }),
  };
  const state = createStagedSessionState({ graceMs: 10000 });
  let session = serveStagedSession(
    client,
    hello,
    { maxFrameBytes: 100000 },
    backend,
    handle,
    state,
  );
  if (negotiate) await expect.poll(() => session.ready()).toBeDefined();
  const request = (op: string, args: unknown, deadlineMs = 10000, key = String(++id)) => {
    const response = new Promise<DeviceResponseV3>((resolve) => answers.set(key, resolve));
    socket.send(JSON.stringify({ type: "req", id: key, op, args, deadlineMs }));
    return { key, response };
  };
  return {
    backend,
    handle,
    ref,
    get client() {
      return client;
    },
    get socket() {
      return socket;
    },
    get session() {
      return session;
    },
    responses,
    /** Closes the device's socket (a network blip); the session state survives. */
    disconnect: async () => {
      const closed = once(client, "close");
      client.close();
      await closed;
    },
    /** Opens a new socket served with the same session state and waits for ready. */
    reconnect: async () => {
      ({ client, socket } = await open());
      session = serveStagedSession(
        client,
        hello,
        { maxFrameBytes: 100000 },
        backend,
        handle,
        state,
      );
      await expect.poll(() => session.ready()).toBeDefined();
    },
    request,
    cancelled,
    launched,
    emit: async (b: Buffer) => emit?.(b, "stdout"),
    finish: () => finish(),
    expire: () => {
      now = 2001;
    },
  };
}
it("real session dispatch reads adjacent retained ranges, terminal data and expiry without new execution", async () => {
  const f = await fixture();
  for (const method of ["operation", "prepare", "browse"] as const)
    vi.spyOn(f.backend, method).mockImplementation(async () => {
      throw Error("No native/provisioning factory during output reads");
    });
  const bytes = Buffer.alloc(150000, 67);
  for (let p = 0; p < bytes.length; p += 65536) await f.emit(bytes.subarray(p, p + 65536));
  const read = async (offset: number, maxBytes: number, ref: SandboxExecutionRef = f.ref) => {
    const r = await f.request("backgroundReadOutput", { ref, offset, maxBytes }).response;
    if (!r.ok) throw Error(r.error.message);
    return r.result as { dataB64: string; offset: number; nextOffset: number; totalBytes: number };
  };
  expect(await read(0, 0)).toEqual({
    dataB64: "",
    offset: 0,
    nextOffset: 0,
    totalBytes: bytes.length,
  });
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const r = await read(offset, 3072);
    parts.push(Buffer.from(r.dataB64, "base64"));
    expect(r.nextOffset).toBe(offset + (parts.at(-1)?.length ?? 0));
    offset = r.nextOffset;
  }
  expect(Buffer.concat(parts)).toEqual(bytes);
  f.finish();
  await expect
    .poll(() => f.backend.background.status(f.handle, f.ref, signal()))
    .toMatchObject({ state: "exited" });
  expect(await read(0, 2)).toMatchObject({ dataB64: "Q0M=" });
  expect(
    await f.request("backgroundReadOutput", {
      ref: { ...f.ref, instanceGeneration: "wrong" },
      offset: 0,
      maxBytes: 1,
    }).response,
  ).toMatchObject({ ok: false, error: { kind: "denied" } });
  f.expire();
  expect(
    await f.request("backgroundReadOutput", { ref: f.ref, offset: 0, maxBytes: 1 }).response,
  ).toMatchObject({ ok: true, result: { unavailable: "expired" } });
  expect(f.launched).toHaveBeenCalledTimes(1);
  expect(f.cancelled).not.toHaveBeenCalled();
});
it.each(["cancel", "deadline"])("%s aborts an in-flight read only", async (mode) => {
  const f = await fixture();
  let entered!: () => void, aborted!: () => void;
  const enteredPromise = new Promise<void>((r) => {
      entered = r;
    }),
    abortedPromise = new Promise<void>((r) => {
      aborted = r;
    });
  vi.spyOn(f.backend.background, "readOutput").mockImplementation(async (_h, _r, opts) => {
    entered();
    await new Promise<void>((_resolve, reject) => {
      opts.signal.addEventListener(
        "abort",
        () => {
          aborted();
          reject(opts.signal.reason);
        },
        { once: true },
      );
    });
    throw Error();
  });
  const call = f.request(
    "backgroundReadOutput",
    { ref: f.ref, offset: 0, maxBytes: 1 },
    mode === "deadline" ? 100 : 10000,
  );
  await enteredPromise;
  if (mode === "cancel") f.socket.send(JSON.stringify({ type: "cancel", id: call.key }));
  await abortedPromise;
  expect(await f.backend.background.status(f.handle, f.ref, signal())).toEqual({
    state: "running",
  });
  expect(f.cancelled).not.toHaveBeenCalled();
});
it("refuses requests before ready and incoming frames above effective capacity", async () => {
  const f = await fixture(false);
  const closed = once(f.client, "close");
  f.request("backgroundReadOutput", { ref: f.ref, offset: 0, maxBytes: 1 });
  expect((await closed)[0]).toBe(4400);
  expect(f.cancelled).not.toHaveBeenCalled();
  const g = await fixture();
  // valid JSON frames (a cancel padded with whitespace), so only the capacity check differs
  const padded = (bytes: number) => {
    const frame = JSON.stringify({ type: "cancel", id: "unknown" });
    return frame + " ".repeat(bytes - Buffer.byteLength(frame));
  };
  expect(JSON.parse(padded(69633))).toEqual({ type: "cancel", id: "unknown" });
  g.socket.send(padded(69632));
  const fits = await g.request("backgroundReadOutput", { ref: g.ref, offset: 0, maxBytes: 0 })
    .response;
  expect(fits).toMatchObject({ ok: true });
  expect(g.client.readyState).toBe(WebSocket.OPEN);
  const tooBig = once(g.client, "close");
  g.socket.send(padded(69633));
  expect((await tooBig)[0]).toBe(4400);
});
it("answers an unbound instance and a duplicate request id without closing the socket", async () => {
  const unbound = await fixture(true, false);
  expect(
    await unbound.request("backgroundReadOutput", { ref: unbound.ref, offset: 0, maxBytes: 1 })
      .response,
  ).toMatchObject({ ok: false, error: { kind: "unsupported" } });
  expect(unbound.client.readyState).toBe(WebSocket.OPEN);
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  vi.spyOn(f.backend.background, "status").mockImplementation(async () => {
    await gate;
    return { state: "running" };
  });
  f.request("backgroundStatus", { ref: f.ref }, 10000, "dup");
  await expect.poll(() => f.backend.background.status).toHaveBeenCalledTimes(1);
  f.request("backgroundStatus", { ref: f.ref }, 10000, "dup");
  await expect
    .poll(() => f.responses.map((r) => r.res))
    .toEqual([expect.objectContaining({ id: "dup", ok: false, error: expect.anything() })]);
  expect(f.responses[0]?.res).toMatchObject({ error: { kind: "error" } });
  release();
  // the original request still gets its own answer
  await expect.poll(() => f.responses.length).toBe(2);
  expect(f.responses[1]?.res).toMatchObject({ id: "dup", ok: true, result: { state: "running" } });
  expect(f.client.readyState).toBe(WebSocket.OPEN);
});
it("a socket blip aborts in-flight reads only; other operations finish and answer after reconnect", async () => {
  const f = await fixture();
  const signals = new Map<string, AbortSignal>();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  vi.spyOn(f.backend.background, "readOutput").mockImplementation(async (_h, _r, opts) => {
    signals.set("read", opts.signal);
    await new Promise((_resolve, reject) =>
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true }),
    );
    throw Error("unreachable");
  });
  let statusCalls = 0;
  vi.spyOn(f.backend.background, "status").mockImplementation(async (_h, _r, signal) => {
    const n = ++statusCalls;
    signals.set(`status-${n}`, signal);
    if (n === 1) await gate;
    else
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    return { state: "running" };
  });
  f.request("backgroundReadOutput", { ref: f.ref, offset: 0, maxBytes: 1 }, 10000, "read");
  f.request("backgroundStatus", { ref: f.ref }, 10000, "status-done");
  f.request("backgroundStatus", { ref: f.ref }, 10000, "status-cancelled");
  await expect.poll(() => signals.size).toBe(3);
  await f.disconnect();
  // the read was sized for the old connection: aborted; the other operations keep running
  await expect.poll(() => signals.get("read")?.aborted).toBe(true);
  expect(signals.get("status-1")?.aborted).toBe(false);
  expect(signals.get("status-2")?.aborted).toBe(false);
  // finished while no socket is open: held for the grace
  release();
  await f.reconnect();
  await expect
    .poll(() => f.responses.map((r) => [r.connection, r.res.id, r.res.ok]))
    .toEqual([[2, "status-done", true]]);
  // a cancel sent on the new socket reaches the operation started on the old one
  f.socket.send(JSON.stringify({ type: "cancel", id: "status-cancelled" }));
  await expect.poll(() => signals.get("status-2")?.aborted).toBe(true);
  expect(f.cancelled).not.toHaveBeenCalled();
});
