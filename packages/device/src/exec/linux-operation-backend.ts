import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { DEVICE_PROCESS_TOKEN, linuxOperationWorker } from "./linux-operation-worker.js";
import {
  hostLinuxTransport,
  type LinuxAgentTransport,
  type LinuxProbe,
  probeLinuxRuntime,
  reapLinuxSession,
} from "./linux-runtime.js";
import {
  createLocalOperationBackend,
  createMacOperationBackend,
  type MacBackendDependencies,
  type MacOperationBackend,
  type MacOperationBackendOptions,
} from "./mac-operation-backend.js";
import { type LocalOperationGrant, within } from "./operation-types.js";
import type { MacWorkerHandle, MacWorkerRequest } from "./operation-worker.js";

/** The local operation backend of any platform (the macOS shape is the shared one). */
export type LocalOperationBackend = MacOperationBackend;

/** Trusted construction dependencies of the Linux backend; never decoded from a request. */
export interface LinuxBackendDependencies {
  /** How agents start: on this host (default) or in the device's local container. */
  transport?: LinuxAgentTransport;
  /** The environment a command starts from; see {@link hostBaseEnv}. */
  baseEnv?: (full: boolean) => Record<string, string>;
  /** The runtime support probe (default: the launcher's own probe through the agent). */
  probe?: () => Promise<LinuxProbe>;
  /** Forces restricted support off (an owner or wiring decision); it can never force it on. */
  restrictedSupported?: boolean;
  /** Test seams: the worker, the runtime-hash gate, the clock and the idle watcher. */
  startWorker?: (request: MacWorkerRequest, signal: AbortSignal) => Promise<MacWorkerHandle>;
  acquireRuntime?: (runtimeHash: string | undefined) => Promise<{ release(): void }>;
  now?: () => number;
  watch?: (tick: () => Promise<void>) => () => void;
  /** Called with a reap failure of a lost supervisor's session (default: ignored). */
  onReapError?: (error: unknown) => void;
}

/** A host command's starting environment: Full keeps this process's, restricted a fixed set. */
export function hostBaseEnv(full: boolean): Record<string, string> {
  if (full)
    return Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
  };
}

/**
 * Landlock only grants: it cannot hide an owner-denied path (a secret directory, the device's
 * state) inside a granted root, so such an exec grant is refused rather than widened. Native work
 * checks every resolved path against the denied roots itself (in the agent), so it needs no such
 * refusal.
 */
export function checkLinuxRestrictedGrant(
  grant: LocalOperationGrant,
  kind: "exec" | "native",
): void {
  if (kind === "native") return;
  for (const denied of grant.deniedReadRoots)
    for (const root of [...grant.readRoots, ...grant.writeRoots])
      if (within(denied, root))
        throw new SandboxScopeDeniedError(
          "A granted root contains a path the owner denies; restricted Linux execution cannot exclude it, so grant a narrower root",
        );
}

/**
 * The Linux local operation backend (permission activation W2-S): the same functions as the macOS
 * backend on the SDK's restricted Linux runtime. Restricted exec runs through the launcher on
 * pinned root descriptors (Landlock, the seccomp broker), with network none or an allowlist served
 * by an operation-owned proxy; native work uses the SDK helper on the same kind of pinned
 * descriptors; Full access runs as the OS user without restricted filters. Background work,
 * retained output and exact cancellation share the macOS supervisor. Restricted support is what
 * the launcher's probe reports (an unsupported kernel, ABI or architecture fails closed while Full
 * keeps working), and every restricted launch passes the runtime-hash gate of the binding.
 */
export async function createLinuxOperationBackend(
  options: MacOperationBackendOptions,
  dependencies: LinuxBackendDependencies = {},
): Promise<LocalOperationBackend> {
  const transport =
    dependencies.transport ??
    hostLinuxTransport({ stateDir: options.stateDir, pythonPath: options.pythonPath });
  const probe = await (dependencies.probe ?? (() => probeLinuxRuntime(transport)))();
  const unavailableReason =
    dependencies.restrictedSupported === false
      ? "Restricted Linux execution is switched off for this device"
      : probe.restricted === null
        ? `Restricted Linux execution is unavailable: ${probe.reason ?? "the runtime probe failed"}`
        : !options.runtimeHash
          ? "Restricted Linux execution needs an instance binding with an attested runtime"
          : undefined;
  const startWorker =
    dependencies.startWorker ??
    linuxOperationWorker({
      transport,
      baseEnv: dependencies.baseEnv ?? hostBaseEnv,
      ...(dependencies.acquireRuntime ? { acquireRuntime: dependencies.acquireRuntime } : {}),
    });
  return createLocalOperationBackend(
    options,
    {
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.watch ? { watch: dependencies.watch } : {}),
    },
    {
      restricted: unavailableReason === undefined,
      ...(unavailableReason ? { unavailableReason } : {}),
      fullAccess: true,
      background: true,
      pending: unavailableReason ?? "Restricted Linux execution is unavailable",
      startWorker,
      checkRestrictedGrant: checkLinuxRestrictedGrant,
      reapOrphan: (identity) => {
        // only sessions another (lost) device process recorded; this process owns its own
        if (!identity.session || identity.process === DEVICE_PROCESS_TOKEN) return;
        // another process recorded it: only while its leader still runs with that start time
        void reapLinuxSession(transport, identity.session, { requireLeader: true }).catch((error) =>
          dependencies.onReapError?.(error),
        );
      },
    },
  );
}

/**
 * The operation backend for this host: macOS keeps its backend; Linux hosts get the Linux one.
 * (A device in local-Docker mode builds its backend from the container's transport instead.)
 */
export async function createHostOperationBackend(
  options: MacOperationBackendOptions,
  dependencies: {
    platform?: NodeJS.Platform;
    mac?: MacBackendDependencies;
    linux?: LinuxBackendDependencies;
  } = {},
): Promise<LocalOperationBackend> {
  const platform = dependencies.platform ?? process.platform;
  if (platform === "linux") return createLinuxOperationBackend(options, dependencies.linux);
  return createMacOperationBackend(options, { ...dependencies.mac, platform });
}
