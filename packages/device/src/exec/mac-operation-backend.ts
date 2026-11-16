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
import type { NativeHelperRequest, NativeHelperResult } from "./native-helper-client.js";
import { MacOperationSupervisor } from "./operation-supervisor.js";
import {
  checkRoots,
  type DeviceOwnerCeiling,
  digest,
  freezeAuthority,
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
};
/** Trusted construction dependencies; never decoded from a command, scope or wire message. */
export interface MacBackendDependencies {
  platform?: NodeJS.Platform;
  startWorker?: (request: MacWorkerRequest, signal: AbortSignal) => Promise<MacWorkerHandle>;
  restrictedSupported?: boolean;
  now?: () => number;
  watch?: (tick: () => Promise<void>) => () => void;
}
const PENDING =
  "Restricted macOS per-instance validation and coordinated policy/background activation are pending";
export async function createMacOperationBackend(
  options: MacOperationBackendOptions,
  dependencies: MacBackendDependencies = {},
): Promise<MacOperationBackend> {
  const platform = dependencies.platform ?? process.platform;
  const restricted =
    platform === "darwin" &&
    dependencies.restrictedSupported === true &&
    dependencies.startWorker !== undefined;
  const checkHandle = (h: SandboxHandle) => {
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
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.startWorker ? { start: dependencies.startWorker } : {}),
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
    if (!grant.full && !restricted) throw new SandboxPermissionUnsupportedError(PENDING);
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
    if (background) boundedPath(background.outputPath, grant, true);
    const common = {
      scope,
      grant,
      stateDir: options.stateDir,
      pythonPath: options.pythonPath,
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
      const c = await read();
      return {
        version: 1,
        restricted: restricted
          ? { filesystem: true, network: true, native: true, concurrentScopes: true }
          : null,
        fullAccess: platform === "darwin" && c.fullAccess,
        background: platform === "darwin",
        ...(!restricted
          ? {
              unavailableReason:
                platform === "darwin"
                  ? PENDING
                  : "Restricted Linux/local-Docker validation remains pending",
            }
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
          return record.grant.full
            ? next.full
            : record.grant.hosts.every((h) => next.hosts.includes(h)) &&
                record.grant.deniedReadRoots.every((r) => next.deniedReadRoots.includes(r)) &&
                next.deniedReadRoots.every((r) => record.grant.deniedReadRoots.includes(r));
        } catch {
          return false;
        }
      }, signal);
    },
  };
  return backend;
}
