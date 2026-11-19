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
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { providerLimits } from "../sandbox/modes.js";
import { PermissionCallGrants } from "../sandbox/permission-call-grants.js";
import { deviceNotFound, SandboxService } from "../sandbox/sandbox.service.js";
import { grantsWithin, relayer } from "./network-grants.js";
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
 * A raw protocol 2 method: refused before anything is queued (a v3 machine runs work only under
 * an admitted operation scope; there is no raw fallback).
 */
const refuseRaw =
  (method: string) =>
  async (..._args: unknown[]): Promise<never> => {
    throw new SandboxPermissionUnsupportedError(
      `${method} without an operation scope is not available on a protocol 4 device; run it through an admitted operation scope`,
    );
  };

/** What the staged provider sends through: the relay's protocol 4 call and the attested support. */
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
    private readonly targets: Pick<DeviceTargets, "orgOf" | "machineRoots">,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "devicePolicy" | "deviceLimits">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Optional() @Inject(PermissionCallGrants) private readonly callGrants?: PermissionCallGrants,
  ) {}

  /**
   * The `@local` provider as the staged (protocol 4) registration hands it out
   * (`LocalDevicesModule`): the protocol 2 lifecycle methods that send no frame (file system,
   * resume, suspend, destroy), the v3 operation adapter ({@link stagedOperations}), `create` as a
   * protocol 4 request, no raw protocol 2 call and no broad kill. Dormant until the protocol gate
   * selects it.
   *
   * The raw methods (`exec`, `readFile`, `writeFile`, `stat`, `list`, `scan`) refuse before
   * anything is queued: a v3 machine runs work only under an admitted operation scope, and
   * missing operation support never falls back to them.
   *
   * A v3 machine has no `killAll` / `killTagged` (permission runtime cutover B-1), so both are
   * no-ops that queue nothing; the kernel never calls them anyway. What reaches the machine is
   * only what the kernel revokes exactly (`revokeOperation` per intent): `SandboxService` owes a
   * crashed holder's revocation in an outbox row before it forgets the holder record, revokes that
   * holder's admitted, dispatching and started-or-unknown intents, and, under the exclusive lease
   * on an incarnation nobody else holds (a resume, a failed limits change, a quarantine), every
   * started-or-unknown intent of that generation; the owed revokes are delivered by operation id.
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
      // the wire carries resources and the outer network only: the mode tier is kernel-internal
      return { limits: providerLimits(limits), ...(grants === undefined ? {} : { grants }) };
    };
    const background: SandboxBackground = {
      start: async (h, input, args) => {
        const scope = parseSandboxOperationScope(input);
        // the device knows its bound generation: a kernel generation never goes on the wire
        const { signal, instanceGeneration: _generation, ...rest } = args;
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
            const result = parseOperationResult(
              "exec",
              await transport.call(
                h.id,
                "exec",
                { scope, ...rest, ...authority },
                { deadlineMs: args.timeoutMs + EXEC_DEADLINE_MARGIN_MS, signal: combined },
              ),
            ) as ExecResult;
            // the kernel's own layer for the machine's report, as on protocol 2: a host the org
            // does not allow is `org` (only an admin can lift it), never a question to the owner
            if (result.network?.blocked === undefined) return result;
            return {
              ...result,
              network: { blocked: relayer(result.network.blocked, authority.limits) },
            };
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

  /** A v3 machine has no broad kill (permission runtime cutover B-1): nothing is queued. */
  async killAll(_h: SandboxHandle, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
  }

  async killTagged(_h: SandboxHandle, _tags: string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
  }

  // The raw protocol 2 methods: a v3 machine runs work only under an admitted operation scope
  readonly exec: SandboxProvider["exec"] = refuseRaw("exec");
  readonly readFile: SandboxProvider["readFile"] = refuseRaw("readFile");
  readonly writeFile: SandboxProvider["writeFile"] = refuseRaw("writeFile");
  readonly stat: SandboxProvider["stat"] = refuseRaw("stat");
  readonly list: NonNullable<SandboxProvider["list"]> = refuseRaw("list");
  readonly scan: NonNullable<SandboxProvider["scan"]> = refuseRaw("scan");
}
