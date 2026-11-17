import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceHelloV3,
  type DeviceResponseV3,
  parseDeviceFrameV3,
  type SandboxOperationScope,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { bindingFile, InstanceBinder } from "../src/exec/instance-binding.js";
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
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
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
  // a held verification (the ~1 s installed-byte hash) and a held worker launch
  let verifyGate: Promise<void> | undefined;
  let verifying = false;
  let launchGate: Promise<void> | undefined;
  const hold = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    return { gate, release };
  };
  const createBackend = async (instanceGeneration: string, deviceId = "d") => {
    created.push(instanceGeneration);
    return createMacOperationBackend(
      {
        deviceId,
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
          await launchGate;
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
  const binder = (opts: { credential?: string; deviceId?: string } = {}) =>
    new InstanceBinder({
      deviceId: opts.deviceId ?? "d",
      credentialIdentity: opts.credential ?? "credential-1",
      stateDir: root,
      createBackend: (g) => createBackend(g, opts.deviceId ?? "d"),
      verify: async () => {
        verifying = verifyGate !== undefined;
        await verifyGate;
        verifying = false;
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
    verifying: () => verifying,
    holdVerify: () => {
      const h = hold();
      verifyGate = h.gate;
      return () => {
        verifyGate = undefined;
        h.release();
      };
    },
    holdLaunch: () => {
      const h = hold();
      launchGate = h.gate;
      return () => {
        launchGate = undefined;
        h.release();
      };
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
    expect(JSON.parse(await readFile(bindingFile(f.root, "d"), "utf8"))).toMatchObject({
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
    await expect(readFile(bindingFile(f.root, "d"))).rejects.toThrow();
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
    expect(JSON.parse(await readFile(bindingFile(f.root, "d"), "utf8")).instanceGeneration).toBe(
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
    await writeFile(bindingFile(f.root, "d"), "{");
    await expect(f.binder().bind(request(G1, B1, null), signal())).rejects.toBeInstanceOf(
      SandboxScopeDeniedError,
    );
  });
});

describe("one supervisor per journal (fix round 1, I1)", () => {
  const journal = async (root: string) => {
    const { readdir } = await import("node:fs/promises");
    const name = (await readdir(root)).find((n) => /^operation-journal-[a-f0-9]+\.json$/.test(n));
    if (!name) throw new Error("no journal");
    return JSON.parse(await readFile(join(root, name), "utf8")) as {
      entries: { ref: { operationId: string }; stop?: { outcome: string }; revoked: boolean }[];
    };
  };
  it("work admitted while a bind verifies blocks the bind instead of surviving it", async () => {
    const f = await fixture();
    const b = f.binder();
    await b.bind(request(G1, B1, null), signal());
    const old = b.current();
    // a start already in flight on the old generation, its worker launch still pending
    const releaseLaunch = f.holdLaunch();
    const releaseVerify = f.holdVerify();
    const starting = f.startTask(b, "op-in-flight");
    await vi.waitFor(() => expect(old?.backend.lifecycle.ownership().workers).toBe(1));
    const binding = b.bind(request(G2, B2, G1), signal());
    // the old backend admits nothing fresh once the bind began
    await vi.waitFor(() => expect(f.verifying()).toBe(true));
    await expect(f.startTask(b, "op-fresh")).rejects.toBeInstanceOf(
      SandboxPermissionUnsupportedError,
    );
    releaseLaunch();
    await starting;
    releaseVerify();
    await expect(binding).rejects.toThrow("not settled");
    expect(b.current()?.binding.instanceGeneration).toBe(G1);
    expect(JSON.parse(await readFile(bindingFile(f.root, "d"), "utf8")).instanceGeneration).toBe(
      G1,
    );
  });

  it("a stop recorded by the old supervisor during the bind survives in the journal", async () => {
    const f = await fixture();
    const b = f.binder();
    await b.bind(request(G1, B1, null), signal());
    const old = b.current();
    if (!old) throw new Error("expected binding");
    const ref = await f.startTask(b, "op-1");
    const releaseVerify = f.holdVerify();
    const binding = b.bind(request(G2, B2, G1), signal());
    // the old generation's exact stop lands while the new binding verifies
    expect(
      (await old.backend.background.stop(old.handle, ref, { graceMs: 0, signal: signal() }))
        .outcome,
    ).toMatch(/stopped|already-exited/);
    await old.backend.lifecycle.settle(signal());
    releaseVerify();
    await binding;
    expect(b.current()?.binding.instanceGeneration).toBe(G2);
    // the new generation's first write must keep the tombstone
    await f.startTask(b, "op-2");
    const entries = (await journal(f.root)).entries;
    expect(entries.find((e) => e.ref.operationId === "op-1")?.stop?.outcome).toMatch(
      /stopped|already-exited/,
    );
    expect(entries.map((e) => e.ref.operationId).sort()).toEqual(["op-1", "op-2"]);
    // the superseded backend can never write or admit again
    await expect(old.backend.background.status(old.handle, ref, signal())).rejects.toBeInstanceOf(
      SandboxPermissionUnsupportedError,
    );
  });

  it("a refused bind leaves no second supervisor behind", async () => {
    const f = await fixture();
    const b = f.binder();
    await b.bind(request(G1, B1, null), signal());
    await f.startTask(b, "op-1");
    const before = f.created.length;
    await expect(b.bind(request(G2, B2, G1), signal())).rejects.toThrow("not settled");
    expect(f.created.length).toBe(before);
    // recover never builds a second backend beside the live one
    expect(await b.recover()).toBe(b.current());
    expect(f.created.length).toBe(before);
  });
});

describe("binding chain across credentials and lost replies (fix round 1, I2)", () => {
  it("a re-login with a new credential binds without the old machine's previous", async () => {
    const f = await fixture();
    await f.binder({ credential: "credential-1" }).bind(request(G1, B1, null), signal());
    // the kernel names no previous for the new machine; the stored binding belongs to the old one
    const relogged = f.binder({ credential: "credential-2" });
    const answer = await relogged.bind(request(G2, B2, null), signal());
    expect(answer.instanceGeneration).toBe(G2);
    // still never backwards, whoever's binding it was
    await expect(
      f.binder({ credential: "credential-3" }).bind(request("1600000000000", B1, null), signal()),
    ).rejects.toThrow("older generation");
  });

  it("another device id in the same state directory has its own binding", async () => {
    const f = await fixture();
    await f.binder().bind(request(G1, B1, null), signal());
    const other = f.binder({ deviceId: "e" });
    const answer = await other.bind({ ...request(G2, B2, null), instanceId: "e" }, signal());
    expect(answer.instanceId).toBe("e");
    expect(JSON.parse(await readFile(bindingFile(f.root, "d"), "utf8")).instanceGeneration).toBe(
      G1,
    );
  });

  it("a generation the kernel never confirmed is followed by its replacement", async () => {
    const f = await fixture();
    const b = f.binder();
    // G1 persisted here, the answer lost; the kernel replaced the instance and names G1 as the
    // last binding it sent this machine, or a later one this device never received
    await b.bind(request(G1, B1, null), signal());
    expect((await b.bind(request(G2, B2, G1), signal())).instanceGeneration).toBe(G2);
    const later = f.binder();
    expect(
      (
        await later.bind(
          request("1700000000009", "6f1e0a52-8f5b-4d5e-9a1c-1f0e2d3c4b59", "1700000000005"),
          signal(),
        )
      ).instanceGeneration,
    ).toBe("1700000000009");
    // a kernel that names an older previous than this device bound is not following it
    await expect(
      f
        .binder()
        .bind(request("1700000000010", "6f1e0a52-8f5b-4d5e-9a1c-1f0e2d3c4b5a", G1), signal()),
    ).rejects.toThrow("previous binding");
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
