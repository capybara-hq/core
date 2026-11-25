import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_SERVICE_SOCKET_ENV,
  FileSystemGoneError,
  parseDialInMachineFrame,
  type SandboxOperationScope,
  SandboxPermissionUnsupportedError,
} from "@capybara-hq/plugin-sdk";
import {
  type BindInstanceResult,
  DEVICE_DIAL_IN_PROTOCOL,
  parseDeviceFrame,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETED_MESSAGE,
  DISCONNECTED_MESSAGE,
  deploymentOutdatedMessage,
  foreignProtocolMessage,
  OUTDATED_MESSAGE,
  outdatedMessage,
  REPLACED_MESSAGE,
} from "../src/client.js";
import { connectionDir, machineDirOfConnection } from "../src/connections.js";
import { SANDBOX_IMAGE_PIN } from "../src/exec/docker-image.js";
import type { OperationContainerHost } from "../src/exec/docker-operations.js";
import { hostHelperLauncher } from "../src/exec/helper-launcher.js";
import type { LinuxProbe } from "../src/exec/linux-runtime.js";
import type { MacSelfCheckInput } from "../src/exec/mac-self-check.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";
import type { EnvironmentInputs } from "../src/exec/runtime-manifest.js";
import { PolicyStore } from "../src/policy-store.js";
import { readProjectRoots, recordProjectRoot } from "../src/project-roots.js";
import {
  CREDENTIAL_CHANGED_MESSAGE,
  connectStaged,
  KERNEL_STOPPED_MESSAGE,
} from "../src/staged-connect.js";
import { createStagedDevice, UNBOUND_SUPPORT } from "../src/staged-device.js";
import { PROGRAM_RUN_ID } from "../src/staged-session.js";
import {
  type Credential,
  DEFAULT_POLICY,
  type OwnerCeilingPolicy,
  writeCredential,
  writePolicy,
} from "../src/state.js";
import { FakeKernel } from "./fake-kernel.js";
import { listenEcho } from "./service-fixture.js";

const FULL_OWNER_CEILING: OwnerCeilingPolicy = {
  outsideSandbox: true,
  network: "open",
  projectReach: "machine",
};

/** The policy these tests were written against: the owner allows Full access (old auto). */
const FULL_POLICY = { ...DEFAULT_POLICY, ownerCeiling: { ...FULL_OWNER_CEILING } };
let root: string;
let state: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "device-staged-")));
  // the machine layout: this connection's state is <machine>/connections/<id>
  state = connectionDir(join(root, "state"), "d");
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
    // a device service: the echo service listens on the socket the launch names, in-process
    if (r.kind === "exec" && r.service) {
      const svc = await listenEcho(r.args.env?.[DEVICE_SERVICE_SOCKET_ENV] as string);
      return {
        ready: Promise.resolve(),
        completion: svc.exited.then(
          () =>
            ({
              stdout: "",
              stderr: "",
              exitCode: 0,
              timedOut: false,
              truncated: false,
            }) as never,
        ),
        cancel: async () => {
          cancelled.push(r.scope.operationId);
          svc.exit(null);
        },
      };
    }
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
    stateRoot: machineDirOfConnection(state),
    policy: new PolicyStore(state),
    home: join(root, "home"),
    platform: o.platform ?? "darwin",
    startWorker: w.startWorker,
    ...(o.container && { container: o.container }),
    ...(o.dispose && { dispose: o.dispose }),
    selfCheckRetryMs: o.clock ? 100 : 0,
    ...(o.clock && { selfCheckNow: o.clock }),
    containerImageDigest: async () => o.imageDigest ?? SANDBOX_IMAGE_PIN.index,
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
    // a restricted exec's HOME is the device's own sandbox home, next to its roots
    expect(s.launched.at(-1)?.sandboxHome).toBe(join(root, "device", "home"));
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
      network: { openPublic: true, allowlist: true, perOperationHosts: true },
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
    const unbound = await s.device.report({ bootId: "boot-1" });
    expect(unbound.envelope.program).toMatchObject({ bootId: "boot-1" });
    expect(unbound.body).toMatchObject({
      instanceGeneration: null,
      permissionSupport: UNBOUND_SUPPORT,
      roots: { workspace: join(root, "device", "workspace") },
    });
    expect(unbound.body.runtimeIdentity).toBeUndefined();
    expect(() => parseDeviceFrame(unbound.body, "hello")).not.toThrow();
    await s.device.binder.bind(request(G1, B1, null), signal());
    const bound = await s.device.report();
    expect(bound.body).toMatchObject({
      instanceGeneration: G1,
      runtimeIdentity: { ...verified(), instanceGeneration: G1 },
    });
    expect(bound.body.permissionSupport.restricted).not.toBeNull();
    expect(() => parseDeviceFrame(bound.body, "hello")).not.toThrow();
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

  const echoSpec = {
    name: "echo",
    entry: "main.js",
    args: [],
    files: { "main.js": new Uint8Array(Buffer.from("// echo")) },
  };
  const allowlist = { kind: "allowlist" as const, hosts: ["a.example.com"] };

  it("a new generation's backend stops every device service", async () => {
    const s = staged();
    await s.device.binder.bind(request(G1, B1, null), signal());
    await s.device.create(signal());
    await s.device.services.ensure(echoSpec, allowlist, signal());
    expect(s.device.services.status("echo").state).toBe("running");
    await s.device.binder.bind(request(G2, B2, G1), signal());
    expect(s.device.services.status("echo").state).toBe("stopped");
  });

  it("an owner reconcile stops a device service whose owner ceiling changed", async () => {
    writePolicy(state, { ...FULL_POLICY, allowedDomains: ["a.example.com"] });
    const s = staged();
    await s.device.binder.bind(request(G1, B1, null), signal());
    await s.device.create(signal());
    await s.device.services.ensure(echoSpec, allowlist, signal());
    // nothing changed: kept
    await s.device.owner.reconcile(signal());
    expect(s.device.services.status("echo").state).toBe("running");
    // the owner narrows the network on the machine: stopped, not restarted
    writePolicy(state, {
      ...FULL_POLICY,
      ownerCeiling: { ...FULL_OWNER_CEILING, network: "allowlist" },
      allowedDomains: [],
    });
    await s.device.owner.reconcile(signal());
    expect(s.device.services.status("echo").state).toBe("stopped");
  });

  /** A scoped exec in `<workspace>/core`, admitted until `admitBeforeMs` (the fixture clock is 1). */
  async function scopedExec(s: ReturnType<typeof staged>, admitBeforeMs: number) {
    await s.device.binder.bind(request(G1, B1, null), signal());
    const bound = s.device.binder.current();
    if (!bound) throw new Error("expected binding");
    const project = join(root, "device", "workspace", "core");
    mkdirSync(project, { recursive: true });
    const scope: SandboxOperationScope = {
      operationId: "scoped-1",
      admitBeforeMs,
      deviceId: "d",
      rootConversationId: "r",
      profileRevision: 1,
      ceilingRevision: "c",
      profile: "request-approval",
      actor: { accountId: "a", conversationId: "r" },
      tag: "scoped-1",
      filesystem: { kind: "scoped", projectRoot: project, writeRoots: [project] },
      network: { kind: "none" },
    };
    const op = await bound.backend
      .forExecution({ operationId: "scoped-1", orgNetwork: { kind: "open-public", hosts: [] } })
      .operation(bound.handle, scope, signal());
    const running = op.exec({
      command: "fixture",
      timeoutMs: 10000,
      maxOutputBytes: 4,
      signal: signal(),
    });
    return { project, running };
  }

  it("a scoped operation that launches records its project root for this connection", async () => {
    const s = staged();
    const { project, running } = await scopedExec(s, 1000);
    await vi.waitFor(() => expect(s.launched.length).toBe(1));
    for (const f of s.finishers) f();
    await running;
    expect(readProjectRoots(state)).toEqual([project]);
  });

  it("a scoped operation refused before it launches records nothing", async () => {
    const s = staged();
    // admission already expired on the fixture clock: the supervisor refuses it
    const refused = scopedExec(s, 1).then((e) => e.running);
    await expect(refused).rejects.toThrow(/expired/);
    expect(s.launched).toHaveLength(0);
    expect(readProjectRoots(state)).toEqual([]);
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

describe("staged device parts: fix round", () => {
  it("a failed self-check is retried by the next report, not kept for the generation (M-4)", async () => {
    let clock = 0;
    const s = staged({ selfChecks: ["busy machine", null], clock: () => clock });
    const answer = await s.device.binder.bind(request(G1, B1, null), signal());
    expect(answer.permissionSupport.restricted).toBeNull();
    expect(answer.permissionSupport.unavailableReason).toBe("busy machine");
    // a restricted operation is refused with that reason meanwhile
    expect((await s.device.report()).body.permissionSupport.restricted).toBeNull();
    expect(s.checks).toHaveLength(1);
    clock = 150;
    // the next hello retries it on the same generation's backend
    const hello = await s.device.report();
    expect(hello.body.permissionSupport.restricted).not.toBeNull();
    expect(s.checks).toHaveLength(2);
    expect(s.device.binder.current()?.binding.instanceGeneration).toBe(G1);
  });

  it("a docker-mode device attests its container's image id (M-2)", async () => {
    const released: string[] = [];
    const container: OperationContainerHost = {
      imagePlatform: "amd64",
      // the binder only builds the backend here: no helper runs
      helpers: hostHelperLauncher("/nonexistent/python3"),
      operationContainer: async () => ({
        name: "capybara-device-d",
        user: "1000:1000",
        release: () => released.push("capybara-device-d"),
      }),
    };
    const digest = SANDBOX_IMAGE_PIN.platforms.amd64.config;
    const s = staged({
      cred: credential({ mode: "docker" }),
      platform: "linux",
      container,
      imageDigest: digest,
    });
    await s.device.binder.bind(request(G1, B1, null), signal());
    // recorded as the pinned index, whichever pinned digest the image store reported; the
    // interpreter and shell are the image's (probed in a helper container), never the host's
    expect(s.environments[0]?.providerImageDigest).toBe(SANDBOX_IMAGE_PIN.index);
    expect(s.environments[0]?.place).toBe("image");
    expect(s.environments[0]?.helpers).toBe(container.helpers);
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
    // only the pinned image is attested: another digest, or another platform's, binds nothing
    for (const imageDigest of [
      `sha256:${"9".repeat(64)}`,
      SANDBOX_IMAGE_PIN.platforms.arm64.config,
      SANDBOX_IMAGE_PIN.platforms.arm64.manifest,
    ]) {
      const other = staged({
        cred: credential({ mode: "docker" }),
        platform: "linux",
        container,
        imageDigest,
      });
      await expect(other.device.binder.bind(request(G1, B1, null), signal())).rejects.toThrow(
        /not the pinned sandbox image/,
      );
      expect(other.environments).toEqual([]);
    }
    // the containerd store reports the index or the platform's manifest digest: both are pinned
    for (const imageDigest of [
      SANDBOX_IMAGE_PIN.index,
      SANDBOX_IMAGE_PIN.platforms.amd64.manifest,
    ]) {
      const ok = staged({
        cred: credential({ mode: "docker" }),
        platform: "linux",
        container,
        imageDigest,
      });
      await ok.device.binder.bind(request(G1, B1, null), signal());
      expect(ok.environments[0]?.providerImageDigest).toBe(SANDBOX_IMAGE_PIN.index);
    }
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
  const ready = (k: FakeKernel, conn: number) => k.ready(conn);
  const res = (k: FakeKernel, id: string) => k.answer(id);
  const send = (k: FakeKernel, conn: number, id: string, op: string, args: object) =>
    k.request(conn, id, op, args);

  it("sends x-capybara-device-protocol capybara-device/6", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null });
    cleanups.push(() => {
      conn.stop();
      return conn.done;
    });
    await k.waitFor("hello", () => k.of("hello")[0]);
    expect(k.headers[0]?.["x-capybara-device-protocol"]).toBe("capybara-device/6");
    expect(k.headers[0]?.["x-capybara-device-protocol"]).toBe(DEVICE_DIAL_IN_PROTOCOL);
    expect(k.headers[0]?.authorization).toBe("Bearer cap_dev_a");
  });

  it("hello envelope carries program facts and the body carries ownerCeiling", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const conn = connectStaged(s.device, {
      err: () => {},
      bootId: "boot-1",
      programVersion: "9.9.9",
    });
    cleanups.push(() => {
      conn.stop();
      return conn.done;
    });
    const raw = await k.waitFor("hello", () => k.of("hello")[0]);
    // the kernel's strict envelope parser accepts it as sent
    const hello = parseDialInMachineFrame(JSON.stringify(raw), 69632);
    if (hello.type !== "hello") throw new Error("expected a hello");
    expect(hello).toEqual({
      type: "hello",
      protocol: "capybara-device/6",
      // this process's run: every connection it makes names the same one
      programRunId: PROGRAM_RUN_ID,
      program: {
        version: "9.9.9",
        // the staged device's platform (the fixture defaults to darwin), not the test host's
        os: "darwin",
        arch: process.arch,
        bootId: "boot-1",
      },
      transport: { maxFrameBytes: 69632, binaryStreamData: true },
      body: expect.any(Object),
    });
    // the body is the device protocol's: the owner's ceiling and no program fact
    const body = parseDeviceFrame(hello.body, "hello");
    expect(body.ownerCeiling).toEqual(s.device.owner.report());
    expect(body.instanceGeneration).toBeNull();
    for (const key of ["protocol", "programVersion", "os", "arch", "bootId", "programRunId"])
      expect(hello.body).not.toHaveProperty(key);
    // no policy op is served any more: the deployment changes no policy on this machine
    const announced = (hello.body as { features?: unknown[] }).features ?? [];
    expect(announced).not.toContain("policyOp");
    expect(announced).not.toContain("policyOpId");
    expect(hello.body).not.toHaveProperty("recentOps");
  });

  it("against a kernel without binary stream data, the next hello drops the offer", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null });
    cleanups.push(() => {
      conn.stop();
      return conn.done;
    });
    const first = await k.waitFor("hello", () => k.of("hello", 0)[0]);
    expect(first.transport).toEqual({ maxFrameBytes: 69632, binaryStreamData: true });
    // a kernel released before the offer: its strict envelope knows only maxFrameBytes
    expect(Object.keys(first.transport)).not.toEqual(["maxFrameBytes"]);
    k.sockets[0]?.close(4400, "invalid frame");
    const second = await k.waitFor("second hello", () => k.of("hello", 1)[0], 15_000);
    expect(second.transport).toEqual({ maxFrameBytes: 69632 });
    // that kernel accepts it, and the machine is served on JSON stream data
    ready(k, 1);
    send(k, 1, "c1", "create", { limits: LIMITS });
    expect(await res(k, "c1")).toMatchObject({ ok: true });
  });

  it("an unbound hello, then the binding and lifecycle over the socket", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null });
    cleanups.push(() => {
      conn.stop();
      return conn.done;
    });
    const hello = await k.waitFor("hello", () => k.of("hello")[0]);
    expect(hello).toMatchObject({
      body: { instanceGeneration: null },
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

  it("the owner changing its ceiling on the machine is reported as an event", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null, policyCheckMs: 10 });
    cleanups.push(() => {
      conn.stop();
      return conn.done;
    });
    const hello = await k.waitFor("hello", () => k.of("hello")[0]);
    ready(k, 0);
    writePolicy(state, {
      ...FULL_POLICY,
      ownerCeiling: { ...FULL_OWNER_CEILING, outsideSandbox: false },
    });
    const event = await k.waitFor("event", () => k.of("event")[0]);
    const body = parseDeviceFrame(event.body, "event");
    expect(body).toMatchObject({ type: "policy", ownerCeiling: { outsideSandbox: false } });
    expect(body.ownerCeiling.revision).not.toBe(hello.body.ownerCeiling.revision);
    expect(body.ownerCeiling).toEqual(s.device.owner.report());
    // nothing more while nothing changes
    await new Promise((r) => setTimeout(r, 50));
    expect(k.of("event")).toHaveLength(1);
  });

  it("only a shared project directory the owner listed is announced to the deployment, never naming the other connection", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    recordProjectRoot(state, "/p/listed");
    recordProjectRoot(state, "/p/picked");
    recordProjectRoot(state, "/p/mine");
    // another connection on this machine uses /p/picked and /p/listed too
    const other = connectionDir(machineDirOfConnection(state), "other-dev");
    writeCredential(other, credential({ deviceId: "other-dev", url: "http://other.test" }));
    recordProjectRoot(other, "/p/picked");
    recordProjectRoot(other, "/p/listed");
    const conn = connectStaged(s.device, { err: () => {}, bootId: null, policyCheckMs: 10 });
    cleanups.push(() => {
      conn.stop();
      return conn.done;
    });
    // both are shared, but the deployment picked them itself: neither is reported
    const hello = await k.waitFor("hello", () => k.of("hello")[0]);
    expect(parseDeviceFrame(hello.body, "hello").policy?.sharedProjectRoots).toEqual([]);
    ready(k, 0);
    const read = vi.spyOn(s.device, "policySummary");
    await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(k.of("event")).toHaveLength(0);
    // the owner lists /p/listed for this connection: that shared root (only) is announced
    writePolicy(state, { ...FULL_POLICY, projectPaths: ["/p/listed"] });
    const event = await k.waitFor("event", () => k.of("event")[0]);
    const body = parseDeviceFrame(event.body, "event");
    expect(body.policy?.sharedProjectRoots).toEqual(["/p/listed"]);
    expect(JSON.stringify(event)).not.toContain("other-dev");
    expect(JSON.stringify(event)).not.toContain("other.test");
    expect(JSON.stringify(event)).not.toContain("/p/picked");
    // nothing more while nothing changes: two further checks complete without an event (a check
    // decides synchronously once it has read the summary, so the third read follows two decisions)
    const after = read.mock.calls.length;
    await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(after + 3));
    expect(k.of("event")).toHaveLength(1);
  });

  it("a kernel stop frame (drain) refuses new work, waits for the owned work and exits 0", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null });
    await k.waitFor("hello", () => k.of("hello")[0]);
    ready(k, 0);
    send(k, 0, "b1", "bindInstance", request(G1, B1, null));
    await res(k, "b1");
    await s.startTask("task-1");
    k.send(0, { type: "stop", reason: "drain" });
    send(k, 0, "c1", "create", { limits: LIMITS });
    expect(await res(k, "c1")).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    for (const f of s.finishers) f();
    expect(await conn.done).toBe(0);
    expect(s.cancelled).toEqual([]);
  });

  // The kernel's revocation, deletion and replacement send `stop` right before the close: the
  // close code still names why the program ends.
  for (const [ending, close, expected] of [
    ["revoked", [4003, "the machine was disconnected"], DISCONNECTED_MESSAGE],
    ["deleted", [4003, "the device was deleted"], DELETED_MESSAGE],
    ["replaced", [4002, "replaced by a newer connection"], REPLACED_MESSAGE],
    ["no close", undefined, KERNEL_STOPPED_MESSAGE],
  ] as const)
    it(`a kernel stop frame (stop) then ${ending} stops the owned work and says why`, async () => {
      const k = await kernel();
      const s = staged({ cred: credential({ connectUrl: k.url }) });
      const errs: string[] = [];
      const conn = connectStaged(s.device, {
        err: (l) => errs.push(l),
        bootId: null,
        sleep: async () => {},
        closeTimeoutMs: 50,
      });
      await k.waitFor("hello", () => k.of("hello")[0]);
      ready(k, 0);
      send(k, 0, "b1", "bindInstance", request(G1, B1, null));
      await res(k, "b1");
      await s.startTask("task-1");
      k.send(0, { type: "stop", reason: "stop" });
      await vi.waitFor(() => expect(s.cancelled).toEqual(["task-1"]));
      if (close) k.sockets[0]?.close(close[0], close[1]);
      expect(await conn.done).toBe(0);
      expect(errs).toContain(expected);
      // it never reconnects
      expect(k.sockets).toHaveLength(1);
    });

  it("a frame that is not a valid kernel envelope closes the socket with 4400", async () => {
    const k = await kernel();
    const s = staged({ cred: credential({ connectUrl: k.url }) });
    const conn = connectStaged(s.device, { err: () => {}, bootId: null, sleep: async () => {} });
    cleanups.push(() => {
      conn.stop();
      return conn.done;
    });
    await k.waitFor("hello", () => k.of("hello")[0]);
    ready(k, 0);
    const closed = new Promise<number>((r) => k.sockets[0]?.once("close", (code) => r(code)));
    // the flat protocol 4 request: not an envelope
    k.send(0, { type: "req", id: "r1", op: "create", args: { limits: LIMITS }, deadlineMs: 5000 });
    expect(await closed).toBe(4400);
    expect(k.of("res")).toEqual([]);
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

  // A 426 names the protocol the deployment serves this device with: an older deployment is to
  // be upgraded, not this program.
  for (const [kernelProtocol, expected] of [
    ["capybara-device/6", OUTDATED_MESSAGE],
    ["capybara-device/4", deploymentOutdatedMessage("capybara-device/4")],
    ["fake-dial-in/1", foreignProtocolMessage("fake-dial-in/1")],
    [undefined, OUTDATED_MESSAGE],
  ] as const) {
    it(`a kernel 426 naming ${kernelProtocol ?? "(unreadable)"} says which side to update`, async () => {
      const k = await kernel();
      k.rejectWith = 426;
      k.rejectBody =
        kernelProtocol === undefined
          ? undefined
          : {
              error: {
                code: "device.program_outdated",
                message: `This device is served with ${kernelProtocol}, not capybara-device/6.`,
              },
            };
      const s = staged({ cred: credential({ connectUrl: k.url }) });
      const errs: string[] = [];
      const conn = connectStaged(s.device, { err: (l) => errs.push(l), bootId: null });
      expect(await conn.done).toBe(1);
      expect(errs).toContain(expected);
    });
  }

  it("reads the kernel's own 426 sentence: plugin names and the install hint never match first", () => {
    const body = (expected: string) =>
      JSON.stringify({
        error: {
          code: "device.program_outdated",
          message: `This device is served by device-local2, which speaks ${expected}; this program speaks capybara-device/6. Update the program on the machine to the release that speaks this protocol (for capybara-device: npm install -g @capybara-hq/device@next), then start it again.`,
        },
      });
    expect(outdatedMessage(body("capybara-device/4"))).toBe(
      deploymentOutdatedMessage("capybara-device/4"),
    );
    expect(outdatedMessage(body("capybara-device/6"))).toBe(OUTDATED_MESSAGE);
  });

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
