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
} from "@capybara-hq/plugin-sdk";
import type { MacOperationBackend } from "./mac-operation-backend.js";
import type { VerifiedRuntime } from "./runtime-manifest.js";

/** The durable device side of one bound instance generation (`instance-binding.json`). */
export interface StoredBinding {
  version: 1;
  deviceId: string;
  instanceId: string;
  instanceGeneration: string;
  bindingId: string;
  previousGeneration: string | null;
  runtimeIdentity: DeviceRuntimeIdentityV3;
}
export const BINDING_FILE = "instance-binding.json";

/** Trusted construction dependencies; nothing here is decoded from a request. */
export interface InstanceBinderOptions {
  deviceId: string;
  stateDir: string;
  /** Builds (and recovers the journal of) the operation backend for one exact generation. */
  createBackend(instanceGeneration: string): Promise<MacOperationBackend>;
  /** Verifies the installed bytes and environment (`verifyInstalledRuntime`); throws when not. */
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
  const b = JSON.parse(text) as StoredBinding;
  if (
    b?.version !== 1 ||
    b.deviceId !== deviceId ||
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
  const tmp = join(dir, `${BINDING_FILE}.${binding.bindingId}.tmp`);
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
  await rename(tmp, join(dir, BINDING_FILE));
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
 * committed generation and binding id — binds a generation, after verifying the stored previous
 * binding, the installed manifest and that no other generation's work is unsettled. The binding is
 * written durably before that generation's backend is enabled. The same binding is idempotent; the
 * same generation with another binding id is a conflict; nothing else ever binds.
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
   * the process unbound until a binding request arrives.
   */
  async recover(): Promise<BoundInstance | undefined> {
    return this.serial(async () => {
      const stored = await readStored(this.path(), this.options.deviceId);
      if (!stored) return undefined;
      const verified = await this.options.verify();
      if (!sameIdentity(stored.runtimeIdentity, verified)) return undefined;
      return this.enable(stored);
    });
  }

  async bind(request: BindInstanceRequestV3, signal: AbortSignal): Promise<BindInstanceResultV3> {
    return this.serial(async () => {
      signal.throwIfAborted();
      if (request.instanceId !== this.options.deviceId)
        throw new SandboxScopeDeniedError("The binding names another instance");
      const stored = await readStored(this.path(), this.options.deviceId);
      let next: StoredBinding;
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
        next = stored;
      } else {
        if ((stored?.instanceGeneration ?? null) !== request.expectedPreviousGeneration)
          throw new SandboxScopeDeniedError(
            "The binding does not follow this device's previous binding; the kernel must reconcile",
          );
        if (stored && BigInt(request.instanceGeneration) <= BigInt(stored.instanceGeneration))
          throw new SandboxScopeDeniedError("A binding never moves to an older generation");
        // another generation's live or uncertain work blocks the new one; a timestamp clears nothing
        const candidate = await this.options.createBackend(request.instanceGeneration);
        const pending =
          candidate.lifecycle.retirementObligations() +
          (this.bound ? ownedTotal(this.bound.backend) : 0);
        if (pending > 0)
          throw new SandboxPermissionUnsupportedError(
            `Earlier work on this device is not settled (${pending}); stop or retire it before a new instance`,
          );
        const verified = await this.options.verify();
        next = {
          version: 1,
          deviceId: this.options.deviceId,
          instanceId: request.instanceId,
          instanceGeneration: request.instanceGeneration,
          bindingId: request.bindingId,
          previousGeneration: request.expectedPreviousGeneration,
          runtimeIdentity: { ...verified, instanceGeneration: request.instanceGeneration },
        };
        signal.throwIfAborted();
        await writeStored(this.options.stateDir, next);
        this.bound = { binding: next, backend: candidate, handle: { id: this.options.deviceId } };
      }
      const live =
        this.bound?.binding.bindingId === next.bindingId ? this.bound : await this.enable(next);
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

  private async enable(binding: StoredBinding): Promise<BoundInstance> {
    const backend = await this.options.createBackend(binding.instanceGeneration);
    this.bound = { binding, backend, handle: { id: this.options.deviceId } };
    return this.bound;
  }
  private path(): string {
    return join(this.options.stateDir, BINDING_FILE);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
}

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
  readStored(join(stateDir, BINDING_FILE), deviceId);
