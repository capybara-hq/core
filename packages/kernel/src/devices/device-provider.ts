import {
  type ExecResult,
  type FileSystemHandle,
  SandboxGoneError,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxProvider,
  type SandboxRoots,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { DeviceRelay, environmentOffline } from "./relay.js";

/** Extra time the machine gets beyond a command's own timeout (spawn, output, the trip back). */
export const EXEC_DEADLINE_MARGIN_MS = 5000;
/** How long the machine may take for one non-exec operation. */
export const OP_DEADLINE_MS = 30_000;

const NAME_PREFIX = "cap-env-";

/**
 * The handle of an instance on a machine: the environment id (ruling R1: the relay is keyed by
 * environment), the roots the machine reported at `create`, and the org's effective limits at
 * creation (sent with every `exec`, so the machine can intersect egress with its local policy;
 * limits apply at creation only, as for cloud providers).
 */
export interface DeviceSandboxHandle extends SandboxHandle {
  roots: SandboxRoots;
  limits: SandboxLimits;
}

/** The environment id of a `cap-env-<environmentId>` name; undefined for any other name. */
export const environmentIdOfName = (name: string): string | undefined =>
  name.startsWith(NAME_PREFIX) && name.length > NAME_PREFIX.length
    ? name.slice(NAME_PREFIX.length)
    : undefined;

const limitsOf = (h: SandboxHandle): SandboxLimits => {
  const limits = (h as Partial<DeviceSandboxHandle>).limits;
  // a handle without limits cannot run commands: let the kernel recreate the instance
  if (limits === undefined) throw new SandboxGoneError("the instance handle carries no limits");
  return limits;
};

const bytesOf = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

/**
 * The kernel-internal provider `@device` (environments spec §13.5): every operation runs on the
 * environment's connected machine through the {@link DeviceRelay}. The file system is the
 * machine's environment directory (the program creates it on first use), so `createFileSystem`
 * touches nothing; `suspend` and `destroy` do nothing (the machine is not the platform's to stop);
 * deleting the environment tells a connected machine to stop and leaves its files where they are.
 * Nothing here throws `environment.offline` on the cleanup paths (ruling R9).
 */
@Injectable()
export class DeviceSandboxProvider implements SandboxProvider {
  readonly concurrentExec = true as const;
  readonly sessionIsolation = false;

  constructor(
    @Inject(DeviceRelay) private readonly relay: DeviceRelay,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  async createFileSystem(args: {
    name: string;
    limits: SandboxLimits;
    signal: AbortSignal;
  }): Promise<FileSystemHandle> {
    args.signal.throwIfAborted();
    const id = environmentIdOfName(args.name);
    if (id === undefined) throw new Error(`not an environment name: ${args.name}`);
    return { id };
  }

  async destroyFileSystem(fs: FileSystemHandle, signal: AbortSignal): Promise<void> {
    await this.stop(fs.id, signal);
  }

  async destroyFileSystemByName(name: string, signal: AbortSignal): Promise<void> {
    const id = environmentIdOfName(name);
    if (id !== undefined) await this.stop(id, signal);
    else signal.throwIfAborted();
  }

  async create(args: {
    name: string;
    image?: string;
    limits: SandboxLimits;
    fileSystem: FileSystemHandle;
    signal: AbortSignal;
  }): Promise<DeviceSandboxHandle> {
    const id = args.fileSystem.id;
    const r = await this.relay.call(
      id,
      "create",
      { limits: args.limits },
      { deadlineMs: OP_DEADLINE_MS, signal: args.signal },
    );
    return { id, roots: r.roots, limits: args.limits };
  }

  async resume(h: SandboxHandle, signal: AbortSignal): Promise<"resumed" | "gone"> {
    signal.throwIfAborted();
    if (!(await this.relay.holderLive(h.id))) throw environmentOffline();
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

  async exec(h: SandboxHandle, args: Parameters<SandboxProvider["exec"]>[1]): Promise<ExecResult> {
    const { signal, ...rest } = args;
    signal.throwIfAborted();
    const limits = limitsOf(h);
    try {
      return await this.relay.call(
        h.id,
        "exec",
        { ...rest, limits },
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
  }

  async readFile(
    h: SandboxHandle,
    path: string,
    opts: { maxBytes: number; signal: AbortSignal },
  ): Promise<{ data: Uint8Array; truncated: boolean } | null> {
    const r = await this.relay.call(
      h.id,
      "readFile",
      { path, maxBytes: opts.maxBytes },
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
   * Tells a connected machine its environment was deleted (it stops serving it; its files stay).
   * Fire-and-forget (ruling R14): queued only while a replica holds the machine, never awaited;
   * any failure is logged and swallowed, so deletion always goes through.
   */
  private async stop(environmentId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      if (!(await this.relay.holderLive(environmentId))) return;
      await this.relay.send(environmentId, "stop", { reason: "deleted" }, OP_DEADLINE_MS);
    } catch (e) {
      this.log.warn("could not tell the connected machine its environment was deleted", {
        environmentId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
