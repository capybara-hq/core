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
import { serveStagedSession } from "../src/client.js";
import { createMacOperationBackend } from "../src/exec/mac-operation-backend.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const signal = () => AbortSignal.timeout(10000);
async function fixture(negotiate = true) {
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
  const accepted = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(client, "open");
  const [socket] = (await accepted) as [WebSocket];
  let id = 0;
  const answers = new Map<string, (r: DeviceResponseV3) => void>();
  socket.on("message", (raw) => {
    const f = parseDeviceFrameV3(raw.toString(), "device", 69632);
    if (f.type === "hello" && negotiate)
      socket.send(
        JSON.stringify({ type: "ready", connectionId: "connection", maxFrameBytes: 69632 }),
      );
    else if (f.type === "res") answers.get(f.id)?.(f);
  });
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
  };
  const session = serveStagedSession(client, hello, { maxFrameBytes: 100000 }, backend, handle);
  if (negotiate) await expect.poll(() => session.ready()).toBeDefined();
  const request = (op: string, args: unknown, deadlineMs = 10000) => {
    const key = String(++id);
    const response = new Promise<DeviceResponseV3>((resolve) => answers.set(key, resolve));
    socket.send(JSON.stringify({ type: "req", id: key, op, args, deadlineMs }));
    return { key, response };
  };
  return {
    backend,
    handle,
    ref,
    client,
    socket,
    session,
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
    expect(r.nextOffset).toBe(offset + parts.at(-1)!.length);
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
  const tooBig = once(g.client, "close");
  g.socket.send(" ".repeat(69633));
  expect((await tooBig)[0]).toBe(4400);
});
