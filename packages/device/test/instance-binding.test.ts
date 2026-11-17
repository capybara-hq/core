import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceHelloV3,
  type DeviceResponseV3,
  parseDeviceFrameV3,
  type SandboxOperationScope,
} from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { BINDING_FILE, InstanceBinder } from "../src/exec/instance-binding.js";
import { createMacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { RuntimeManifestError } from "../src/exec/runtime-manifest.js";
import { createStagedSessionState, serveStagedSession } from "../src/staged-session.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const signal = () => AbortSignal.timeout(10000);
const G1 = "1700000000001",
  G2 = "1700000000002";
const B1 = "6f1e0a52-8f5b-4d5e-9a1c-1f0e2d3c4b51",
  B2 = "6f1e0a52-8f5b-4d5e-9a1c-1f0e2d3c4b52";
const owner = {
  version: 2 as const,
  sequence: 4,
  restrictedProjectReach: "workspace" as const,
  revision: "owner-r",
  fullAccess: true,
  restrictedAllowedDomains: [],
};
const verified = {
  runtimeHash: "a".repeat(64),
  helperHash: "b".repeat(64),
  imageFingerprint: "c".repeat(64),
};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-binding-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const roots = {
    workspace: join(root, "work"),
    skills: join(root, "skills"),
    tmp: join(root, "tmp"),
  };
  await Promise.all(Object.values(roots).map((p) => mkdir(p)));
  const finishers: (() => void)[] = [];
  cleanups.push(async () => {
    for (const f of finishers) f();
  });
  const created: string[] = [];
  let runtime = { ...verified };
  let verifyFails = false;
  const createBackend = async (instanceGeneration: string) => {
    created.push(instanceGeneration);
    return createMacOperationBackend(
      {
        deviceId: "d",
        instanceGeneration,
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
          preparation: { skillsRoot: roots.skills, attachmentsBase: join(roots.workspace, "a") },
          fullNetwork: "environment",
        }),
      },
      {
        platform: "darwin",
        now: () => 1,
        watch: () => () => {},
        startWorker: async (r) => {
          await r.beforeLaunch();
          await r.onLaunch({ pid: 123, token: "owned-fixture-worker" });
          let finish!: () => void;
          const completion = new Promise<never>((resolve) => {
            finish = () =>
              resolve({
                stdout: "",
                stderr: "",
                exitCode: 0,
                timedOut: false,
                truncated: false,
              } as never);
          });
          finishers.push(finish);
          return { ready: Promise.resolve(), completion, cancel: async () => finish() };
        },
      },
    );
  };
  const binder = () =>
    new InstanceBinder({
      deviceId: "d",
      stateDir: root,
      createBackend,
      verify: async () => {
        if (verifyFails) throw new RuntimeManifestError("Installed helpers differ (changed x)");
        return runtime;
      },
      ownerReport: async () => owner,
    });
  const scope = (operationId: string): SandboxOperationScope => ({
    operationId,
    admitBeforeMs: 1000,
    deviceId: "d",
    rootConversationId: "r",
    profileRevision: 1,
    ceilingRevision: "c",
    profile: "full-access",
    actor: { accountId: "a", conversationId: "r" },
    tag: operationId,
    filesystem: { kind: "device" },
    network: { kind: "environment" },
  });
  const startTask = async (b: InstanceBinder, operationId: string) => {
    const bound = b.current();
    if (!bound) throw new Error("unbound");
    return bound.backend
      .forExecution({ operationId, orgNetwork: { kind: "open-public", hosts: [] } })
      .background.start(bound.handle, scope(operationId), {
        command: "fixture",
        timeoutMs: 10000,
        maxOutputBytes: 4,
        taskId: operationId,
        outputPath: join(roots.tmp, `${operationId}.out`),
        retainUntilMs: 2000,
        signal: signal(),
      });
  };
  return {
    root,
    roots,
    binder,
    created,
    finishers,
    startTask,
    setRuntime: (r: typeof verified) => {
      runtime = r;
    },
    failVerify: (v: boolean) => {
      verifyFails = v;
    },
  };
}
const request = (instanceGeneration: string, bindingId: string, previous: string | null) => ({
  instanceId: "d",
  instanceGeneration,
  bindingId,
  expectedPreviousGeneration: previous,
});

describe("device binding", () => {
  it("binds only by request, durably, and retries idempotently", async () => {
    const f = await fixture();
    const b = f.binder();
    expect(b.current()).toBeUndefined();
    expect(await b.recover()).toBeUndefined();
    const answer = await b.bind(request(G1, B1, null), signal());
    expect(answer).toMatchObject({
      instanceId: "d",
      instanceGeneration: G1,
      bindingId: B1,
      runtimeIdentity: { ...verified, instanceGeneration: G1 },
      ownerCeiling: owner,
    });
    expect(JSON.parse(await readFile(join(f.root, BINDING_FILE), "utf8"))).toMatchObject({
      instanceGeneration: G1,
      bindingId: B1,
      previousGeneration: null,
    });
    expect(b.current()?.binding.instanceGeneration).toBe(G1);
    // a reply lost on the way: the identical request answers the same binding
    expect(await b.bind(request(G1, B1, null), signal())).toEqual(answer);
    // the same generation under another binding id is a conflict, never an adoption
    await expect(b.bind(request(G1, B2, null), signal())).rejects.toThrow("another binding id");
    // a request that skips this device's previous binding is refused
    await expect(b.bind(request(G2, B2, null), signal())).rejects.toThrow("previous binding");
    await expect(b.bind({ ...request(G2, B2, G1), instanceId: "x" }, signal())).rejects.toThrow(
      "another instance",
    );
  });

  it("failed verification binds nothing and admits nothing", async () => {
    const f = await fixture();
    f.failVerify(true);
    const b = f.binder();
    await expect(b.bind(request(G1, B1, null), signal())).rejects.toThrow(RuntimeManifestError);
    expect(b.current()).toBeUndefined();
    await expect(readFile(join(f.root, BINDING_FILE))).rejects.toThrow();
  });

  it("restart recovers the same generation's journal; changed runtime stays unbound", async () => {
    const f = await fixture();
    const first = f.binder();
    await first.bind(request(G1, B1, null), signal());
    const ref = await f.startTask(first, "op-1");
    // process restart: no PID is reattached, the binding and its journal come back
    const restarted = f.binder();
    const recovered = await restarted.recover();
    expect(recovered?.binding.bindingId).toBe(B1);
    const status = await recovered?.backend.background.status(recovered.handle, ref, signal());
    expect(status).toEqual({ state: "lost" });
    // a changed helper set after restart: not recovered (unbound until a new instance)
    f.setRuntime({ ...verified, helperHash: "d".repeat(64) });
    expect(await f.binder().recover()).toBeUndefined();
    await expect(f.binder().bind(request(G1, B1, null), signal())).rejects.toThrow(
      "installed runtime changed",
    );
  });

  it("an old generation's unsettled work blocks a newer asserted generation", async () => {
    const f = await fixture();
    const b = f.binder();
    await b.bind(request(G1, B1, null), signal());
    await f.startTask(b, "op-1");
    // live work in this process
    await expect(b.bind(request(G2, B2, G1), signal())).rejects.toThrow("not settled");
    // after a restart the work is uncertain: the obligation survives any newer generation
    const restarted = f.binder();
    await restarted.recover();
    await expect(restarted.bind(request(G2, B2, G1), signal())).rejects.toThrow("not settled");
    await expect(restarted.bind(request("1800000000000", B2, G1), signal())).rejects.toThrow(
      "not settled",
    );
    expect(JSON.parse(await readFile(join(f.root, BINDING_FILE), "utf8")).instanceGeneration).toBe(
      G1,
    );
  });

  it("a real replacement binds after the old work settled; old refs are refused", async () => {
    const f = await fixture();
    const b = f.binder();
    await b.bind(request(G1, B1, null), signal());
    const ref = await f.startTask(b, "op-1");
    const old = b.current();
    if (!old) throw new Error("expected binding");
    await old.backend.background.stop(old.handle, ref, { graceMs: 0, signal: signal() });
    await old.backend.lifecycle.settle(signal());
    const answer = await b.bind(request(G2, B2, G1), signal());
    expect(answer.runtimeIdentity.instanceGeneration).toBe(G2);
    const now = b.current();
    expect(now?.binding).toMatchObject({ instanceGeneration: G2, previousGeneration: G1 });
    await expect(now?.backend.background.status(now.handle, ref, signal())).rejects.toThrow(
      "another instance generation",
    );
    // never back to an older generation
    await expect(b.bind(request(G1, B1, G2), signal())).rejects.toThrow();
  });

  it("a corrupt binding blocks instead of starting over", async () => {
    const f = await fixture();
    await writeFile(join(f.root, BINDING_FILE), "{");
    await expect(f.binder().bind(request(G1, B1, null), signal())).rejects.toThrow();
  });
});

it("an unbound first hello admits no operation until the authenticated bind", async () => {
  const f = await fixture();
  const b = f.binder();
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
  const answers = new Map<string, (r: DeviceResponseV3) => void>();
  let hello: DeviceHelloV3 | undefined;
  socket.on("message", (raw) => {
    const frame = parseDeviceFrameV3(raw.toString(), "device", 69632);
    if (frame.type === "hello") {
      hello = frame;
      socket.send(JSON.stringify({ type: "ready", connectionId: "c", maxFrameBytes: 69632 }));
    } else if (frame.type === "res") answers.get(frame.id)?.(frame);
  });
  const placeholder = await createMacOperationBackend(
    {
      deviceId: "d",
      instanceGeneration: "unbound",
      stateDir: join(f.root, "unused"),
      roots: f.roots,
      pythonPath: "/usr/bin/python3",
      readOwnerCeiling: async () => {
        throw new Error("never used while unbound");
      },
    },
    { platform: "darwin" },
  );
  const session = serveStagedSession(
    client,
    {
      type: "hello",
      protocol: 3,
      programVersion: "fixture",
      os: "darwin",
      arch: "arm64",
      mode: "os",
      roots: f.roots,
      sessionIsolation: false,
      permissionSupport: {
        version: 1,
        restricted: null,
        fullAccess: false,
        background: false,
        unavailableReason: "Instance binding pending",
      },
      ownerCeiling: owner,
      instanceGeneration: null,
    },
    { maxFrameBytes: 69632 },
    placeholder,
    { id: "d" },
    createStagedSessionState({ graceMs: 0 }),
    b,
  );
  await vi.waitFor(() => expect(session.ready()).toBeDefined());
  expect(hello?.instanceGeneration).toBeNull();
  expect(hello?.runtimeIdentity).toBeUndefined();
  let n = 0;
  const send = (op: string, args: unknown) => {
    const id = String(++n);
    const response = new Promise<DeviceResponseV3>((r) => answers.set(id, r));
    socket.send(JSON.stringify({ type: "req", id, op, args, deadlineMs: 10000 }));
    return response;
  };
  const status = {
    ref: { instanceId: "d", instanceGeneration: G1, operationId: "o", executionId: "e" },
  };
  expect(await send("backgroundStatus", status)).toMatchObject({
    ok: false,
    error: { kind: "unsupported", message: expect.stringContaining("unbound") },
  });
  const bound = await send("bindInstance", request(G1, B1, null));
  expect(bound).toMatchObject({ ok: true, result: { instanceGeneration: G1, bindingId: B1 } });
  // now the bound generation's backend answers: it owns no such execution
  expect(await send("backgroundStatus", status)).toMatchObject({
    ok: true,
    result: { state: "lost" },
  });
  expect(f.created).toEqual([G1]);
});
