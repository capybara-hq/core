import { resolve } from "node:path";
import {
  type ExecResult,
  parseSandboxBrowseScope,
  parseSandboxOperationScope,
  parseSandboxPreparationScope,
  type SandboxBackground,
  type SandboxBrowseScope,
  type SandboxHandle,
  type SandboxOperation,
  type SandboxOperationScope,
  SandboxPermissionUnsupportedError,
  type SandboxPreparationScope,
  type SandboxProvider,
  SandboxScopeDeniedError,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import { implicitWritePaths } from "../policy.js";
import type { NativeHelperRequest, NativeHelperResult } from "./native-helper-client.js";
import {
  MacOperationSupervisor,
  type SupervisorOptions,
  type SupervisorOwnership,
} from "./operation-supervisor.js";
import {
  checkRoots,
  type DeviceOwnerCeiling,
  digest,
  freezeAuthority,
  grantStillHolds,
  intersectOperation,
  type LocalExecAuthority,
  type LocalOperationGrant,
  within,
} from "./operation-types.js";
import type { MacWorkerHandle, MacWorkerRequest } from "./operation-worker.js";
export interface MacOperationBackendOptions {
  deviceId: string;
  instanceGeneration: string;
  stateDir: string;
  roots: DeviceOwnerCeiling["roots"];
  pythonPath: string;
  /**
   * The runtime hash this generation's binding attested. Restricted launches run only the sealed
   * runtime with this hash; without it they are refused.
   */
  runtimeHash?: string;
  readOwnerCeiling: () => Promise<DeviceOwnerCeiling>;
}
export type MacOperationBackend = Required<
  Pick<
    SandboxProvider,
    "permissionSupport" | "operation" | "browse" | "prepare" | "revokeOperation" | "background"
  >
> & {
  forExecution(
    authority: LocalExecAuthority,
  ): Pick<MacOperationBackend, "operation" | "background">;
  reconcileOwnerCeiling(signal: AbortSignal): Promise<void>;
  /** The owner lifecycle: graceful drain over what the supervisor owns (never a PID scan). */
  lifecycle: {
    beginDrain(): void;
    ownership(): SupervisorOwnership;
    settle(signal: AbortSignal): Promise<void>;
    /** Unsettled work of generations other than `generation` (default: this backend's). */
    retirementObligations(generation?: string): number;
    /**
     * Exact-stops what this backend owns live, each by its recorded ref (machine stop: all of it;
     * a replacement instance: its background tasks only). Resolves once each attempt settled.
     */
    stopOwned(opts: {
      backgroundOnly: boolean;
      graceMs: number;
      signal: AbortSignal;
    }): Promise<
      { operationId: string; result: import("@capybara-hq/plugin-sdk").SandboxStopResult }[]
    >;
    /** What would still refuse a binding to `generation` once the live background tasks stopped. */
    blockersBesidesLiveBackground(generation: string): number;
    /**
     * Supersedes this backend (B4): its supervisor gives the journal up and every later call is
     * refused. Throws while it still owns work.
     */
    dispose(): void;
  };
};
/** Trusted construction dependencies; never decoded from a command, scope or wire message. */
export interface MacBackendDependencies {
  platform?: NodeJS.Platform;
  startWorker?: (request: MacWorkerRequest, signal: AbortSignal) => Promise<MacWorkerHandle>;
  restrictedSupported?: boolean;
  /** Why restricted support is off, reported instead of the default. */
  unavailableReason?: string;
  /**
   * The per-generation restricted proof (the macOS worker self-check): restricted operations run
   * only while it holds, and a permission report first retries a failed proof (rate-limited).
   */
  restrictedProof?: RestrictedProof;
  now?: () => number;
  watch?: (tick: () => Promise<void>) => () => void;
}
const PENDING =
  "Restricted macOS per-instance validation and coordinated policy/background activation are pending";
/** A restricted-support proof that can fail transiently and be retried. */
export interface RestrictedProof {
  /** Null while the proof holds; otherwise why restricted execution is unavailable. */
  failure(): string | null;
  /** Retries a failed proof when its retry interval allows (bounded); never throws. */
  refresh(): Promise<void>;
}
/**
 * What one platform contributes to the shared local operation backend: its proven restricted
 * support, whether Full access and background work run here, and the platform-specific checks.
 * Trusted construction input only.
 */
export interface LocalBackendHost {
  /** Restricted operations may run (the platform runtime proved its support). */
  restricted: boolean;
  /** Why restricted operations are unavailable, when they are. */
  unavailableReason?: string;
  /** Escalated calls (outside the sandbox) and background work run on this platform. */
  outsideSandbox: boolean;
  background: boolean;
  /** The message a refused restricted operation carries. */
  pending: string;
  startWorker?: (request: MacWorkerRequest, signal: AbortSignal) => Promise<MacWorkerHandle>;
  /** Refuses a restricted grant this platform cannot enforce exactly (typed scope denial). */
  checkRestrictedGrant?: (grant: LocalOperationGrant, kind: "exec" | "native") => void;
  /** Refuses a restricted background artifact target this platform protects. */
  checkArtifactTarget?: (outputPath: string) => void;
  /**
   * Where the trusted supervisor writes a background artifact, when the operation's paths are not
   * this process's own (a container's bind mounts); refuses a target it cannot map.
   */
  artifactTarget?: (target: { outputPath: string; artifactRoot: string }) => {
    outputPath: string;
    artifactRoot: string;
  };
  /** Called once per recorded launch identity a previous device process left running. */
  reapOrphan?: SupervisorOptions["reapOrphan"];
  /** Restricted operations run only while this proof holds (see {@link RestrictedProof}). */
  proof?: RestrictedProof;
}
export async function createMacOperationBackend(
  options: MacOperationBackendOptions,
  dependencies: MacBackendDependencies = {},
): Promise<MacOperationBackend> {
  const platform = dependencies.platform ?? process.platform;
  const restricted =
    platform === "darwin" &&
    dependencies.restrictedSupported === true &&
    dependencies.startWorker !== undefined;
  return createLocalOperationBackend(options, dependencies, {
    restricted,
    ...(!restricted
      ? {
          unavailableReason:
            dependencies.unavailableReason ??
            (platform === "darwin"
              ? PENDING
              : "Restricted Linux/local-Docker validation remains pending"),
        }
      : {}),
    outsideSandbox: platform === "darwin",
    background: platform === "darwin",
    pending: (!restricted && dependencies.unavailableReason) || PENDING,
    ...(dependencies.startWorker ? { startWorker: dependencies.startWorker } : {}),
    ...(restricted && dependencies.restrictedProof ? { proof: dependencies.restrictedProof } : {}),
    checkArtifactTarget: (outputPath) => {
      const canonical = (path: string) => path.replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1");
      if (implicitWritePaths().some((root) => within(canonical(outputPath), canonical(root))))
        throw new SandboxScopeDeniedError(
          "Background artifact target is protected by the restricted write policy",
        );
    },
  });
}
/**
 * The local operation backend shared by every platform: owner-ceiling intersection, path bounds,
 * the durable supervisor (journal, retained output, exact cancellation) and the owner lifecycle.
 * The platform supplies its worker and its support facts through `host`.
 */
export async function createLocalOperationBackend(
  options: MacOperationBackendOptions,
  dependencies: Pick<MacBackendDependencies, "now" | "watch">,
  host: LocalBackendHost,
): Promise<MacOperationBackend> {
  // restricted support now: the platform's and, when it has one, its proof's
  const restrictedNow = () => host.restricted && (host.proof?.failure() ?? null) === null;
  const refusal = () => host.proof?.failure() ?? host.pending;
  let disposed = false;
  const checkHandle = (h: SandboxHandle) => {
    if (disposed)
      throw new SandboxPermissionUnsupportedError(
        "This instance generation was superseded; retry on the current binding",
      );
    if (h.id !== options.deviceId || (h.roots && digest(h.roots) !== digest(options.roots)))
      throw new SandboxScopeDeniedError("Device handle does not match this backend");
  };
  const read = async () => {
    const c = await options.readOwnerCeiling();
    if (digest(c.roots) !== digest(options.roots))
      throw new SandboxScopeDeniedError("Owner root identity changed");
    return c;
  };
  let stopWatch: (() => void) | undefined;
  let reconciling = false;
  let backend: MacOperationBackend;
  const tick = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      await backend.reconcileOwnerCeiling(new AbortController().signal);
    } finally {
      reconciling = false;
    }
  };
  const supervisor = new MacOperationSupervisor({
    stateDir: options.stateDir,
    deviceId: options.deviceId,
    instanceGeneration: options.instanceGeneration,
    pythonPath: options.pythonPath,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(host.startWorker ? { start: host.startWorker } : {}),
    ...(host.reapOrphan ? { reapOrphan: host.reapOrphan } : {}),
    onLiveChanged: (live) => {
      if (live && !stopWatch) {
        if (dependencies.watch) stopWatch = dependencies.watch(tick);
        else {
          const timer = setInterval(() => {
            void tick().catch(() => {});
          }, 1000);
          timer.unref();
          stopWatch = () => clearInterval(timer);
        }
      } else if (!live && stopWatch) {
        stopWatch();
        stopWatch = undefined;
      }
    },
  });
  const validateScopeDevice = (scope: { deviceId: string }) => {
    if (scope.deviceId !== options.deviceId)
      throw new SandboxScopeDeniedError("Scope belongs to another device");
  };
  const boundedPath = (path: string, grant: LocalOperationGrant, write = false) => {
    if (validateSandboxPathShape(path).length || path !== resolve(path))
      throw new SandboxScopeDeniedError("Invalid operation path");
    if (!grant.full) {
      const roots = write ? grant.writeRoots : [...grant.readRoots, ...grant.writeRoots];
      if (!roots.some((r) => within(path, r)) || grant.deniedReadRoots.some((r) => within(path, r)))
        throw new SandboxScopeDeniedError("Path is outside this operation scope");
      if (write && /(?:^|\/)\.git\/(?:config(?:$|\/)|hooks(?:$|\/))/.test(path))
        throw new SandboxScopeDeniedError("Git configuration and hooks are protected");
    }
  };
  const auxiliaryGrant = (
    scope: SandboxBrowseScope | SandboxPreparationScope,
    c: DeviceOwnerCeiling,
  ): LocalOperationGrant => {
    let readRoots: readonly string[];
    let writeRoots: readonly string[] = [];
    if ("purpose" in scope) {
      const base =
        scope.purpose === "skills" ? c.preparation.skillsRoot : c.preparation.attachmentsBase;
      for (const root of scope.writeRoots) {
        const suffix = root.slice(base.length + 1);
        if (
          !within(root, base) ||
          (scope.purpose === "attachments" && !/^[a-f0-9]{12}(?:\/|$)/.test(suffix))
        )
          throw new SandboxScopeDeniedError("Invalid purpose-specific preparation root");
      }
      writeRoots = scope.writeRoots;
      readRoots = [];
      checkRoots([], writeRoots, c, true);
    } else {
      readRoots = scope.readRoots;
      checkRoots(readRoots, [], c);
    }
    return {
      full: false,
      readRoots,
      writeRoots,
      hosts: [],
      deniedReadRoots: c.restrictedDeniedReadRoots,
      revision: c.revision,
    };
  };
  const invoke = async (
    scope: SandboxOperationScope | SandboxBrowseScope | SandboxPreparationScope,
    native: NativeHelperRequest | undefined,
    args: Omit<Parameters<SandboxOperation["exec"]>[0], "signal"> | undefined,
    signal: AbortSignal,
    authority?: LocalExecAuthority,
    background?: { retainUntilMs: number; taskId: string; outputPath: string },
  ) => {
    signal.throwIfAborted();
    validateScopeDevice(scope);
    const ceiling = await read();
    const grant =
      "profile" in scope
        ? intersectOperation(scope, ceiling, authority, native !== undefined)
        : auxiliaryGrant(scope, ceiling);
    if (!grant.full && !restrictedNow()) throw new SandboxPermissionUnsupportedError(refusal());
    if (!grant.full) host.checkRestrictedGrant?.(grant, native ? "native" : "exec");
    if (native) boundedPath(native.path, grant, native.method === "writeFile");
    if (args) {
      if (
        !Number.isSafeInteger(args.timeoutMs) ||
        args.timeoutMs <= 0 ||
        !Number.isSafeInteger(args.maxOutputBytes) ||
        args.maxOutputBytes < 0 ||
        args.maxOutputBytes > 16 * 1024 * 1024
      )
        throw new SandboxScopeDeniedError("Invalid execution bounds");
      if (args.cwd) boundedPath(args.cwd, grant);
    }
    if (background) {
      boundedPath(background.outputPath, grant, true);
      if (!grant.full) host.checkArtifactTarget?.(background.outputPath);
    }
    const common = {
      scope,
      grant,
      stateDir: options.stateDir,
      pythonPath: options.pythonPath,
      ...(options.runtimeHash ? { runtimeHash: options.runtimeHash } : {}),
      ...(authority ? { authority } : {}),
      beforeLaunch: async () => {
        signal.throwIfAborted();
        const fresh = await read();
        if (fresh.revision !== ceiling.revision)
          throw new SandboxScopeDeniedError(
            "Owner policy changed before launch; resolve fresh authority",
          );
      },
      onLaunch: async () => {},
    };
    const request: MacWorkerRequest = native
      ? {
          ...common,
          kind: "native",
          native,
          purpose: "profile" in scope ? "operation" : "purpose" in scope ? "preparation" : "browse",
        }
      : {
          ...common,
          kind: "exec",
          scope: scope as SandboxOperationScope,
          ...(background
            ? (() => {
                const target = {
                  outputPath: background.outputPath,
                  artifactRoot: grant.full
                    ? "/"
                    : ([...grant.writeRoots]
                        .filter((root) => within(background.outputPath, root))
                        .sort((a, b) => b.length - a.length)[0] as string),
                };
                return { managedOutput: host.artifactTarget?.(target) ?? target };
              })()
            : {}),
          args: {
            ...(args as Omit<Parameters<SandboxOperation["exec"]>[0], "signal">),
            cwd: args?.cwd ?? options.roots.workspace,
          },
        };
    const hash = digest({ scope, native, args, authority, background });
    return background
      ? supervisor.start(request, hash, background.retainUntilMs, signal)
      : supervisor.execute(request, hash, signal);
  };
  const nativeMethods = (
    scope: SandboxOperationScope | SandboxBrowseScope | SandboxPreparationScope,
    factorySignal: AbortSignal,
  ) => {
    const run = (request: NativeHelperRequest, signal: AbortSignal) =>
      invoke(
        scope,
        request,
        undefined,
        AbortSignal.any([factorySignal, signal]),
      ) as Promise<NativeHelperResult>;
    return {
      readFile: async (path: string, opts: { maxBytes: number; signal: AbortSignal }) => {
        if (
          !Number.isSafeInteger(opts.maxBytes) ||
          opts.maxBytes < 0 ||
          opts.maxBytes > 16 * 1024 * 1024
        )
          throw new SandboxScopeDeniedError("Invalid native read bound");
        const result = (await run(
          { method: "readFile", path, maxBytes: opts.maxBytes },
          opts.signal,
        )) as { dataB64: string; truncated: boolean } | null;
        return result
          ? { data: Buffer.from(result.dataB64, "base64"), truncated: result.truncated }
          : null;
      },
      writeFile: async (path: string, data: Uint8Array, signal: AbortSignal) => {
        if (data.byteLength > 16 * 1024 * 1024)
          throw new SandboxScopeDeniedError("Native write exceeds bounded transport");
        await run(
          { method: "writeFile", path, dataB64: Buffer.from(data).toString("base64") },
          signal,
        );
      },
      stat: (path: string, signal: AbortSignal) =>
        run({ method: "stat", path }, signal) as Promise<{ size: number; isDir: boolean } | null>,
      list: (path: string, opts: { limit: number; signal: AbortSignal }) =>
        run({ method: "list", path, limit: opts.limit }, opts.signal) as Promise<{
          entries: { name: string; isDir: boolean }[];
          truncated: boolean;
        } | null>,
      scan: (path: string, opts: { signal: AbortSignal }) =>
        run({ method: "scan", path }, opts.signal) as Promise<
          { path: string; suggestedName: string }[]
        >,
    };
  };
  const operation =
    (authority?: LocalExecAuthority): MacOperationBackend["operation"] =>
    async (h, input, factorySignal) => {
      checkHandle(h);
      factorySignal.throwIfAborted();
      const scope = parseSandboxOperationScope(input);
      validateScopeDevice(scope);
      return {
        ...nativeMethods(scope, factorySignal),
        exec: async (input) => {
          const { signal, ...args } = input;
          return invoke(
            scope,
            undefined,
            { ...args, ...(args.env ? { env: { ...args.env } } : {}) },
            AbortSignal.any([factorySignal, signal]),
            authority,
          ) as Promise<ExecResult>;
        },
      };
    };
  const background = (authority?: LocalExecAuthority): SandboxBackground => ({
    start: async (h, input, args) => {
      checkHandle(h);
      const scope = parseSandboxOperationScope(input);
      const { signal, taskId, outputPath, retainUntilMs, ...exec } = args;
      const snapshot = Object.freeze({
        ...exec,
        ...(exec.env ? { env: Object.freeze({ ...exec.env }) } : {}),
      });
      return invoke(scope, undefined, snapshot, signal, authority, {
        taskId,
        outputPath,
        retainUntilMs,
      }) as ReturnType<SandboxBackground["start"]>;
    },
    status: async (h, ref, signal) => {
      checkHandle(h);
      return supervisor.status(ref, signal);
    },
    readOutput: async (h, ref, opts) => {
      checkHandle(h);
      return supervisor.readOutput(ref, opts);
    },
    tail: async (h, ref, opts) => {
      checkHandle(h);
      return supervisor.tail(ref, opts);
    },
    stop: async (h, ref, opts) => {
      checkHandle(h);
      return supervisor.stop(ref, opts);
    },
  });
  backend = {
    permissionSupport: async (h, signal) => {
      checkHandle(h);
      signal.throwIfAborted();
      // a transiently failed proof is retried before it is reported (rate-limited, bounded)
      await host.proof?.refresh();
      const c = await read();
      const restricted = restrictedNow();
      // an operation boundary: the sandbox network (the allowlist, with per-operation hosts) only
      // with restricted support; the open public network is not enforced by these workers yet
      return {
        version: 2,
        boundary: "operation",
        restricted: restricted
          ? { filesystem: true, network: true, native: true, concurrentScopes: true }
          : null,
        network: { openPublic: false, allowlist: restricted, perOperationHosts: restricted },
        outsideSandbox: host.outsideSandbox && c.outsideSandbox,
        background: host.background,
        ...(!restricted
          ? { unavailableReason: host.proof?.failure() ?? host.unavailableReason ?? host.pending }
          : {}),
      };
    },
    operation: operation(),
    background: background(),
    browse: async (h, input, signal) => {
      checkHandle(h);
      signal.throwIfAborted();
      const scope = parseSandboxBrowseScope(input);
      validateScopeDevice(scope);
      const methods = nativeMethods(scope, signal);
      return { stat: methods.stat, list: methods.list, scan: methods.scan };
    },
    prepare: async (h, input, signal) => {
      checkHandle(h);
      signal.throwIfAborted();
      const scope = parseSandboxPreparationScope(input);
      validateScopeDevice(scope);
      const methods = nativeMethods(scope, signal);
      return { readFile: methods.readFile, writeFile: methods.writeFile, stat: methods.stat };
    },
    revokeOperation: async (h, ref, signal) => {
      checkHandle(h);
      return supervisor.revokeOperation(ref, signal);
    },
    lifecycle: {
      beginDrain: () => supervisor.beginDrain(),
      ownership: () => supervisor.ownership(),
      settle: (signal) => supervisor.settle(signal),
      stopOwned: (opts) => supervisor.stopOwned(opts),
      blockersBesidesLiveBackground: (generation) =>
        supervisor.blockersBesidesLiveBackground(generation),
      retirementObligations: (generation) =>
        supervisor.retirementObligations(generation ?? options.instanceGeneration),
      dispose: () => {
        supervisor.close();
        disposed = true;
        stopWatch?.();
        stopWatch = undefined;
      },
    },
    forExecution: (authority) => {
      const fixed = freezeAuthority(authority);
      return { operation: operation(fixed), background: background(fixed) };
    },
    reconcileOwnerCeiling: async (signal) => {
      let ceiling: DeviceOwnerCeiling | undefined;
      try {
        ceiling = await read();
      } catch {}
      await supervisor.reconcile((record) => {
        if (!ceiling) return false;
        try {
          const next =
            "profile" in record.scope
              ? intersectOperation(
                  record.scope,
                  ceiling,
                  record.authority,
                  record.kind === "native",
                )
              : auxiliaryGrant(record.scope, ceiling);
          return grantStillHolds(record.grant, next);
        } catch {
          return false;
        }
      }, signal);
    },
  };
  return backend;
}
