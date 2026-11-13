import type {
  ExecResult,
  FileSystemHandle,
  SandboxHandle,
  SandboxLimits,
  SandboxProvider,
  SandboxRoots,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
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
    @Inject(NetworkGrants)
    private readonly grants: Pick<NetworkGrants, "forExec" | "reportedMode">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

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
    // the answer must fit one frame: a larger file comes back truncated (Deliver: too large)
    const maxBytes = Math.min(
      opts.maxBytes,
      maxReadBytes(this.config.get().devices.local.maxFrameBytes),
    );
    const r = await this.relay.call(
      h.id,
      "readFile",
      { path, maxBytes },
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
    return this.relay.call(h.id, "stat", { path }, { deadlineMs: OP_DEADLINE_MS, signal });
  }

  /**
   * The device's org and the limits of one exec now (ruling R27): the effective policy's
   * `allowedMode` and the sandbox-mode allowlist. A deleted device is not found. A machine whose
   * local policy is auto mode while the organization allows only sandbox mode is refused here, at
   * every exec, so a machine switched locally is not used until it is switched back.
   */
  private async currentLimits(deviceId: string): Promise<{ orgId: string; limits: SandboxLimits }> {
    const orgId = await this.targets.orgOf(deviceId);
    if (orgId === null) throw deviceNotFound();
    const [policy, reported] = await Promise.all([
      this.sandbox.devicePolicy({ orgId, deviceId }),
      this.grants.reportedMode(deviceId),
    ]);
    if (policy.allowedMode === "sandbox" && reported === "auto") {
      this.log.warn("command refused on a machine that reports auto mode", { deviceId });
      throw new ApiError("device.auto_mode_not_allowed", AUTO_MODE_NOT_ALLOWED_TEXT);
    }
    return {
      orgId,
      limits: await this.sandbox.deviceLimits({ orgId, deviceId }, { policy }),
    };
  }
}
