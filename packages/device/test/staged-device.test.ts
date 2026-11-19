import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BindInstanceResult,
  DEVICE_PROTOCOL_VERSION,
  FileSystemGoneError,
  type KernelRequest,
  parseDeviceFrame,
  type SandboxOperationScope,
  SandboxPermissionUnsupportedError,
} from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISCONNECTED_MESSAGE,
  deploymentOutdatedMessage,
  OUTDATED_MESSAGE,
} from "../src/client.js";
import type { OperationContainerHost } from "../src/exec/docker-operations.js";
import type { LinuxProbe } from "../src/exec/linux-runtime.js";
import type { MacSelfCheckInput } from "../src/exec/mac-self-check.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";
import type { EnvironmentInputs } from "../src/exec/runtime-manifest.js";
import { PolicyStore } from "../src/policy-store.js";
import { serveOperationV3 } from "../src/server-ops.js";
import { CREDENTIAL_CHANGED_MESSAGE, connectStaged } from "../src/staged-connect.js";
import { createStagedDevice, UNBOUND_SUPPORT } from "../src/staged-device.js";
import { type Credential, DEFAULT_POLICY, FULL_OWNER_CEILING, writePolicy } from "../src/state.js";
import { FakeKernel } from "./fake-kernel.js";

/** The policy these tests were written against: the owner allows Full access (old auto). */
const FULL_POLICY = { ...DEFAULT_POLICY, ownerCeiling: { ...FULL_OWNER_CEILING } };
let root: string;
let state: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "device-staged-")));
  state = join(root, "state");
  mkdirSync(join(root, "device"), { recursive: true });
  writePolicy(state, FULL_POLICY);
});
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  rmSync(root, { recursive: true, force: true });
});
const signal = () => AbortSignal.timeout(10_000);
const G1 = "1700000000001";
const G2 = "1700000000002";
const B1 = "6f1e0a52-8f5b-4d5e-9a1c-1f0e2d3c4b51";
const B2 = "6f1e0a52-8f5b-4d5e-9a1c-1f0e2d3c4b52";
const credential = (over: Partial<Credential> = {}): Credential => ({
  url: "http://x.test",
  connectUrl: "ws://127.0.0.1:1/device/connect",
  credential: "cap_dev_a",
  orgId: "o",
  deviceId: "d",
  dir: join(root, "device"),
  mode: "os",
  reconnectGraceSeconds: 120,
  maxFrameBytes: 69632,
  ...over,
});
const verified = (runtimeHash = "a".repeat(64)) => ({
  runtimeHash,
  helperHash: "b".repeat(64),
  imageFingerprint: "c".repeat(64),
});
const LIMITS = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  network: { kind: "allowlist", hosts: [] },
};
const request = (instanceGeneration: string, bindingId: string, previous: string | null) => ({
  instanceId: "d",
  instanceGeneration,
  bindingId,
  expectedPreviousGeneration: previous,
});

/** Workers that run until cancelled or finished; every launch is recorded. */
function workers(opts: { cancelRejects?: () => boolean } = {}) {
  const launched: MacWorkerRequest[] = [];
  const finishers: (() => void)[] = [];
  const cancelled: string[] = [];
  const startWorker = async (r: MacWorkerRequest) => {
    await r.beforeLaunch();
    await r.onLaunch({ pid: 123, token: "owned-fixture-worker" });
    launched.push(r);
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
    return {
      ready: Promise.resolve(),
      completion,
      cancel: async () => {
        cancelled.push(r.scope.operationId);
        if (opts.cancelRejects?.()) throw new Error("the process does not end");
        finish();
      },
    };
  };
  return { launched, finishers, cancelled, startWorker };
}

function staged(
  o: {
    cred?: Credential;
    platform?: NodeJS.Platform;
    selfCheck?: string | null;
    probe?: LinuxProbe;
    verify?: () => Promise<void>;
    runtimeHash?: () => string;
    selfChecks?: (string | null)[];
    clock?: () => number;
    cancelRejects?: () => boolean;
    container?: OperationContainerHost;
    imageDigest?: string;
    dispose?: () => Promise<void>;
  } = {},
) {
  const w = workers({ ...(o.cancelRejects && { cancelRejects: o.cancelRejects }) });
  const checks: MacSelfCheckInput[] = [];
  const verifications: { stageIn: string }[] = [];
  const environments: EnvironmentInputs[] = [];
  const device = createStagedDevice({
    cred: o.cred ?? credential(),
    stateDir: state,
    policy: new PolicyStore(state),
    home: join(root, "home"),
    platform: o.platform ?? "darwin",
    startWorker: w.startWorker,
    ...(o.container && { container: o.container }),
    ...(o.dispose && { dispose: o.dispose }),
    selfCheckRetryMs: o.clock ? 100 : 0,
    ...(o.clock && { selfCheckNow: o.clock }),
    containerImageDigest: async () => o.imageDigest ?? `sha256:${"f".repeat(64)}`,
    verifyRuntime: async (env, options) => {
      verifications.push(options);
      environments.push(env);
      await o.verify?.();
      return verified(o.runtimeHash?.());
    },
    selfCheck: async (input) => {
      checks.push(input);
      if (o.selfChecks) return o.selfChecks.shift() ?? null;
      return o.selfCheck === undefined ? null : o.selfCheck;
    },
    linux: {
      probe: async () =>
        o.probe ?? {
          restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
        },
      startWorker: w.startWorker,
      acquireRuntime: async () => ({ release: () => {} }),
    },
    backendDependencies: { now: () => 1, watch: () => () => {} },
  });
  const roots = {
    workspace: join(root, "device", "workspace"),
    tmp: join(root, "device", "tmp"),
  };
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
  const startTask = async (operationId: string) => {
    const bound = device.binder.current();
    if (!bound) throw new Error("unbound");
    mkdirSync(roots.tmp, { recursive: true });
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
  const startExec = async (operationId: string) => {
    const bound = device.binder.current();
    if (!bound) throw new Error("unbound");
    const op = await bound.backend
      .forExecution({ operationId, orgNetwork: { kind: "open-public", hosts: [] } })
      .operation(bound.handle, scope(operationId), signal());
    return op.exec({ command: "fixture", timeoutMs: 10000, maxOutputBytes: 4, signal: signal() });
  };
  cleanups.push(() => {
    for (const f of w.finishers) f();
  });
  return { device, ...w, checks, verifications, environments, startTask, startExec };
}

describe("staged device parts (W3-M)", () => {
  it("verifies the installed runtime staging it in the state directory, and attests each generation's hash", async () => {
    let hash = "a".repeat(64);
    const s = staged({ runtimeHash: () => hash });
    await s.device.binder.bind(request(G1, B1, null), signal());
    expect(s.verifications).toEqual([{ stageIn: state }]);
    expect(s.checks.map((c) => c.runtimeHash)).toEqual(["a".repeat(64)]);
    hash = "e".repeat(64);
    await s.device.binder.bind(request(G2, B2, G1), signal());
    // the new generation's self-check and launches use the hash its own binding attested
    expect(s.checks.map((c) => c.runtimeHash)).toEqual(["a".repeat(64), "e".repeat(64)]);
    await s.startTask("op-1");
    expect(s.launched.at(-1)?.runtimeHash).toBe("e".repeat(64));
    expect(s.checks[1]).toMatchObject({ stateDir: state, platform: "darwin" });
  });

  it("macOS reports restricted support only after the self-check at bind passed", async () => {
    const answer = (await staged().device.binder.bind(
      request(G1, B1, null),
      signal(),
    )) as BindInstanceResult;
    expect(answer.permissionSupport).toEqual({
      version: 2,
      restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
      boundary: "operation",
      network: { openPublic: false, allowlist: true, perOperationHosts: true },
      outsideSandbox: true,
      background: true,
    });
  });

  it("macOS reports restricted support unavailable, with the reason, when the self-check fails", async () => {
    const s = staged({ selfCheck: "Restricted macOS execution does not hold here (exit 3)" });
    const answer = await s.device.binder.bind(request(G1, B1, null), signal());
    expect(answer.permissionSupport).toEqual({
      version: 2,
      restricted: null,
      boundary: "operation",
      network: { openPublic: false, allowlist: false, perOperationHosts: false },
      outsideSandbox: true,
      background: true,
      unavailableReason: "Restricted macOS execution does not hold here (exit 3)",
    });
    // a restricted operation is refused with that reason
    const bound = s.device.binder.current();
    if (!bound) throw new Error("expected binding");
    const workspace = join(root, "device", "workspace");
    mkdirSync(workspace, { recursive: true });
    const browse = await bound.backend.browse(
      bound.handle,
      {
        operationId: "browse-1",
        admitBeforeMs: 1000,
        deviceId: "d",
        accountId: "a",
        ceilingRevision: "c",
        readRoots: [workspace],
        tag: "browse-1",
      },
      signal(),
    );
    await expect(browse.stat(workspace, signal())).rejects.toThrow(/does not hold here/);
  });

  it("Linux restricted support is the launcher probe's (W2-S); no macOS self-check runs", async () => {
    const supported = staged({ platform: "linux" });
    expect(
      (await supported.device.binder.bind(request(G1, B1, null), signal())).permissionSupport
        .restricted,
    ).not.toBeNull();
    expect(supported.checks).toEqual([]);
  });

  it("Linux fails closed when the probe reports an unsupported kernel", async () => {
    const s = staged({ platform: "linux", probe: { restricted: null, reason: "Landlock ABI 2" } });
    const support = (await s.device.binder.bind(request(G1, B1, null), signal())).permissionSupport;
    expect(support.restricted).toBeNull();
    expect(support.unavailableReason).toContain("Landlock ABI 2");
    expect(support.outsideSandbox).toBe(true);
  });

  it("an unbound hello reports no capability; a bound one its generation and verified identity", async () => {
    const s = staged();
    const parse = (r: object) =>
      parseDeviceFrame(
        JSON.stringify({ ...r, transport: { maxFrameBytes: 69632 } }),
        "device",
        69632,
      );
    const unbound = await s.device.report({ bootId: "boot-1" });
    expect(unbound).toMatchObject({
      protocol: 4,
      instanceGeneration: null,
      permissionSupport: UNBOUND_SUPPORT,
      bootId: "boot-1",
      roots: { workspace: join(root, "device", "workspace") },
    });
    expect(unbound.runtimeIdentity).toBeUndefined();
    expect(() => parse(unbound)).not.toThrow();
    await s.device.binder.bind(request(G1, B1, null), signal());
    const bound = await s.device.report();
    expect(bound).toMatchObject({
      instanceGeneration: G1,
      runtimeIdentity: { ...verified(), instanceGeneration: G1 },
    });
    expect(bound.permissionSupport.restricted).not.toBeNull();
    expect(() => parse(bound)).not.toThrow();
  });

  it("create reports the roots and drops the bound generation's background tasks only", async () => {
    const s = staged();
    // unbound: nothing to drop
    expect(await s.device.create(signal())).toEqual({
      roots: {
        workspace: join(root, "device", "workspace"),
        skills: join(root, "device", "skills"),
        tmp: join(root, "device", "tmp"),
      },
    });
    await s.device.binder.bind(request(G1, B1, null), signal());
    const ref = await s.startTask("task-1");
    const running = s.startExec("exec-1");
    await vi.waitFor(() => expect(s.launched.length).toBe(2));
    await s.device.create(signal());
    expect(s.cancelled).toEqual(["task-1"]);
    const bound = s.device.binder.current();
    if (!bound) throw new Error("expected binding");
    expect(
      (await bound.backend.background.stop(bound.handle, ref, { graceMs: 0, signal: signal() }))
        .outcome,
    ).toBe("stopped");
    for (const f of s.finishers) f();
    await running;
    // a removed device directory is never recreated empty
    rmSync(join(root, "device"), { recursive: true, force: true });
    await expect(s.device.create(signal())).rejects.toBeInstanceOf(FileSystemGoneError);
  });

  it("machine stop exact-stops every owned operation and admits nothing new", async () => {
    const s = staged();
    expect(await s.device.cancelOwners(signal())).toEqual([]);
    await s.device.binder.bind(request(G1, B1, null), signal());
    await s.startTask("task-1");
    const running = s.startExec("exec-1");
    await vi.waitFor(() => expect(s.launched.length).toBe(2));
    const outcomes = await s.device.cancelOwners(signal());
    expect(outcomes.map((o) => o.result.outcome)).toEqual(["stopped", "stopped"]);
    expect(s.cancelled.sort()).toEqual(["exec-1", "task-1"]);
    await running;
    await expect(s.startTask("task-2")).rejects.toBeInstanceOf(SandboxPermissionUnsupportedError);
  });
});

describe("staged device: the local command log", () => {
  it("the program's owner controls write commands.log in the state directory", async () => {
    writePolicy(state, { ...DEFAULT_POLICY, ownerCeiling: { ...FULL_OWNER_CEILING } });
    const s = staged();
    const res = await serveOperationV3(
      s.device.backend(),
      s.device.handle,
      {
        type: "req",
        id: "q",
        op: "policy",
        args: {
          opId: "op_log",
          remove: ["files.slack.com"],
          source: { accountId: "acc_1", accountName: "Ada", via: "web" },
        },
        deadlineMs: 1000,
      } as KernelRequest,
      signal(),
      s.device.binder,
      s.device.owner,
    );
    expect(res).toMatchObject({ ok: true });
    expect(readFileSync(join(state, "commands.log"), "utf8")).toContain(
      "policy remove files.slack.com by Ada (acc_1) via web",
    );
  });
});

describe("staged device parts: fix round", () => {
  it("a failed self-check is retried by the next report, not kept for the generation (M-4)", async () => {
    let clock = 0;
    const s = staged({ selfChecks: ["busy machine", null], clock: () => clock });
    const answer = await s.device.binder.bind(request(G1, B1, null), signal());
    expect(answer.permissionSupport.restricted).toBeNull();
    expect(answer.permissionSupport.unavailableReason).toBe("busy machine");
    // a restricted operation is refused with that reason meanwhile
    expect((await s.device.report()).permissionSupport.restricted).toBeNull();
    expect(s.checks).toHaveLength(1);
    clock = 150;
    // the next hello retries it on the same generation's backend
    const hello = await s.device.report();
    expect(hello.permissionSupport.restricted).not.toBeNull();
    expect(s.checks).toHaveLength(2);
    expect(s.device.binder.current()?.binding.instanceGeneration).toBe(G1);
  });

  it("a docker-mode device attests its container's image id (M-2)", async () => {
    const released: string[] = [];
    const container: OperationContainerHost = {
      operationContainer: async () => ({
        name: "capybara-device-d",
        user: "1000:1000",
        release: () => released.push("capybara-device-d"),
      }),
    };
    const digest = `sha256:${"9".repeat(64)}`;
    const s = staged({
      cred: credential({ mode: "docker" }),
      platform: "linux",
      container,
      imageDigest: digest,
    });
    await s.device.binder.bind(request(G1, B1, null), signal());
    expect(s.environments[0]?.providerImageDigest).toBe(digest);
    expect(s.environments[0]?.roots).toEqual({
      workspace: "/workspace",
      skills: "/skills",
      tmp: "/tmp",
    });
    expect(released).toEqual(["capybara-device-d"]);
    // a re-pulled tag (another image id) is another runtime: the bind of that runtime is refused
    const tag = staged({
      cred: credential({ mode: "docker" }),
      platform: "linux",
      container,
      imageDigest: "latest",
    });
    await expect(tag.device.binder.bind(request(G1, B1, null), signal())).rejects.toThrow(
      /not a sha256 digest/,
    );
  });

  it("dispose releases what construction acquired (M-5)", async () => {
    const dispose = vi.fn(async () => {});
    await staged({ dispose }).device.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("staged connection (W3-M)", () => {
  async function kernel() {
    const k = new FakeKernel();
    await k.start();
    cleanups.push(() => k.stop());
    return k;
  }
  const ready = (k: FakeKernel, conn: number) =>
    k.send(conn, { type: "ready", connectionId: `c${conn}`, maxFrameBytes: 69632 });
  const res = (k: FakeKernel, id: string) =>
    k.waitFor(`answer ${id}`, () => k.of("res").find((r) => r.id === id));
  const send = (k: FakeKernel, conn: number, id: string, op: string, args: object) =>
    k.send(conn, { type: "req", id, op, args, deadlineMs: 5000 });

  it("speaks protocol 4: an unbound hello, then the binding and lifecycle over the socket", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null });
    cleanups.push(() => {
      conn.stop();
      return conn.done;
    });
    const hello = await k.waitFor("hello", () => k.of("hello")[0]);
    expect(k.headers[0]?.["x-capybara-device-protocol"]).toBe("4");
    expect(k.headers[0]?.authorization).toBe("Bearer cap_dev_a");
    expect(hello).toMatchObject({
      protocol: 4,
      instanceGeneration: null,
      transport: { maxFrameBytes: 69632 },
    });
    ready(k, 0);
    send(k, 0, "b1", "bindInstance", request(G1, B1, null));
    expect(await res(k, "b1")).toMatchObject({ ok: true, result: { instanceGeneration: G1 } });
    send(k, 0, "c1", "create", { limits: LIMITS });
    expect(await res(k, "c1")).toMatchObject({
      ok: true,
      result: { roots: { workspace: join(root, "device", "workspace") } },
    });
  });

  it("an owner report that breaks after the hello is reported, never an unhandled rejection", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const report = s.device.owner.report;
    let calls = 0;
    s.device.owner.report = () => {
      calls += 1;
      // the hello's report succeeds; policy.json breaks right after
      if (calls > 1) throw new Error("policy.json is not valid JSON");
      return report();
    };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    cleanups.push(async () => {
      process.off("unhandledRejection", unhandled);
    });
    const errs: string[] = [];
    const conn = connectStaged(s.device, {
      err: (l) => errs.push(l),
      bootId: null,
      policyCheckMs: 60_000,
    });
    cleanups.push(() => {
      conn.stop();
      return conn.done;
    });
    await k.waitFor("hello", () => k.of("hello")[0]);
    await vi.waitFor(() => expect(errs.join("\n")).toMatch(/not valid JSON/));
    await new Promise((r) => setImmediate(r));
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("an answer produced while disconnected waits the credential's grace and reaches the next socket (B-3, B-4)", async () => {
    const k = await kernel();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const s = staged({ cred: credential({ connectUrl: k.url }), verify: () => held });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null, sleep: async () => {} });
    cleanups.push(() => {
      conn.stop();
      return conn.done;
    });
    await k.waitFor("hello", () => k.of("hello", 0)[0]);
    ready(k, 0);
    send(k, 0, "b1", "bindInstance", request(G1, B1, null));
    await vi.waitFor(() => expect(s.verifications.length).toBe(1));
    // the socket drops while the bind verifies; the answer is held for the next socket
    k.sockets[0]?.terminate();
    await k.waitFor("second hello", () => k.of("hello", 1)[0]);
    release();
    const state = s.device.states.for(credential({ connectUrl: k.url }));
    await vi.waitFor(() => expect(state.pending.has("b1")).toBe(true));
    expect(state.graceMs).toBe(120_000);
    ready(k, 1);
    expect(await res(k, "b1")).toMatchObject({ ok: true, result: { bindingId: B1 } });
    expect(k.frames.find((f) => f.frame.id === "b1")?.conn).toBe(1);
  });

  it("a machine stop exact-stops the owned work, answers, and ends the program", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const errs: string[] = [];
    const conn = connectStaged(s.device, { err: (l) => errs.push(l), bootId: null });
    await k.waitFor("hello", () => k.of("hello")[0]);
    ready(k, 0);
    send(k, 0, "b1", "bindInstance", request(G1, B1, null));
    await res(k, "b1");
    await s.startTask("task-1");
    send(k, 0, "s1", "stop", { reason: "revoked" });
    expect(await res(k, "s1")).toMatchObject({ ok: true, result: null });
    expect(await conn.done).toBe(0);
    expect(s.cancelled).toEqual(["task-1"]);
    expect(errs).toContain(DISCONNECTED_MESSAGE);
  });

  it("drain waits for the owned work, then ends with 0", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null });
    await k.waitFor("hello", () => k.of("hello")[0]);
    ready(k, 0);
    send(k, 0, "b1", "bindInstance", request(G1, B1, null));
    await res(k, "b1");
    await s.startTask("task-1");
    let ended = false;
    void conn.done.then(() => {
      ended = true;
    });
    conn.drain();
    // new admissions are refused while the task runs
    send(k, 0, "c1", "create", { limits: LIMITS });
    expect(await res(k, "c1")).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(ended).toBe(false);
    for (const f of s.finishers) f();
    expect(await conn.done).toBe(0);
    expect(s.cancelled).toEqual([]);
  });

  it("stop exact-stops the owned work before it ends", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null });
    await k.waitFor("hello", () => k.of("hello")[0]);
    ready(k, 0);
    send(k, 0, "b1", "bindInstance", request(G1, B1, null));
    await res(k, "b1");
    await s.startTask("task-1");
    conn.stop();
    expect(await conn.done).toBe(0);
    expect(s.cancelled).toEqual(["task-1"]);
  });

  it("a changed credential discards the old state, stops its work and exits 1", async () => {
    const k = await kernel();
    const cred = credential({ connectUrl: k.url });
    let current = cred;
    const s = staged({ cred });
    const errs: string[] = [];
    const conn = connectStaged(s.device, {
      err: (l) => errs.push(l),
      bootId: null,
      sleep: async () => {},
      credential: () => current,
    });
    await k.waitFor("hello", () => k.of("hello")[0]);
    ready(k, 0);
    send(k, 0, "b1", "bindInstance", request(G1, B1, null));
    await res(k, "b1");
    await s.startTask("task-1");
    const old = s.device.states.for(cred);
    current = { ...cred, credential: "cap_dev_b" };
    k.sockets[0]?.terminate();
    expect(await conn.done).toBe(1);
    expect(old.discarded).toBe(true);
    expect(s.cancelled).toEqual(["task-1"]);
    expect(errs).toContain(CREDENTIAL_CHANGED_MESSAGE);
    expect(k.sockets).toHaveLength(1);
  });

  for (const ending of ["401", "4003"] as const) {
    it(`a terminal ${ending} stops the running foreground and background work before it ends (I-1)`, async () => {
      const k = await kernel();
      const s = staged({ cred: credential({ connectUrl: k.url }) });
      const conn = connectStaged(s.device, { err: () => {}, bootId: null, sleep: async () => {} });
      await k.waitFor("hello", () => k.of("hello")[0]);
      ready(k, 0);
      send(k, 0, "b1", "bindInstance", request(G1, B1, null));
      await res(k, "b1");
      await s.startTask("task-1");
      const running = s.startExec("exec-1");
      await vi.waitFor(() => expect(s.launched.length).toBe(2));
      if (ending === "401") {
        k.rejectWith = 401;
        k.sockets[0]?.terminate();
      } else k.sockets[0]?.close(4003, "revoked");
      expect(await conn.done).toBe(0);
      expect(s.cancelled.sort()).toEqual(["exec-1", "task-1"]);
      await running;
    });
  }

  // A 426 names the kernel's protocol: an older deployment is to be upgraded, not this program.
  for (const [kernelProtocol, expected] of [
    [DEVICE_PROTOCOL_VERSION + 1, OUTDATED_MESSAGE],
    [DEVICE_PROTOCOL_VERSION - 1, deploymentOutdatedMessage(DEVICE_PROTOCOL_VERSION - 1)],
    [undefined, OUTDATED_MESSAGE],
  ] as const) {
    it(`a 426 from a kernel on protocol ${kernelProtocol ?? "(unreadable)"} says which side to upgrade`, async () => {
      const k = await kernel();
      k.rejectWith = 426;
      k.rejectBody =
        kernelProtocol === undefined
          ? undefined
          : {
              error: {
                code: "device.program_outdated",
                message: `This kernel speaks device protocol ${kernelProtocol}. Update capybara-device.`,
              },
            };
      const s = staged({ cred: credential({ connectUrl: k.url }) });
      const errs: string[] = [];
      const conn = connectStaged(s.device, { err: (l) => errs.push(l), bootId: null });
      expect(await conn.done).toBe(1);
      expect(errs).toContain(expected);
    });
  }

  it("a machine stop whose cancellations do not settle answers an error naming them (I-2)", async () => {
    const k = await kernel();
    let rejects = false;
    const s = staged({ cred: credential({ connectUrl: k.url }), cancelRejects: () => rejects });
    const errs: string[] = [];
    const conn = connectStaged(s.device, { err: (l) => errs.push(l), bootId: null });
    await k.waitFor("hello", () => k.of("hello")[0]);
    ready(k, 0);
    send(k, 0, "b1", "bindInstance", request(G1, B1, null));
    await res(k, "b1");
    await s.startTask("task-1");
    rejects = true;
    send(k, 0, "s1", "stop", { reason: "deleted" });
    const answer = await res(k, "s1");
    expect(answer).toMatchObject({ ok: false, error: { kind: "error" } });
    expect(answer.error.message).toMatch(/task-1/);
    expect(await conn.done).toBe(0);
    expect(errs.some((l) => /still stopping.*task-1/.test(l))).toBe(true);
    rejects = false;
  });

  it("stop logs what is still stopping when cancellations do not settle (I-2)", async () => {
    const k = await kernel();
    let rejects = false;
    const s = staged({ cred: credential({ connectUrl: k.url }), cancelRejects: () => rejects });
    const errs: string[] = [];
    const conn = connectStaged(s.device, { err: (l) => errs.push(l), bootId: null });
    await k.waitFor("hello", () => k.of("hello")[0]);
    ready(k, 0);
    send(k, 0, "b1", "bindInstance", request(G1, B1, null));
    await res(k, "b1");
    await s.startTask("task-1");
    rejects = true;
    conn.stop();
    expect(await conn.done).toBe(0);
    expect(errs.some((l) => /still stopping.*task-1/.test(l))).toBe(true);
    rejects = false;
  });

  it("drain waits until the held answers reached a socket (M-3)", async () => {
    const k = await kernel();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const s = staged({ cred: credential({ connectUrl: k.url }), verify: () => held });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null, sleep: async () => {} });
    await k.waitFor("hello", () => k.of("hello", 0)[0]);
    ready(k, 0);
    send(k, 0, "b1", "bindInstance", request(G1, B1, null));
    await vi.waitFor(() => expect(s.verifications.length).toBe(1));
    k.sockets[0]?.terminate();
    await k.waitFor("second hello", () => k.of("hello", 1)[0]);
    conn.drain();
    release();
    const state = s.device.states.for(credential({ connectUrl: k.url }));
    await vi.waitFor(() => expect(state.pending.has("b1")).toBe(true));
    let ended = false;
    void conn.done.then(() => {
      ended = true;
    });
    // drained of work, but an answer is still held: the program waits for a ready socket
    await new Promise((r) => setImmediate(r));
    expect(ended).toBe(false);
    ready(k, 1);
    expect(await res(k, "b1")).toMatchObject({ ok: true });
    expect(await conn.done).toBe(0);
  });

  it("drain gives up on held answers after the credential's grace (M-3)", async () => {
    const k = await kernel();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const s = staged({
      cred: credential({ connectUrl: k.url, reconnectGraceSeconds: 1 }),
      verify: () => held,
    });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null });
    await k.waitFor("hello", () => k.of("hello", 0)[0]);
    ready(k, 0);
    send(k, 0, "b1", "bindInstance", request(G1, B1, null));
    await vi.waitFor(() => expect(s.verifications.length).toBe(1));
    // no reconnect succeeds from here on
    k.rejectWith = 503;
    k.sockets[0]?.terminate();
    conn.drain();
    release();
    const started = Date.now();
    expect(await conn.done).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});
