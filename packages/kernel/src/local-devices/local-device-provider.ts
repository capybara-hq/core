import type {
  ExecResult,
  FileSystemHandle,
  SandboxHandle,
  SandboxLimits,
  SandboxProvider,
  SandboxRoots,
} from "@capybara-hq/plugin-sdk";
import {
  type BackgroundReadOutputResult,
  type DeviceOperation,
  parseDeviceFrame,
  parseOperationResult,
  parseSandboxBrowseScope,
  parseSandboxOperationScope,
  parseSandboxPreparationScope,
  type SandboxBackground,
  type SandboxBrowse,
  type SandboxOperation,
  type SandboxPermissionSupport,
  SandboxPermissionUnsupportedError,
  type SandboxPreparation,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { projectsUnsupported } from "../devices/errors.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { PermissionCallGrants } from "../sandbox/permission-call-grants.js";
import { deviceNotFound, SandboxService } from "../sandbox/sandbox.service.js";
import { grantsWithin, NetworkGrants, relayer } from "./network-grants.js";
import { deviceOffline, LocalDeviceRelay } from "./relay.js";
import { DeviceTargets, sameRoots } from "./targets.js";

/** Extra time the machine gets beyond a command's own timeout (spawn, output, the trip back). */
export const EXEC_DEADLINE_MARGIN_MS = 5000;
/** How long the machine may take for one non-exec operation. */
export const OP_DEADLINE_MS = 30_000;

/**
 * Room left in a frame for everything around a `readFile` result's base64 data (the `res`
 * envelope): a read is clamped so the machine's answer fits `devices.local.maxFrameBytes`
 * (ruling R26).
 */
export const FRAME_ENVELOPE_BYTES = 64 * 1024;

export { projectsUnsupported } from "../devices/errors.js";

/** The most raw bytes whose base64 plus {@link FRAME_ENVELOPE_BYTES} fit in `maxFrameBytes`. */
export const maxReadBytes = (maxFrameBytes: number): number =>
  Math.max(0, Math.floor((maxFrameBytes - FRAME_ENVELOPE_BYTES) / 4) * 3);

const NAME_PREFIX = "cap-device-";

/**
 * The refusal of a command on a machine whose local policy is auto mode while the organization (or
 * the platform) allows only sandbox mode (auto mode spec §4.3): re-checked at every exec, so a
 * machine switched locally is refused at the next command.
 */
export const AUTO_MODE_NOT_ALLOWED_TEXT =
  "This device's machine runs in auto mode, which your organization does not allow. Run `capybara-device mode sandbox` on that machine to switch it to sandbox mode.";

/**
 * A raw protocol 2 method on the staged provider: refused before anything is queued (a v3
 * machine runs work only under an admitted operation scope; there is no raw fallback).
 */
const refuseRaw =
  (method: string) =>
  async (..._args: unknown[]): Promise<never> => {
    throw new SandboxPermissionUnsupportedError(
      `${method} without an operation scope is not available on a protocol 3 device; run it through an admitted operation scope`,
    );
  };

/** What the staged provider sends through: the relay's protocol 3 call and the attested support. */
export interface StagedDeviceTransport {
  call(
    deviceId: string,
    op: DeviceOperation,
    args: Record<string, unknown>,
    opts: {
      deadlineMs: number;
      signal: AbortSignal;
      connection?: { connectionId: string; maxFrameBytes: number };
    },
  ): Promise<unknown>;
  permissionSupport(deviceId: string, signal: AbortSignal): Promise<SandboxPermissionSupport>;
}

/**
 * The handle of an instance on a machine: the device id (ruling R1: the relay is keyed by
 * device), the roots the machine reported at `create`, and the org's effective limits at
 * creation (for the record: every `exec` carries the org's limits read at that moment, ruling
 * R27, so the machine intersects its local policy with the current egress).
 */
export interface LocalDeviceHandle extends SandboxHandle {
  roots: SandboxRoots;
  limits: SandboxLimits;
}

/** The device id of a `cap-device-<deviceId>` name; undefined for any other name. */
export const deviceIdOfName = (name: string): string | undefined =>
  name.startsWith(NAME_PREFIX) && name.length > NAME_PREFIX.length
    ? name.slice(NAME_PREFIX.length)
    : undefined;

const rootsOf = (h: SandboxHandle): SandboxRoots | undefined =>
  (h as Partial<LocalDeviceHandle>).roots;

const bytesOf = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

/**
 * The kernel-internal provider `@local` (environments spec §13.5): every operation runs on the
 * device's connected machine through the {@link LocalDeviceRelay}. The file system is the
 * machine's device directory (the program creates it on first use), so `createFileSystem`
 * touches nothing; `suspend` and `destroy` do nothing (the machine is not the platform's to stop);
 * deleting the device leaves the files on the machine where they are. Nothing here throws `device.offline` on the cleanup paths (ruling R9).
 *
 * The files on a machine are its owner's: `destroyFileSystem` (a files reset, the deletion sweep)
 * does nothing; the deletion's `stop` comes from `MachinesService.revokeActive` (ruling R24).
 */
@Injectable()
export class LocalDeviceProvider implements SandboxProvider {
  readonly concurrentExec = true as const;
  readonly sessionIsolation = false;

  constructor(
    @Inject(LocalDeviceRelay) private readonly relay: LocalDeviceRelay,
    @Inject(DeviceTargets)
    private readonly targets: Pick<DeviceTargets, "orgOf" | "machineRoots" | "machineFeatures">,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "devicePolicy" | "deviceLimits">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(NetworkGrants)
    private readonly grants: Pick<NetworkGrants, "forExec" | "reportedMode">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Optional() @Inject(PermissionCallGrants) private readonly callGrants?: PermissionCallGrants,
  ) {}

  /**
   * The `@local` provider as the staged (protocol 3) registration hands it out
   * (`LocalDevicesModule`): the protocol 2 lifecycle methods that send no frame (file system,
   * resume, suspend, destroy), the v3 operation adapter ({@link stagedOperations}), `create` as a
   * protocol 3 request, no raw protocol 2 call and no broad kill. Dormant until the protocol gate
   * selects it.
   *
   * The raw methods (`exec`, `readFile`, `writeFile`, `stat`, `list`, `scan`) refuse before
   * anything is queued: a v3 machine runs work only under an admitted operation scope, and
   * missing operation support never falls back to them.
   *
   * A v3 machine has no `killAll` / `killTagged` (permission runtime cutover B-1), so both are
   * no-ops that queue nothing. What reaches the machine instead is only what the kernel revokes
   * exactly (`revokeOperation` per intent): `SandboxService` calls `OperationIntents.revokeHolders`
   * with the crashed holders' tokens before `killTagged` and before `killLeftovers`' `killAll`, and
   * that revokes those holders' admitted, dispatching and started-or-unknown intents only. Not
   * covered today: the `killAll` after a failed limits change on a resumed instance and the one
   * in `quarantine` (unreachable for `@local`) revoke nothing first; `killLeftovers` revokes only
   * the dead tokens, not the started-or-unknown intents of live holders of the instance; and
   * tokens `claimDeadHolders` already deleted are lost when `revokeHolders` then throws. Revoking
   * every started-or-unknown intent of the generation on a v3 resume is W5-P3a's kernel change.
   */
  staged(transport: StagedDeviceTransport): SandboxProvider {
    const ops = this.stagedOperations(transport);
    const overrides: Partial<SandboxProvider> = {
      ...ops,
      create: async (args) => {
        const id = args.fileSystem.id;
        const r = parseOperationResult(
          "create",
          await transport.call(
            id,
            "create",
            { limits: args.limits },
            { deadlineMs: OP_DEADLINE_MS, signal: args.signal },
          ),
        ) as { roots: SandboxRoots };
        return { id, roots: r.roots, limits: args.limits } satisfies LocalDeviceHandle;
      },
      exec: refuseRaw("exec"),
      readFile: refuseRaw("readFile"),
      writeFile: refuseRaw("writeFile"),
      stat: refuseRaw("stat"),
      list: refuseRaw("list"),
      scan: refuseRaw("scan"),
      killAll: async (_h, signal) => {
        signal.throwIfAborted();
      },
      killTagged: async (_h, _tags, signal) => {
        signal.throwIfAborted();
      },
    };
    // the shared lifecycle methods keep this provider as their receiver (relay, targets, config)
    return Object.assign(Object.create(this) as SandboxProvider, overrides);
  }

  /** Dormant v3 adapter. It is not installed on the active v2 registered provider. */
  stagedOperations(
    transport: StagedDeviceTransport,
  ): Required<
    Pick<
      SandboxProvider,
      "operation" | "prepare" | "browse" | "permissionSupport" | "revokeOperation" | "background"
    >
  > {
    const native = (
      h: SandboxHandle,
      scope: unknown,
      prefix: "" | "prepare" | "browse",
      factorySignal: AbortSignal,
    ): Required<SandboxOperation> => {
      const send = async (
        op: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ): Promise<unknown> => {
        const name = (
          prefix ? prefix + op.charAt(0).toUpperCase() + op.slice(1) : op
        ) as DeviceOperation;
        const result = await transport.call(
          h.id,
          name,
          { scope, ...args },
          { deadlineMs: OP_DEADLINE_MS, signal: AbortSignal.any([factorySignal, signal]) },
        );
        return parseOperationResult(name, result);
      };
      return {
        exec: async () => {
          throw new Error("Execution requires its request-bound authority adapter");
        },
        readFile: async (path, opts) => {
          const r = (await send(
            "readFile",
            {
              path,
              maxBytes: Math.min(
                opts.maxBytes,
                maxReadBytes(this.config.get().devices.local.maxFrameBytes),
              ),
            },
            opts.signal,
          )) as { dataB64: string; truncated: boolean } | null;
          return r === null ? null : { data: bytesOf(r.dataB64), truncated: r.truncated };
        },
        writeFile: async (path, data, signal) => {
          await send("writeFile", { path, dataB64: Buffer.from(data).toString("base64") }, signal);
        },
        stat: async (path, signal) =>
          (await send("stat", { path }, signal)) as Awaited<ReturnType<SandboxOperation["stat"]>>,
        list: async (path, opts) =>
          (await send("list", { path, limit: opts.limit }, opts.signal)) as Awaited<
            ReturnType<NonNullable<SandboxOperation["list"]>>
          >,
        scan: async (base, opts) =>
          (await send("scan", { base }, opts.signal)) as Awaited<
            ReturnType<NonNullable<SandboxOperation["scan"]>>
          >,
      };
    };
    const execArgs = async (
      deviceId: string,
      scope: import("@capybara-hq/plugin-sdk").SandboxOperationScope,
      method: "exec" | "backgroundStart",
      input: unknown,
    ) => {
      const orgId = await this.targets.orgOf(deviceId);
      if (orgId === null) throw deviceNotFound();
      const policy = await this.sandbox.devicePolicy({ orgId, deviceId });
      const limits = await this.sandbox.deviceLimits(
        { orgId, deviceId },
        { policy, source: "local" },
      );
      if (!this.callGrants)
        throw new Error(
          "Admitted execution authority is unavailable; check the device operation configuration",
        );
      const original = await this.callGrants.forExecution(
        scope.operationId,
        deviceId,
        method,
        scope,
        input,
      );
      const grants = grantsWithin(original, limits);
      if (original?.hosts.some((host) => !grants?.hosts.includes(host)))
        throw new Error(
          "Current organization limits refuse the admitted explicit hosts; review the operation again",
        );
      return { limits, ...(grants === undefined ? {} : { grants }) };
    };
    const background: SandboxBackground = {
      start: async (h, input, args) => {
        const scope = parseSandboxOperationScope(input);
        const { signal, ...rest } = args;
        const authority = await execArgs(h.id, scope, "backgroundStart", rest);
        signal.throwIfAborted();
        return parseOperationResult(
          "backgroundStart",
          await transport.call(
            h.id,
            "backgroundStart",
            { scope, ...rest, ...authority },
            { deadlineMs: args.timeoutMs + EXEC_DEADLINE_MARGIN_MS, signal },
          ),
        ) as Awaited<ReturnType<SandboxBackground["start"]>>;
      },
      status: async (h, ref, signal) =>
        parseOperationResult(
          "backgroundStatus",
          await transport.call(
            h.id,
            "backgroundStatus",
            { ref },
            { deadlineMs: OP_DEADLINE_MS, signal },
          ),
        ) as Awaited<ReturnType<SandboxBackground["status"]>>,
      readOutput: async (h, ref, opts) => {
        opts.signal.throwIfAborted();
        parseDeviceFrame(
          JSON.stringify({
            type: "req",
            id: "validate",
            op: "backgroundReadOutput",
            args: { ref, offset: opts.offset, maxBytes: opts.maxBytes },
            deadlineMs: OP_DEADLINE_MS,
          }),
          "kernel",
        );
        // liveness first (R27): a deleted or revoked device keeps its typed error
        const connection = await this.relay.connection(h.id);
        const capacity = Math.min(65536, maxReadBytes(connection.maxFrameBytes));
        const request = { ref, offset: opts.offset, maxBytes: Math.min(opts.maxBytes, capacity) };
        const result = parseOperationResult(
          "backgroundReadOutput",
          await transport.call(h.id, "backgroundReadOutput", request, {
            deadlineMs: OP_DEADLINE_MS,
            signal: opts.signal,
            connection,
          }),
          request,
        ) as BackgroundReadOutputResult;
        if ("unavailable" in result) return result;
        // A zero-capacity probe can establish EOF, but never reports unread bytes as EOF.
        if (opts.maxBytes > 0 && capacity === 0 && result.totalBytes > opts.offset)
          throw new Error(
            "Managed output cannot fit the negotiated transport capacity; increase device and deployment frame limits and retry the same offset",
          );
        return {
          data: bytesOf(result.dataB64),
          offset: result.offset,
          nextOffset: result.nextOffset,
          totalBytes: result.totalBytes,
        };
      },
      tail: async (h, ref, opts) => {
        const r = parseOperationResult(
          "backgroundTail",
          await transport.call(
            h.id,
            "backgroundTail",
            { ref, maxBytes: opts.maxBytes },
            { deadlineMs: OP_DEADLINE_MS, signal: opts.signal },
          ),
        ) as { dataB64: string; truncated: boolean } | { unavailable: "lost" | "expired" };
        return "unavailable" in r ? r : { data: bytesOf(r.dataB64), truncated: r.truncated };
      },
      stop: async (h, ref, opts) =>
        parseOperationResult(
          "backgroundStop",
          await transport.call(
            h.id,
            "backgroundStop",
            { ref, graceMs: opts.graceMs },
            { deadlineMs: OP_DEADLINE_MS, signal: opts.signal },
          ),
        ) as Awaited<ReturnType<SandboxBackground["stop"]>>,
    };
    return {
      permissionSupport: (h, signal) => transport.permissionSupport(h.id, signal),
      operation: async (h, input, signal) => {
        const scope = parseSandboxOperationScope(input);
        const methods = native(h, scope, "", signal);
        return {
          ...methods,
          exec: async (args) => {
            const { signal: callSignal, ...rest } = args;
            const authority = await execArgs(h.id, scope, "exec", rest);
            const combined = AbortSignal.any([signal, callSignal]);
            combined.throwIfAborted();
            return parseOperationResult(
              "exec",
              await transport.call(
                h.id,
                "exec",
                { scope, ...rest, ...authority },
                { deadlineMs: args.timeoutMs + EXEC_DEADLINE_MARGIN_MS, signal: combined },
              ),
            ) as ExecResult;
          },
        };
      },
      prepare: async (h, input, signal) => {
        const n = native(h, parseSandboxPreparationScope(input), "prepare", signal);
        return {
          readFile: n.readFile,
          writeFile: n.writeFile,
          stat: n.stat,
        } satisfies SandboxPreparation;
      },
      browse: async (h, input, signal) => {
        const n = native(h, parseSandboxBrowseScope(input), "browse", signal);
        return { stat: n.stat, list: n.list, scan: n.scan } satisfies SandboxBrowse;
      },
      revokeOperation: async (h, ref, signal) => {
        await transport.call(
          h.id,
          "revokeOperation",
          { ref },
          { deadlineMs: OP_DEADLINE_MS, signal },
        );
      },
      background,
    };
  }

  async createFileSystem(args: {
    name: string;
    limits: SandboxLimits;
    signal: AbortSignal;
  }): Promise<FileSystemHandle> {
    args.signal.throwIfAborted();
    const id = deviceIdOfName(args.name);
    if (id === undefined) throw new Error(`not a device name: ${args.name}`);
    return { id };
  }

  /** The files are the machine owner's: nothing to do (ruling R24; never a `stop`). */
  async destroyFileSystem(_fs: FileSystemHandle, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
  }

  async destroyFileSystemByName(_name: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
  }

  async create(args: {
    name: string;
    image?: string;
    limits: SandboxLimits;
    fileSystem: FileSystemHandle;
    signal: AbortSignal;
  }): Promise<LocalDeviceHandle> {
    const id = args.fileSystem.id;
    const r = await this.relay.call(
      id,
      "create",
      { limits: args.limits },
      { deadlineMs: OP_DEADLINE_MS, signal: args.signal },
    );
    return { id, roots: r.roots, limits: args.limits };
  }

  /**
   * Needs the machine online. `gone` (the kernel recreates the instance) when the active machine
   * last reported other roots than the instance was created with (a new login into another
   * directory or mode, ruling R23).
   */
  async resume(h: SandboxHandle, signal: AbortSignal): Promise<"resumed" | "gone"> {
    signal.throwIfAborted();
    if (!(await this.relay.holderLive(h.id))) throw deviceOffline();
    const had = rootsOf(h);
    const now = await this.targets.machineRoots(h.id);
    if (had === undefined || (now !== null && !sameRoots(had, now))) return "gone";
    return "resumed";
  }

  async suspend(_h: SandboxHandle, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
  }

  async destroy(_h: SandboxHandle, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
  }

  async destroyByName(_name: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
  }

  async killAll(h: SandboxHandle, signal: AbortSignal): Promise<void> {
    await this.relay.call(h.id, "killAll", {}, { deadlineMs: OP_DEADLINE_MS, signal });
  }

  async killTagged(h: SandboxHandle, tags: string[], signal: AbortSignal): Promise<void> {
    await this.relay.call(h.id, "killTagged", { tags }, { deadlineMs: OP_DEADLINE_MS, signal });
  }

  /**
   * Runs the command on the machine with the org's limits now (ruling R27) and, for a command of a
   * run, the hosts the kernel allows that run on this device beyond the local policy (network
   * ask-to-allow spec §6.3; only those the org's limits admit, sent only when there are some). The
   * device's report of refused hosts is re-layered against the limits this exec carried: the
   * kernel never takes the device's word that the org allows a host (auto mode spec §4.2).
   *
   * The exec args carry `mode: allowedMode` (the machine cuts its own choice to it), the
   * sandbox-mode allowlist and the run's grants. A machine whose local policy is auto mode while
   * the organization allows only sandbox mode is refused at every exec
   * (`device.auto_mode_not_allowed`), before anything is relayed to it.
   */
  async exec(h: SandboxHandle, args: Parameters<SandboxProvider["exec"]>[1]): Promise<ExecResult> {
    const { signal, ...rest } = args;
    signal.throwIfAborted();
    const runId = rest.actor?.runId;
    const { orgId, limits } = await this.currentLimits(h.id);
    // the run's grants for this device, cut to what the org allows now
    const grants =
      runId !== undefined
        ? grantsWithin(await this.grants.forExec({ orgId, runId, deviceId: h.id }), limits)
        : undefined;
    signal.throwIfAborted();
    let result: ExecResult;
    try {
      result = await this.relay.call(
        h.id,
        "exec",
        { ...rest, limits, ...(grants !== undefined && { grants }) },
        { deadlineMs: args.timeoutMs + EXEC_DEADLINE_MARGIN_MS, signal },
      );
    } catch (e) {
      // the contract: an exec aborted after it was sent resolves with exitCode null (the relay
      // queued a cancel, which kills the command on the machine); the output stays there
      if (signal.aborted && e === signal.reason) {
        return { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: false };
      }
      throw e;
    }
    if (result.network?.blocked === undefined) return result;
    return { ...result, network: { blocked: relayer(result.network.blocked, limits) } };
  }

  async readFile(
    h: SandboxHandle,
    path: string,
    opts: { maxBytes: number; signal: AbortSignal },
  ): Promise<{ data: Uint8Array; truncated: boolean } | null> {
    const { limits } = await this.currentLimits(h.id);
    // the answer must fit one frame: a larger file comes back truncated (Deliver: too large)
    const maxBytes = Math.min(
      opts.maxBytes,
      maxReadBytes(this.config.get().devices.local.maxFrameBytes),
    );
    const r = await this.relay.call(
      h.id,
      "readFile",
      { path, maxBytes, limits: { mode: limits.mode } },
      { deadlineMs: OP_DEADLINE_MS, signal: opts.signal },
    );
    return r === null ? null : { data: bytesOf(r.dataB64), truncated: r.truncated };
  }

  async writeFile(
    h: SandboxHandle,
    path: string,
    data: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const dataB64 = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
    await this.relay.call(
      h.id,
      "writeFile",
      { path, dataB64 },
      { deadlineMs: OP_DEADLINE_MS, signal },
    );
  }

  async stat(
    h: SandboxHandle,
    path: string,
    signal: AbortSignal,
  ): Promise<{ size: number; isDir: boolean } | null> {
    const { limits } = await this.currentLimits(h.id);
    return this.relay.call(
      h.id,
      "stat",
      { path, limits: { mode: limits.mode } },
      { deadlineMs: OP_DEADLINE_MS, signal },
    );
  }

  /**
   * Lists one directory on the machine (the `list` op, project root §4.1), read in the mode the
   * kernel's current ceiling gives. A machine that did not announce `projects` throws
   * `device.projects_unsupported` (never null, which would read as "does not exist").
   */
  async list(
    h: SandboxHandle,
    path: string,
    opts: { limit: number; limits: Pick<SandboxLimits, "mode">; signal: AbortSignal },
  ): Promise<{ entries: { name: string; isDir: boolean }[]; truncated: boolean } | null> {
    await this.requireProjects(h.id);
    opts.signal.throwIfAborted();
    return this.relay.call(
      h.id,
      "list",
      { path, limit: opts.limit, limits: { mode: opts.limits.mode } },
      { deadlineMs: OP_DEADLINE_MS, signal: opts.signal },
    );
  }

  /**
   * Looks for project-like directories under `base` on the machine (the `scan` op, project root
   * §4.1), read in the mode the kernel's current ceiling gives. A machine that did not announce
   * `projects` throws `device.projects_unsupported`.
   */
  async scan(
    h: SandboxHandle,
    base: string,
    opts: { limits: Pick<SandboxLimits, "mode">; signal: AbortSignal },
  ): Promise<{ path: string; suggestedName: string }[]> {
    await this.requireProjects(h.id);
    opts.signal.throwIfAborted();
    return this.relay.call(
      h.id,
      "scan",
      { base, limits: { mode: opts.limits.mode } },
      { deadlineMs: OP_DEADLINE_MS, signal: opts.signal },
    );
  }

  /** The kernel never sends `list` or `scan` to a machine that did not announce `projects`. */
  private async requireProjects(deviceId: string): Promise<void> {
    if (!(await this.targets.machineFeatures(deviceId)).includes("projects")) {
      throw projectsUnsupported(true);
    }
  }

  /**
   * The device's org and current limits for an exec or file read (ruling R27): the effective policy's
   * `allowedMode` and the sandbox-mode allowlist. A deleted device is not found. A machine whose
   * local policy is auto mode while the organization allows only sandbox mode is refused here, at
   * every such operation, so a machine switched locally is not used until it is switched back.
   */
  private async currentLimits(deviceId: string): Promise<{ orgId: string; limits: SandboxLimits }> {
    const orgId = await this.targets.orgOf(deviceId);
    if (orgId === null) throw deviceNotFound();
    const [policy, reported] = await Promise.all([
      this.sandbox.devicePolicy({ orgId, deviceId }),
      this.grants.reportedMode(deviceId),
    ]);
    if (policy.allowedMode === "sandbox" && reported === "auto") {
      this.log.warn("device operation refused on a machine that reports auto mode", { deviceId });
      throw new ApiError("device.auto_mode_not_allowed", AUTO_MODE_NOT_ALLOWED_TEXT);
    }
    return {
      orgId,
      limits: await this.sandbox.deviceLimits({ orgId, deviceId }, { policy, source: "local" }),
    };
  }
}
