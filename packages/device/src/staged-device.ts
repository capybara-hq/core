import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_SANDBOX_ROOTS,
  type DeviceFeature,
  type DeviceHelloV3,
  FileSystemGoneError,
  type SandboxHandle,
  type SandboxPermissionSupport,
  SandboxPermissionUnsupportedError,
  type SandboxRoots,
  type SandboxStopResult,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import type { OperationContainerHost } from "./exec/docker-operations.js";
import { credentialIdentity, InstanceBinder, type StoredBinding } from "./exec/instance-binding.js";
import type { LinuxBackendDependencies } from "./exec/linux-operation-backend.js";
import type {
  MacOperationBackend,
  MacOperationBackendOptions,
} from "./exec/mac-operation-backend.js";
import type { MacSelfCheckInput } from "./exec/mac-self-check.js";
import { readStrictOwnerCeiling } from "./exec/operation-types.js";
import type { MacWorkerHandle, MacWorkerRequest } from "./exec/operation-worker.js";
import type { EnvironmentInputs, VerifiedRuntime } from "./exec/runtime-manifest.js";
import { osRoots, RootGuard } from "./exec/shared.js";
import { issueOwnerReport } from "./owner-report.js";
import type { PolicyStore } from "./policy-store.js";
import { policySummary, type StagedOwnerPolicy } from "./server-ops.js";
import { StagedSessionStates } from "./staged-session.js";
import type { Credential } from "./state.js";
import { PROGRAM_VERSION } from "./version.js";

/** The interpreter the trusted helpers run with, by absolute path (never looked up on PATH). */
export const HOST_PYTHON = "/usr/bin/python3";
/** How long a stopped operation gets to end on its own before it is killed (machine stop). */
export const MACHINE_STOP_GRACE_MS = 2000;
/** The longest the restricted self-check of one binding may take. */
export const SELF_CHECK_TIMEOUT_MS = 60_000;

const UNBOUND_REASON =
  "The instance is not bound yet; the deployment binds it before running operations";

/** The permission support an unbound program reports: nothing runs until the bind. */
export const UNBOUND_SUPPORT: SandboxPermissionSupport = Object.freeze({
  version: 1,
  restricted: null,
  fullAccess: false,
  background: false,
  unavailableReason: UNBOUND_REASON,
});

/**
 * The operation backend a staged session names for its lifecycle and policy controls while no
 * generation is bound: those controls never use it, and every operation on it is refused.
 */
const UNBOUND_BACKEND = new Proxy(
  {},
  {
    get: () => () => {
      throw new SandboxPermissionUnsupportedError(UNBOUND_REASON);
    },
  },
) as MacOperationBackend;

/** The lifecycle of an unbound program: it owns nothing. */
const IDLE_LIFECYCLE: MacOperationBackend["lifecycle"] = {
  beginDrain: () => {},
  ownership: () => ({ workers: 0, cancellations: 0, collectors: 0, persistence: 0 }),
  settle: async () => {},
  retirementObligations: () => 0,
  stopOwned: async () => [],
  dispose: () => {},
};

/** Trusted construction input of a staged (protocol 3) program; nothing here comes off the wire. */
export interface StagedDeviceOptions {
  cred: Credential;
  stateDir: string;
  policy: PolicyStore;
  /** The owner's home (default: the user's), for the denied secret paths and the hello. */
  home?: string;
  platform?: NodeJS.Platform;
  /** A docker-mode device lends its container to each operation (the Docker executor). */
  container?: OperationContainerHost;
  pythonPath?: string;
  /**
   * Test seams (trusted construction only). Production verifies the installed program
   * (`verifyInstalledRuntime`), runs the macOS self-check on real workers and builds each
   * generation's backend with `createHostOperationBackend` / `createDockerOperationBackend`.
   */
  verifyRuntime?: (
    environment: EnvironmentInputs,
    options: { stageIn: string },
  ) => Promise<VerifiedRuntime>;
  selfCheck?: (input: MacSelfCheckInput, signal: AbortSignal) => Promise<string | null>;
  startWorker?: (request: MacWorkerRequest, signal: AbortSignal) => Promise<MacWorkerHandle>;
  linux?: LinuxBackendDependencies;
  backendDependencies?: Pick<LinuxBackendDependencies, "now" | "watch">;
}

/** What `start` serves a staged connection with: one per process and machine credential. */
export interface StagedDevice {
  readonly cred: Credential;
  readonly mode: "os" | "docker";
  readonly roots: SandboxRoots;
  readonly handle: SandboxHandle;
  /** One session state per machine credential ({@link StagedSessionStates}). */
  readonly states: StagedSessionStates;
  readonly binder: InstanceBinder;
  readonly owner: StagedOwnerPolicy;
  /** The bound generation's backend, or the refusing placeholder while unbound. */
  backend(): MacOperationBackend;
  /** What a drain waits for: the bound backend's owned work (nothing while unbound). */
  drainTarget(): Pick<MacOperationBackend, "lifecycle">;
  /** The hello of a new socket: the bound generation, its verified identity and support. */
  report(opts?: {
    programVersion?: string;
    home?: string;
    bootId?: string;
  }): Promise<Omit<DeviceHelloV3, "transport">>;
  /** `create`: the roots of a new instance; the bound (now older) generation's tasks are dropped. */
  create(signal: AbortSignal): Promise<{ roots: SandboxRoots }>;
  /** Machine stop: no new admission, then every owned operation is exact-stopped. */
  cancelOwners(signal: AbortSignal): Promise<SandboxStopResult[]>;
}

/**
 * Builds a staged program's production parts (permission activation W3-M): the post-commit
 * binder, which builds one operation backend per bound generation (macOS: the shared backend with
 * restricted support only after the verified manifest and a real worker self-check at bind;
 * Linux: the launcher probe; docker: the container backend), each attested to its binding's
 * runtime hash; the per-credential session states; and the owner policy controls.
 */
export function createStagedDevice(o: StagedDeviceOptions): StagedDevice {
  const { cred, stateDir, policy } = o;
  const platform = o.platform ?? process.platform;
  const pythonPath = o.pythonPath ?? HOST_PYTHON;
  const home = o.home ?? homedir();
  const mode = cred.mode === "docker" ? "docker" : "os";
  if (mode === "docker" && !o.container)
    throw new Error("A docker-mode device needs its container to run operations");
  const hostRoots = osRoots(resolve(cred.dir));
  const roots = mode === "docker" ? { ...DEFAULT_SANDBOX_ROOTS } : hostRoots;
  const handle: SandboxHandle = { id: cred.deviceId };
  const guard = new RootGuard(resolve(cred.dir), hostRoots);
  const readOwnerCeiling = () =>
    readStrictOwnerCeiling({ stateDir, deviceId: cred.deviceId, dir: cred.dir, home });

  const verify = async () => {
    const environment: EnvironmentInputs = { pythonPath, roots };
    // restricted workers launch only from the closure this verification stages and seals
    if (o.verifyRuntime) return o.verifyRuntime(environment, { stageIn: stateDir });
    const { verifyInstalledRuntime } = await import("./exec/runtime-manifest.js");
    return verifyInstalledRuntime(environment, undefined, { stageIn: stateDir });
  };

  const createBackend = async (
    _generation: string,
    binding: StoredBinding,
  ): Promise<MacOperationBackend> => {
    const runtimeHash = binding.runtimeIdentity.runtimeHash;
    const options: MacOperationBackendOptions = {
      deviceId: cred.deviceId,
      instanceGeneration: binding.instanceGeneration,
      stateDir,
      roots: hostRoots,
      pythonPath,
      // restricted launches run only the sealed runtime this binding attested
      runtimeHash,
      readOwnerCeiling,
    };
    const deps = o.backendDependencies ?? {};
    if (mode === "docker") {
      const { createDockerOperationBackend } = await import("./exec/docker-operations.js");
      const { roots: _host, ...rest } = options;
      return createDockerOperationBackend(
        { ...rest, hostRoots, container: o.container as OperationContainerHost },
        { ...deps, ...o.linux },
      );
    }
    const { createHostOperationBackend } = await import("./exec/linux-operation-backend.js");
    if (platform !== "darwin")
      return createHostOperationBackend(options, { platform, linux: { ...deps, ...o.linux } });
    // macOS: restricted support only once a real worker on the verified, sealed runtime proved
    // it here (the binder verified the manifest just before building this backend)
    const startWorker =
      o.startWorker ?? (await import("./exec/operation-worker.js")).startMacOperationWorker;
    const selfCheck =
      o.selfCheck ?? (await import("./exec/mac-self-check.js")).macRestrictedSelfCheck;
    const failure = await selfCheck(
      { stateDir, pythonPath, runtimeHash, platform, startWorker },
      AbortSignal.timeout(SELF_CHECK_TIMEOUT_MS),
    );
    return createHostOperationBackend(options, {
      platform,
      mac: {
        ...deps,
        platform,
        startWorker,
        restrictedSupported: failure === null,
        ...(failure !== null ? { unavailableReason: failure } : {}),
      },
    });
  };

  const binder = new InstanceBinder({
    deviceId: cred.deviceId,
    credentialIdentity: credentialIdentity(cred.credential),
    stateDir,
    createBackend,
    verify,
    ownerReport: async () => owner.report(),
  });
  const owner: StagedOwnerPolicy = {
    store: policy,
    report: () => issueOwnerReport({ stateDir, deviceId: cred.deviceId, dir: cred.dir, home }),
    reconcile: async (signal) => {
      await binder.current()?.backend.reconcileOwnerCeiling(signal);
    },
  };
  const backend = () => binder.current()?.backend ?? UNBOUND_BACKEND;

  return {
    cred,
    mode,
    roots,
    handle,
    states: new StagedSessionStates(),
    binder,
    owner,
    backend,
    drainTarget: () => binder.current()?.backend ?? { lifecycle: IDLE_LIFECYCLE },
    async report(r = {}) {
      const bound = binder.current();
      const permissionSupport = bound
        ? await bound.backend.permissionSupport(bound.handle, AbortSignal.timeout(30_000))
        : UNBOUND_SUPPORT;
      const ownerHome = r.home ?? home;
      const features: DeviceFeature[] = [];
      if (mode === "os") features.push("networkReport");
      features.push("policyOp", "policyOpId", "mode", "projects");
      return {
        type: "hello",
        protocol: 3,
        programVersion: r.programVersion ?? PROGRAM_VERSION,
        os: platform === "darwin" ? "darwin" : "linux",
        arch: process.arch,
        mode,
        roots,
        sessionIsolation: false,
        features,
        // a container device offers only its container's workspace: the host's home is no base
        ...(mode === "os" &&
          validateSandboxPathShape(ownerHome).length === 0 && { home: ownerHome }),
        ...(r.bootId !== undefined && { bootId: r.bootId }),
        policy: policySummary(policy.current(), { mode }),
        recentOps: policy.ops.recent(),
        permissionSupport,
        ownerCeiling: owner.report(),
        instanceGeneration: bound?.binding.instanceGeneration ?? null,
        ...(bound && { runtimeIdentity: bound.binding.runtimeIdentity }),
      };
    },
    async create(signal) {
      signal.throwIfAborted();
      if (guard.ensure() === "gone")
        throw new FileSystemGoneError(
          "The device directory on this machine existed and is gone. It is not recreated automatically.",
        );
      // a new instance replaces the bound generation: its background tasks are dropped
      await binder.dropOlderGenerations(signal);
      return { roots };
    },
    async cancelOwners(signal) {
      const bound = binder.current();
      if (!bound) return [];
      bound.backend.lifecycle.beginDrain();
      return bound.backend.lifecycle.stopOwned({
        backgroundOnly: false,
        graceMs: MACHINE_STOP_GRACE_MS,
        signal,
      });
    },
  };
}
