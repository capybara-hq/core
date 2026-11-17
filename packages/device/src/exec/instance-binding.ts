import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  type BindInstanceRequestV3,
  type BindInstanceResultV3,
  type DeviceOwnerCeilingV3,
  type DeviceRuntimeIdentityV3,
  type SandboxHandle,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
  type SandboxStopResult,
} from "@capybara-hq/plugin-sdk";
import type { MacOperationBackend } from "./mac-operation-backend.js";
import type { VerifiedRuntime } from "./runtime-manifest.js";

/** The durable device side of one bound instance generation, one file per device. */
export interface StoredBinding {
  version: 1;
  deviceId: string;
  /** Which machine credential bound it: another credential's binding is no previous of ours. */
  credentialIdentity: string;
  instanceId: string;
  instanceGeneration: string;
  bindingId: string;
  previousGeneration: string | null;
  runtimeIdentity: DeviceRuntimeIdentityV3;
}
/** Keyed by device like the operation journal, so another device id in the same directory is apart. */
export const bindingFile = (stateDir: string, deviceId: string) =>
  join(
    stateDir,
    `instance-binding-${createHash("sha256").update(JSON.stringify(deviceId)).digest("hex")}.json`,
  );
/** The identity of a machine credential as stored with a binding (never the secret itself). */
export const credentialIdentity = (credential: string) =>
  createHash("sha256").update(`capybara-device-credential:${credential}`).digest("hex");

/** Trusted construction dependencies; nothing here is decoded from a request. */
export interface InstanceBinderOptions {
  deviceId: string;
  /** {@link credentialIdentity} of the machine credential this process runs with. */
  credentialIdentity: string;
  stateDir: string;
  /**
   * Builds (and recovers the journal of) the operation backend for one exact generation, after
   * {@link verify} succeeded in this process: restricted launches run only the sealed runtime with
   * the binding's attested `runtimeIdentity.runtimeHash`.
   */
  createBackend(instanceGeneration: string, binding: StoredBinding): Promise<MacOperationBackend>;
  /**
   * Verifies the installed bytes and environment (`verifyInstalledRuntime`, staging the sealed
   * runtime closure in the private state directory); throws when not.
   */
  verify(): Promise<VerifiedRuntime>;
  /** The strict current owner report (B2 supplies its sequence sidecar). */
  ownerReport(): Promise<DeviceOwnerCeilingV3>;
}
export interface BoundInstance {
  binding: StoredBinding;
  backend: MacOperationBackend;
  handle: SandboxHandle;
}

async function readStored(path: string, deviceId: string): Promise<StoredBinding | undefined> {
  let text: string;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new Error("not a regular file");
      text = await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SandboxScopeDeniedError(
      `The instance binding cannot be read (${(e as Error).message}); repair the device state`,
    );
  }
  let b: StoredBinding;
  try {
    b = JSON.parse(text) as StoredBinding;
  } catch {
    throw new SandboxScopeDeniedError(
      "The stored instance binding is not valid JSON; repair the device state",
    );
  }
  if (
    b?.version !== 1 ||
    b.deviceId !== deviceId ||
    typeof b.credentialIdentity !== "string" ||
    typeof b.instanceGeneration !== "string" ||
    typeof b.bindingId !== "string" ||
    b.runtimeIdentity?.instanceGeneration !== b.instanceGeneration
  )
    throw new SandboxScopeDeniedError(
      "The stored instance binding is invalid; repair the device state",
    );
  return b;
}

/** Write-then-rename with fsync of the file and its directory: durable before it is used. */
async function writeStored(dir: string, binding: StoredBinding): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = bindingFile(dir, binding.deviceId);
  const tmp = `${target}.${binding.bindingId}.tmp`;
  const file = await open(
    tmp,
    constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(binding));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, target);
  const d = await open(dir, constants.O_RDONLY);
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}

/**
 * The device half of the post-commit binding (permission runtime cutover B4; staged v3, protocol
 * 2 stays active). A process starts unbound unless it recovers a durable binding for its exact
 * generation; only {@link bind} — the authenticated `bindInstance` request carrying the kernel's
 * committed generation and binding id — binds a generation.
 *
 * One supervisor per journal: the journal is per device, so a new generation's backend is built
 * only after the old one stopped admitting (drain), everything it owned settled, no older
 * generation's work is unsettled (checked again after the last await), the binding was written
 * durably, and the old supervisor was disposed so it can never write again.
 *
 * The chain rule, shared with the kernel (which names as previous the last binding it committed
 * for this machine credential, delivered or not): a stored binding of this credential must not be
 * newer than the kernel's previous; another credential's binding is no previous. Generations only
 * move forward. The same binding is idempotent; the same generation under another id conflicts.
 */
export class InstanceBinder {
  private bound: BoundInstance | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: InstanceBinderOptions) {}

  /** The bound generation's backend, or undefined (unbound: no user operation is admitted). */
  current(): BoundInstance | undefined {
    return this.bound;
  }

  /**
   * After a process restart: recover the persisted binding for same-generation journal and spool
   * recovery (never reattaching processes). Its runtime is verified again; a changed one leaves
   * the process unbound until a binding request arrives. Never builds a second supervisor.
   */
  async recover(): Promise<BoundInstance | undefined> {
    return this.serial(async () => {
      const stored = await this.stored();
      if (this.bound)
        return stored && this.bound.binding.bindingId === stored.bindingId ? this.bound : undefined;
      if (!stored || stored.credentialIdentity !== this.options.credentialIdentity)
        return undefined;
      const verified = await this.options.verify();
      if (!sameIdentity(stored.runtimeIdentity, verified)) return undefined;
      return this.enable(stored);
    });
  }

  /**
   * A new instance is being created for this device (`create`): the bound generation is about to
   * become an older one, so its background tasks are exact-stopped by their refs (W3-M). Foreground
   * work and uncertain work of earlier processes are left to the retirement rules of {@link bind}.
   */
  async dropOlderGenerations(signal: AbortSignal): Promise<SandboxStopResult[]> {
    return this.serial(async () => {
      signal.throwIfAborted();
      return (await this.bound?.backend.lifecycle.stopOwned(dropOptions(signal))) ?? [];
    });
  }

  async bind(request: BindInstanceRequestV3, signal: AbortSignal): Promise<BindInstanceResultV3> {
    return this.serial(async () => {
      signal.throwIfAborted();
      if (request.instanceId !== this.options.deviceId)
        throw new SandboxScopeDeniedError("The binding names another instance");
      const stored = await this.stored();
      let live: BoundInstance;
      if (stored?.instanceGeneration === request.instanceGeneration) {
        if (stored.bindingId !== request.bindingId)
          throw new SandboxScopeDeniedError(
            "This generation is already bound under another binding id; the kernel must reconcile",
          );
        // an identical retry: the same journal and spools; re-verified, never a new identity
        const verified = await this.options.verify();
        if (!sameIdentity(stored.runtimeIdentity, verified))
          throw new SandboxPermissionUnsupportedError(
            "The installed runtime changed since this generation was bound; a new instance is required",
          );
        live =
          this.bound?.binding.bindingId === stored.bindingId
            ? this.bound
            : await this.switchTo(stored, stored);
      } else {
        if (stored && BigInt(request.instanceGeneration) <= BigInt(stored.instanceGeneration))
          throw new SandboxScopeDeniedError("A binding never moves to an older generation");
        const previous =
          stored?.credentialIdentity === this.options.credentialIdentity
            ? stored.instanceGeneration
            : null;
        if (
          previous !== null &&
          (request.expectedPreviousGeneration === null ||
            BigInt(previous) > BigInt(request.expectedPreviousGeneration))
        )
          throw new SandboxScopeDeniedError(
            "The binding does not follow this device's previous binding; the kernel must reconcile",
          );
        // the old generation admits nothing new from here on, whatever the outcome
        this.bound?.backend.lifecycle.beginDrain();
        const verified = await this.options.verify();
        signal.throwIfAborted();
        live = await this.switchTo(
          {
            version: 1,
            deviceId: this.options.deviceId,
            credentialIdentity: this.options.credentialIdentity,
            instanceId: request.instanceId,
            instanceGeneration: request.instanceGeneration,
            bindingId: request.bindingId,
            previousGeneration: request.expectedPreviousGeneration,
            runtimeIdentity: { ...verified, instanceGeneration: request.instanceGeneration },
          },
          stored,
        );
      }
      const next = live.binding;
      return {
        instanceId: next.instanceId,
        instanceGeneration: next.instanceGeneration,
        bindingId: next.bindingId,
        runtimeIdentity: next.runtimeIdentity,
        permissionSupport: await live.backend.permissionSupport(live.handle, signal),
        ownerCeiling: await this.options.ownerReport(),
      };
    });
  }

  /**
   * Makes `next` the bound generation with exactly one supervisor on the journal. With a live old
   * backend: it must own nothing and leave no unsettled work of other generations, before the
   * durable write and again after it (the last await); then it is disposed and the successor is
   * built from the journal on disk. Without one: the successor itself reads the journal, and is
   * disposed again when it refuses.
   */
  private async switchTo(
    next: StoredBinding,
    previous: StoredBinding | undefined,
  ): Promise<BoundInstance> {
    const old = this.bound;
    const unsettled = (backend: MacOperationBackend) =>
      ownedTotal(backend) + backend.lifecycle.retirementObligations(next.instanceGeneration);
    const refuse = (pending: number) =>
      new SandboxPermissionUnsupportedError(
        `Earlier work on this device is not settled (${pending}); stop or retire it before a new instance`,
      );
    if (old) {
      old.backend.lifecycle.beginDrain();
      if (old.binding.instanceGeneration !== next.instanceGeneration)
        // the older generation's background tasks are dropped (exact-stopped by their refs);
        // running foreground work and uncertain work still block below
        await old.backend.lifecycle.stopOwned(dropOptions(new AbortController().signal));
      let pending = unsettled(old.backend);
      if (pending > 0) throw refuse(pending);
      if (previous !== next) await writeStored(this.options.stateDir, next);
      pending = unsettled(old.backend);
      if (pending > 0) {
        if (previous && previous !== next) await writeStored(this.options.stateDir, previous);
        throw refuse(pending);
      }
      old.backend.lifecycle.dispose();
      this.bound = undefined;
      return this.enable(next);
    }
    const candidate = await this.options.createBackend(next.instanceGeneration, next);
    const pending = unsettled(candidate);
    if (pending > 0) {
      candidate.lifecycle.dispose();
      throw refuse(pending);
    }
    try {
      if (previous !== next) await writeStored(this.options.stateDir, next);
    } catch (e) {
      candidate.lifecycle.dispose();
      throw e;
    }
    this.bound = { binding: next, backend: candidate, handle: { id: this.options.deviceId } };
    return this.bound;
  }

  private async enable(binding: StoredBinding): Promise<BoundInstance> {
    if (this.bound) throw new Error("A supervisor already owns this device's journal");
    const backend = await this.options.createBackend(binding.instanceGeneration, binding);
    this.bound = { binding, backend, handle: { id: this.options.deviceId } };
    return this.bound;
  }
  private stored(): Promise<StoredBinding | undefined> {
    return readStored(
      bindingFile(this.options.stateDir, this.options.deviceId),
      this.options.deviceId,
    );
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
}

/** How long a dropped background task gets to end after its stop signal. */
export const DROP_GRACE_MS = 2000;
const dropOptions = (signal: AbortSignal) => ({
  backgroundOnly: true,
  graceMs: DROP_GRACE_MS,
  signal,
});

const sameIdentity = (a: DeviceRuntimeIdentityV3, b: VerifiedRuntime) =>
  a.runtimeHash === b.runtimeHash &&
  a.helperHash === b.helperHash &&
  a.imageFingerprint === b.imageFingerprint;
const ownedTotal = (backend: MacOperationBackend) => {
  const o = backend.lifecycle.ownership();
  return o.workers + o.cancellations + o.collectors + o.persistence;
};

/** Reads the stored binding without enabling anything (the bound hello's generation). */
export const readInstanceBinding = (stateDir: string, deviceId: string) =>
  readStored(bindingFile(stateDir, deviceId), deviceId);
