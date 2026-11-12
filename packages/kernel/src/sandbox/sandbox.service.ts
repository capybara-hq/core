import { randomUUID } from "node:crypto";
import {
  type ExecResult,
  type FileSystemHandle,
  isFileSystemGoneError,
  isSandboxGoneError,
  rootsOf,
  type SandboxActor,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxProvider,
  type SandboxRoots,
  type SandboxTier,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import {
  type Expression,
  type ExpressionBuilder,
  type Selectable,
  type SqlBool,
  sql,
  type UpdateObject,
} from "kysely";
import { BackgroundTaskStore } from "../background/store.js";
import {
  DEFAULT_MAX_COMMAND_SECONDS,
  DEFAULT_MAX_RUN_SECONDS,
  type KernelConfig,
} from "../config/schema.js";
import type { DeviceInstancesTable, KernelDatabase } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { readSandboxLimitOverride } from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { effectiveSandboxLimits, readOrgSettings } from "../orgs/settings.service.js";
import {
  appendMissingGrant,
  TIER_OPEN_GRANT_KEY,
  UNATTENDED_OPEN_TIER_ERROR,
  unattendedTierOf,
} from "../schedules/unattended.js";
import { canonicalJson } from "../tools/canonical-json.js";
import {
  type SandboxLease,
  SandboxLeases,
  SandboxLockLostError,
  type SandboxPathLease,
  sandboxBusy,
} from "./leases.js";
import {
  LOCAL_PROVIDER,
  providerForDevice,
  type SandboxProviderEntry,
  SandboxProviders,
} from "./providers.js";
import {
  type AppliedLimits,
  appliedOf,
  type EffectiveSandboxPolicy,
  effectiveSandboxPolicy,
  instanceLimitsJson,
  limitsForTier,
  readInstanceLimits,
  sameApplied,
} from "./tiers.js";

// Moved to leases.ts (phase C); re-exported for existing importers
export {
  SANDBOX_LOCK_PREFIX,
  SANDBOX_LOCK_TTL_MS,
  SandboxLockLostError,
  sandboxBusy,
} from "./leases.js";

/** Margin (ms) of a holder record's TTL beyond the longest command: by then the in-sandbox limit has ended its commands. */
const HOLDER_TTL_MARGIN_MS = 10 * 60_000;
/** How long the kernel's own read-modify-write of one file waits for another holder's (ms, spec §10.4). */
const PATH_LEASE_WAIT_MS = 30_000;
/** Time limit of one provider call in maintenance (suspend, destroy). */
const SWEEP_OP_TIMEOUT_MS = 120_000;
/** How long the suspension sweep holds the intent on a sandbox past `maxRunningMinutes` (ms). */
const SWEEP_INTENT_WAIT_MS = 1000;
/** Rows one sweep handles at most, and the provider calls it runs at once. */
const SWEEP_BATCH = 200;
const SWEEP_CONCURRENCY = 4;
/** How long `destroyDevice` / `resetFileSystem` wait for the exclusive lease (running commands). */
const EXCLUSIVE_WAIT_MS = 10 * 60_000;
/** The time limit of the exec that kills lost background tasks after a resume (ms). */
const PENDING_KILL_TIMEOUT_MS = 30_000;
/** A background task's session id as `echo $!` printed it; anything else is never put in a command. */
const SID_RE = /^[1-9][0-9]{0,9}$/;

/** The third argument of the `withSandbox` callback. */
export interface SandboxUseInfo {
  /** This call created the instance (first use, or a rebuild). */
  fresh: boolean;
  /**
   * The device had an instance before that is no longer there (destroyed after inactivity,
   * gone at the provider, or rebuilt by another holder since this holder last used it): this is a
   * new instance on the kept files, so earlier processes are gone.
   */
  restarted: boolean;
  /**
   * The device's files were reset since this holder last used it (on request, or after they
   * were lost): earlier files are gone too. Set only when true; `restarted` is then false.
   */
  filesReset?: true;
  /**
   * The instance's roots ({@link rootsOf} of its handle): every model-visible path is built from
   * them (environments spec §13.1; a connected machine's real paths).
   */
  roots: SandboxRoots;
}

/** {@link SandboxUseInfo} before the roots are read from the handle. */
type EnteredInfo = Omit<SandboxUseInfo, "roots">;

/** Who uses the sandbox in {@link SandboxService.withSandbox}. */
export interface SandboxUseContext {
  orgId: string;
  deviceId: string;
  /** The agent conversation using it (a sub-agent's own for a child): what it last saw is tracked. */
  holderConversationId: string;
  /** Passed with every `exec` (audit and attribution). */
  actor: SandboxActor;
}

export type { SandboxProviderEntry } from "./providers.js";

type Row = Selectable<DeviceInstancesTable>;
type Patch = UpdateObject<KernelDatabase, "device_instances">;
type ExecArgs = Parameters<SandboxProvider["exec"]>[1];
/** The fence read under the lease (incremented by every fenced write). */
interface Fence {
  gen: number;
}

/**
 * One instance of a device: its handle and the row's `created_at`, which the fenced write
 * after every `create` sets. The handle alone is not enough: sandbox-docker's handle is the
 * instance name, the same after a rebuild (spec §10.10).
 */
interface Instance {
  handle: SandboxHandle;
  createdAt: number;
}

/**
 * The provider {@link SandboxService.withSandbox} passes to its callback: every `exec` carries the
 * holder's tag and the caller's actor, so the callback passes neither.
 */
export type HeldProvider = Omit<SandboxProvider, "exec"> & {
  exec(h: SandboxHandle, args: Omit<ExecArgs, "tag" | "actor">): Promise<ExecResult>;
};

/**
 * The provider {@link SandboxService.ifRunning} passes to its callback: every `exec` carries the
 * holder's tag; the caller names the actor.
 */
export type TaggedProvider = Omit<SandboxProvider, "exec"> & {
  exec(h: SandboxHandle, args: Omit<ExecArgs, "tag">): Promise<ExecResult>;
};

/** What {@link SandboxService.ifRunning} did. */
export type IfRunningResult<T> =
  | { kind: "ran"; value: T }
  /**
   * No instance, or it is not running: `status` is the instance row's (`none`, `suspended`,
   * `creating`, `destroyed`, or `running` recorded with another provider), `gone` without a row.
   */
  | { kind: "not_running"; status: Row["status"] | "gone" }
  /** The device now records another instance (a rebuild). */
  | { kind: "other_instance" };

/** {@link SandboxService.limitsState}: the limits of a device's instance, for its page. */
export interface DeviceLimitsState {
  /** The tier and egress mode the instance (or its file system) runs with; null = unknown. */
  applied: AppliedLimits | null;
  /** The tier and egress mode it should run with now (the device's effective policy). */
  effective: AppliedLimits;
  /** A cloud instance differs: its next use updates or recreates it, files kept. */
  pendingNextUse: boolean;
  /** Only a file reset applies the effective limits (`limitsApplyAt: "fileSystem"`). */
  pendingFilesReset: boolean;
}

/** A holder ready to run `fn`: a shared lease, the running instance, the use info. */
interface Entered {
  lease: SandboxLease;
  handle: SandboxHandle;
  createdAt: number;
  /** The device's file reset count (`fs_resets`) when the holder entered. */
  fsResets: number;
  info: EnteredInfo;
}

/** The signal of one provider call in maintenance: aborted on timeout or when the lease is lost. */
const opSignal = (lease: SandboxLease): AbortSignal =>
  AbortSignal.any([lease.signal, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)]);

/** The provider-side name of a device's file system and instance. */
export const deviceResourceName = (deviceId: string): string => `cap-device-${deviceId}`;

/** The device is missing, deleted, or not in the caller's org (404; ids cannot be probed). */
export const deviceNotFound = (): ApiError =>
  new ApiError("device.not_found", "This device does not exist or was deleted.");

/**
 * The device's file system is gone at the provider (409); never replaced silently. On a
 * connected machine (`local`, details `[{ source: "local" }]`) the directory is the machine
 * owner's: `capybara-device logout`, then `login` into the device, recreates it (ruling R24).
 */
export const deviceFilesLost = (local = false): ApiError =>
  local
    ? new ApiError(
        "device.files_lost",
        "The local device's directory is gone from its machine; run capybara-device logout, then capybara-device login into this device, on that machine to recreate it.",
        [{ source: "local" }],
      )
    : new ApiError(
        "device.files_lost",
        "The device's files are gone; reset its files from the devices page to start with an empty workspace.",
      );

/**
 * The row still records the instance `gone` (same handle and same `created_at`). Handles compare
 * canonically: a jsonb round trip reorders a multi-key handle's keys (final review m9).
 */
export const isInstance = (
  row: Pick<Row, "handle" | "created_at">,
  gone: Instance | null,
): boolean =>
  gone !== null &&
  row.handle !== null &&
  canonicalJson(row.handle) === canonicalJson(gone.handle) &&
  row.created_at.getTime() === gone.createdAt;

/**
 * `impl` with every `exec` labelled with the holder's tag (and `actor` when given); `before` runs
 * first (it refreshes the holder's record, so a callback that runs several long commands in a row
 * stays recorded).
 */
function tagged<P>(
  impl: SandboxProvider,
  tag: string,
  actor: SandboxActor | undefined,
  before: () => Promise<void>,
): P {
  const wrapped = Object.create(impl) as SandboxProvider;
  Object.defineProperty(wrapped, "exec", {
    value: async (h: SandboxHandle, args: ExecArgs) => {
      await before();
      return impl.exec(h, { ...args, tag, ...(actor !== undefined && { actor }) });
    },
  });
  return wrapped as unknown as P;
}

/**
 * Sandbox config problems to tell operators at startup (English log lines):
 * - `runtime.maxRunSeconds` below `sandbox.limits.maxCommandSeconds`: long commands are cut by the
 *   run time limit (Ruling M20);
 * - `sandbox.tiers.max` is open but the current provider plugin sets `openEgress: "off"`: every
 *   creation of an open-tier instance is refused.
 * With both time limits at their defaults (900 < 7200, a known trade-off) it is only info; warn
 * when an operator changed one and they still disagree.
 */
export function sandboxConfigWarnings(
  cfg: Pick<KernelConfig, "runtime" | "sandbox" | "extensionConfig">,
  providerPlugin?: string,
): { level: "info" | "warn"; message: string }[] {
  const out: { level: "info" | "warn"; message: string }[] = [];
  if (cfg.sandbox.tiers.max === "open" && providerPlugin !== undefined) {
    // absent means the plugin's default ("proxy"), which creates open instances
    const pc = cfg.extensionConfig[providerPlugin] as { openEgress?: unknown } | undefined;
    if (pc?.openEgress === "off") {
      out.push({
        level: "warn",
        message: `sandbox.tiers.max is "open" but extensionConfig."${providerPlugin}".openEgress is "off": the ${providerPlugin} plugin refuses to create cloud devices in the open tier; set openEgress to "proxy" (or "direct" for trusted deployments only), or lower sandbox.tiers.max to "dev"`,
      });
    }
  }
  const run = cfg.runtime.maxRunSeconds;
  const cmd = cfg.sandbox.limits.maxCommandSeconds;
  if (run < cmd) {
    const defaults = run === DEFAULT_MAX_RUN_SECONDS && cmd === DEFAULT_MAX_COMMAND_SECONDS;
    out.push({
      level: defaults ? "info" : "warn",
      message: `runtime.maxRunSeconds (${run}) is less than sandbox.limits.maxCommandSeconds (${cmd}): sandbox commands are limited to the time left in the run, so commands longer than about ${run} seconds cannot finish; raise runtime.maxRunSeconds to at least ${cmd} if agents need long commands`,
    });
  }
  return out;
}

/** No sandbox provider (503). */
export const sandboxUnavailable = (): ApiError =>
  new ApiError(
    "sandbox.unavailable",
    "Sandbox is not available in this deployment; install a sandbox plugin",
  );

/**
 * The device's files are kept by a provider that is not the current one (503); its files are
 * not migrated, so it stays unusable until that provider is back (spec §4.2 item 13).
 */
const otherProvider = (provider: string): ApiError =>
  new ApiError(
    "device.unavailable",
    `This device's files are kept by the sandbox provider ${provider}, which is not the current provider; it can be used again once ${provider} is the deployment's sandbox provider`,
  );

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("This operation was aborted", "AbortError");

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs `fn` on `items`, `limit` at a time. */
async function inPool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const x = items[next++] as T;
      await fn(x);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * The kernel's sandbox service over the `sandbox@2` provider, keyed by **device** (spec
 * 2026-11-07-environments-design §4.2, §5.1): one file system kept until the device is
 * deleted, plus one instance attached to it that comes and goes; all conversations bound to the
 * device (and their sub-agents) share both.
 *
 * - **Lazy creation**: the first {@link withSandbox} creates the file system
 *   (`createFileSystem`, name `cap-device-<deviceId>`) and then the instance on it; state lives
 *   in `device_instances`. A file system gone at the provider is never replaced silently:
 *   `fs_status` becomes `lost` and uses fail with `device.files_lost` until
 *   {@link resetFileSystem}.
 * - **Leases** (phase C, spec §10, {@link SandboxLeases}), keyed by device id: using an
 *   instance recorded `running` with the current provider takes a **shared** lease, so up to
 *   `sandbox.maxConcurrentCommands` holders (all sessions of the device) run at once. Every
 *   lifecycle change (create, resume, rebuild, suspend, destroy, reset) takes the **exclusive**
 *   lease, alone; a caller that needs one on the use path sets the intent so new shared leases wait
 *   for it, and downgrades to a shared lease to run its own command once the instance runs.
 *   Waiting is capped at `sandbox.lockWaitSeconds` (`sandbox.busy`); two replicas using it for the
 *   first time at once still build only one.
 * - **Fencing**: exclusive holders read `generation` and compare-and-increment it with every state
 *   write ({@link SandboxLockLostError}); every acquisition (shared ones too) bumps it first, so a
 *   stale exclusive holder's later writes fail. Shared holders write nothing else but
 *   `last_used_at` (monotonic). A lost lease aborts the signal passed to `fn` and to maintenance
 *   provider calls.
 * - **Suspension and destruction**: the sweeps (`SandboxSweepJobs`, crons) call
 *   {@link suspendIdle} / {@link destroyInactive}; they try the exclusive lease once and skip an
 *   device with any holder; one past `maxRunningMinutes` gets the intent for a short window
 *   (about a second) so the suspension can get in when its commands end. Inactivity destroys only
 *   the instance (files kept); a deleted device or org loses its files too.
 * - **Transparent recovery**: a suspended instance is resumed on next use; when `resume` returns
 *   `gone`, the instance was destroyed, or `fn` throws `SandboxGoneError` (retried once), a new
 *   instance is created on the kept files and `restarted` is true. Several holders hitting `gone`
 *   together rebuild once: the others find the new instance.
 * - **Takeover** (spec §10.5; environments spec §4.2): every holder records itself in
 *   `capk:sandbox-holders:<env>` (again before each `exec`) and its commands carry its lease token
 *   as `tag`. An acquirer that finds a record without a live lease (a crashed holder) kills only
 *   that holder's commands (`killTagged`): other conversations of the device may be running
 *   commands. `killAll` runs only under the exclusive lease, before the downgrade, on an instance
 *   this holder just resumed from `suspended` (nobody else can hold it; a provider that keeps
 *   memory across a pause brings old commands back); it also covers crashed holders' records,
 *   which it claims. A freshly created instance has nothing to kill. Failures are only warned (the
 *   in-sandbox time limit is the backstop).
 * - **Instance identity**: a holder that hits `gone` names the instance by its handle and the
 *   row's `created_at` (set by the fenced write after each `create`); the handle alone is the same
 *   after a rebuild on providers whose handle is the instance name (sandbox-docker).
 *
 * - **Provider per device** (environments spec §6): each call resolves the provider from
 *   the device's `devices.provider` ({@link providerForDevice}): a `device`
 *   device runs on the kernel-internal `@local` provider (never the cloud one), a cloud
 *   device on the loaded `sandbox@2` extension. A `@local` instance is never suspended or
 *   destroyed for inactivity; a deleted `@local` device (or one of a deleted org) is
 *   destroyed by the sweep like any other.
 *
 * Files kept by another provider than the current one make the device unusable
 * (`device.unavailable`) until that provider is back; deleting it still works while that
 * provider is loaded ({@link SandboxProviders.forName}). Without the device's provider
 * {@link availableFor} is false and uses throw `sandbox.unavailable` (503). No in-process state:
 * replicas share it through PG and Redis.
 */
@Injectable()
export class SandboxService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    /** The record of the instance each holder last used (`capk:sandbox-seen:…`). */
    @Inject(REDIS) private readonly redis: Pick<Redis, "set">,
    @Inject(SandboxLeases) private readonly leases: SandboxLeases,
    /** The providers (read at every call: providers are ready after the extension load). */
    @Inject(SandboxProviders)
    private readonly providers: Pick<SandboxProviders, "cloud" | "forName">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info" | "warn">,
    /** Background tasks lost while their process may live on (killed after a resume). */
    @Inject(BackgroundTaskStore)
    private readonly background: Pick<BackgroundTaskStore, "pendingKills" | "clearKill">,
  ) {}

  /** Poll interval while waiting for a lease (the leases' own). */
  private get pollMs(): number {
    return this.leases.pollMs;
  }

  /**
   * Whether there is a cloud sandbox provider (a loaded `sandbox@2` extension). For gates that have
   * no device yet (tool listing, skill files); a call on a device asks
   * {@link availableFor}.
   */
  get cloudAvailable(): boolean {
    return this.providers.cloud() !== undefined;
  }

  /** Whether the device's provider is there (`@local` registered, or a cloud provider). */
  async availableFor(deviceId: string): Promise<boolean> {
    return (await this.providerOf(deviceId)) !== undefined;
  }

  /**
   * The provider the device works with, read from its row ({@link providerForDevice});
   * a missing row (or one of another org, with `orgId`) reads as a cloud device, whose use
   * then fails as not found.
   */
  private async providerOf(
    deviceId: string,
    orgId?: string,
  ): Promise<SandboxProviderEntry | undefined> {
    const row = await this.db
      .selectFrom("devices")
      .select("provider")
      .where("id", "=", deviceId)
      .$if(orgId !== undefined, (q) => q.where("org_id", "=", orgId as string))
      .executeTakeFirst();
    return providerForDevice(this.providers, row?.provider ?? null);
  }

  /** {@link providerOf}, or `sandbox.unavailable` (503) without it. */
  private async require(deviceId: string, orgId?: string): Promise<SandboxProviderEntry> {
    const p = await this.providerOf(deviceId, orgId);
    if (!p) throw sandboxUnavailable();
    return p;
  }

  /** Concurrent holders of one device (`sandbox.maxConcurrentCommands`, read at every use). */
  private get cap(): number {
    return this.config.get().sandbox.maxConcurrentCommands;
  }

  /**
   * The effective sandbox policy of a device (sandbox dev tiers spec §4.2): the platform's and
   * the org's tiers and network with the device's own tier (`devices.tier`, read fresh; a local
   * device and a missing one have none). Without `deviceId`: a device that follows the org's
   * default.
   */
  async devicePolicy(device: {
    orgId: string;
    deviceId?: string;
  }): Promise<EffectiveSandboxPolicy> {
    const cfg = this.config.get().sandbox;
    const [settings, tier] = await Promise.all([
      readOrgSettings(this.db.db, device.orgId),
      device.deviceId === undefined ? null : this.deviceTier(device.orgId, device.deviceId),
    ]);
    return effectiveSandboxPolicy(cfg, settings, tier);
  }

  /** The device's own tier (`devices.tier`); null when it follows the org or is not there. */
  private async deviceTier(orgId: string, deviceId: string): Promise<SandboxTier | null> {
    const row = await this.db
      .selectFrom("devices")
      .select("tier")
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    return row?.tier ?? null;
  }

  /**
   * The device's effective sandbox limits (spec §8.4; sandbox dev tiers spec §4.2): the
   * deployment's `sandbox.limits`, cpu / memory per the super admin's org override (C19 / Ruling
   * M16), and the network of the effective tier ({@link devicePolicy}): egress narrowed by the
   * org setting `sandboxEgress` (Ruling M19), widened by the tier. `opts.policy`: a policy the
   * caller already read; `opts.tier`: limits for that tier instead (a local device's ceiling, an
   * unattended run's cap). Cloud instances are created with them.
   */
  async deviceLimits(
    device: { orgId: string; deviceId?: string },
    opts: { policy?: EffectiveSandboxPolicy; tier?: SandboxTier } = {},
  ): Promise<SandboxLimits> {
    const cfg = this.config.get().sandbox;
    const [policy, override] = await Promise.all([
      opts.policy ?? this.devicePolicy(device),
      readSandboxLimitOverride(this.db.db, device.orgId),
    ]);
    const tier = opts.tier ?? policy.tier;
    const net = limitsForTier(policy, tier);
    const sized = effectiveSandboxLimits(
      { ...cfg.limits, ...net, tier, devHosts: policy.devHosts },
      override,
    );
    return {
      cpu: sized.cpu,
      memoryMb: sized.memoryMb,
      diskMb: sized.diskMb,
      egress: sized.egress,
      allowHosts: sized.allowHosts,
      tier: sized.tier,
      devHosts: [...policy.devHosts],
    };
  }

  /**
   * The org's effective sandbox limits for a device that follows the org's default tier
   * ({@link deviceLimits} without a device): what a network grant or approval is checked against.
   */
  async orgLimits(orgId: string): Promise<SandboxLimits> {
    return this.deviceLimits({ orgId });
  }

  /**
   * The limits state of a device's instance for its page (sandbox dev tiers spec §7.1, §11.1),
   * read without a lease: `applied` is what the instance or file system was made with or updated
   * to (null: unknown, or no instance yet), `effective` what it should run with now.
   * `pendingNextUse`: a cloud instance exists and differs; its next use applies the new limits
   * (files kept). `pendingFilesReset`: the provider fixes limits at its file system
   * (`limitsApplyAt: "fileSystem"`) and cannot `update` them, so only a file reset applies them.
   * A local device (its machine applies the tier at each command) is never pending, and its
   * `applied` is null.
   */
  async limitsState(device: { orgId: string; deviceId: string }): Promise<DeviceLimitsState> {
    const [policy, row, p] = await Promise.all([
      this.devicePolicy(device),
      this.db
        .selectFrom("device_instances")
        .select(["provider", "status", "handle", "fs_status", "instance_limits"])
        .where("device_id", "=", device.deviceId)
        .where("org_id", "=", device.orgId)
        .executeTakeFirst(),
      this.providerOf(device.deviceId, device.orgId),
    ]);
    const effective: AppliedLimits = { tier: policy.tier, egress: policy.egress };
    if (p === undefined || p.plugin === LOCAL_PROVIDER || row === undefined) {
      return { applied: null, effective, pendingNextUse: false, pendingFilesReset: false };
    }
    const rec = readInstanceLimits(row.instance_limits);
    const differs = row.provider === p.plugin && !sameApplied(rec.applied, effective);
    const fsBound = differs && row.fs_status === "ready" && this.fsBound(p, rec, effective);
    const hasInstance =
      row.handle !== null && (row.status === "running" || row.status === "suspended");
    return {
      applied: rec.applied,
      effective,
      pendingNextUse: differs && !fsBound && hasInstance,
      pendingFilesReset: fsBound,
    };
  }

  /**
   * Whether a provider whose limits are fixed at its file system cannot apply `effective`
   * without a file reset: it has no `update`, or its `update` already answered `recreate` for it.
   */
  private fsBound(
    p: SandboxProviderEntry,
    rec: ReturnType<typeof readInstanceLimits>,
    effective: AppliedLimits,
  ): boolean {
    if (p.impl.limitsApplyAt !== "fileSystem") return false;
    return p.impl.update === undefined || sameApplied(rec.unapplied, effective);
  }

  /**
   * Whether the running instance of `row` must get `want` before use (spec §7.1): a cloud
   * instance whose recorded tier or egress mode differs, unless only a file reset could apply it
   * ({@link fsBound}). `want` null: a local device (the tier travels with each command).
   */
  private mustApply(row: Row, p: SandboxProviderEntry, want: SandboxLimits | null): boolean {
    if (want === null) return false;
    const rec = readInstanceLimits(row.instance_limits);
    const target = appliedOf(want);
    if (sameApplied(rec.applied, target)) return false;
    return !this.fsBound(p, rec, target);
  }

  /**
   * The device's instance state as shown to people (read only, no lease): `running` /
   * `suspended` and the last use. No instance, a destroyed one, or one stuck in `creating` (being
   * created, or a failed create the next use retries) is null.
   */
  async status(
    orgId: string,
    deviceId: string,
  ): Promise<{ status: "running" | "suspended"; lastUsedAt: Date } | null> {
    const row = await this.db
      .selectFrom("device_instances")
      .select(["status", "last_used_at"])
      .where("device_id", "=", deviceId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!row || (row.status !== "running" && row.status !== "suspended")) return null;
    return { status: row.status, lastUsedAt: row.last_used_at };
  }

  /**
   * The instance the device records now (its `created_at`), while it has one that runs or is
   * suspended; null otherwise. Read without a lease: a caller inside `withSandbox` reads the
   * instance its own lease keeps.
   */
  async currentInstance(deviceId: string): Promise<{ createdAt: Date } | null> {
    const row = await this.db
      .selectFrom("device_instances")
      .select(["status", "handle", "created_at"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    if (!row || row.handle === null) return null;
    if (row.status !== "running" && row.status !== "suspended") return null;
    return { createdAt: row.created_at };
  }

  /**
   * Runs `fn` on the device's instance only while it runs the instance created at
   * `instance.createdAt` (background tasks, spec 2026-11-05-background-bash-design §4.3). It never
   * creates, resumes or rebuilds one: an instance that is missing, suspended, being created or
   * destroyed (or recorded with another provider) is `not_running`, one that records another
   * instance is `other_instance`. Otherwise `fn` runs under a shared lease, as a `withSandbox`
   * holder does (its tag on every exec, crashed holders' commands killed), and `last_used_at`
   * moves forward when it ends. Waits for the lease up to `sandbox.lockWaitSeconds`
   * (`sandbox.busy`); `signal` (optional) ends the wait with its abort reason. The signal passed
   * to `fn` aborts with `signal` or when the lease is lost. Errors of `fn` (`SandboxGoneError`
   * too) are thrown as they are.
   */
  async ifRunning<T>(
    deviceId: string,
    instance: { createdAt: Date },
    fn: (p: TaggedProvider, h: SandboxHandle, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<IfRunningResult<T>> {
    const p = await this.require(deviceId);
    const env = deviceId;
    const deadline = Date.now() + this.config.get().sandbox.lockWaitSeconds * 1000;
    const token = randomUUID();
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      const row = await this.db
        .selectFrom("device_instances")
        .selectAll()
        .where("device_id", "=", env)
        .executeTakeFirst();
      if (!row) return { kind: "not_running", status: "gone" };
      if (row.created_at.getTime() !== instance.createdAt.getTime()) {
        return { kind: "other_instance" };
      }
      if (!this.usable(row, p, null)) return { kind: "not_running", status: row.status };
      // the instance this check saw: its handle plus `created_at` (never `generation`, which
      // every lease bumps)
      const want: Instance = { handle: row.handle, createdAt: row.created_at.getTime() };
      const lease = await this.leases.tryShared(env, this.cap, token);
      if (lease) {
        const e = await this.asShared(
          { orgId: row.org_id, deviceId: env },
          p,
          lease,
          (r): r is Row & { handle: SandboxHandle } =>
            this.usable(r, p, null) && isInstance(r, want),
          signal,
        );
        if (e) {
          try {
            const impl = tagged<TaggedProvider>(p.impl, lease.token, undefined, () =>
              this.register(env, lease.token),
            );
            const sig = AbortSignal.any([signal, lease.signal]);
            try {
              return { kind: "ran", value: await fn(impl, e.handle, sig) };
            } catch (err) {
              if (isFileSystemGoneError(err)) throw await this.filesGone(env, p, e);
              throw err;
            }
          } finally {
            await this.leave(env, e);
          }
        }
        // the row changed between the check and the lease: classify it again
        continue;
      }
      if (Date.now() + this.pollMs > deadline) throw sandboxBusy();
      await sleep(this.pollMs + Math.floor(Math.random() * this.pollMs), signal);
    }
  }

  /**
   * A short lease on one path of the device around the kernel's own read-modify-write of
   * that file (spec §10.4); waits up to 30 s, then throws `SandboxPathBusyError`. Its `signal`
   * aborts when a renewal finds it lost.
   */
  pathLease(deviceId: string, path: string, signal: AbortSignal): Promise<SandboxPathLease> {
    return this.leases.pathLease(deviceId, path, signal, PATH_LEASE_WAIT_MS);
  }

  /**
   * Runs `fn` on the device's instance: take a lease → make sure the instance runs (file
   * system, create / resume / rebuild, under the exclusive lease) → `fn` under a shared lease →
   * update `last_used_at` → release.
   * - Waiting longer than `sandbox.lockWaitSeconds` throws `sandbox.busy` (409); `signal` aborts
   *   the wait and the creation / resume.
   * - The fourth argument of `fn` combines `signal` with the lease's: use it for commands, so they
   *   stop when the lease is lost.
   * - The provider passed to `fn` labels every `exec` with this holder's tag and `ctx.actor`.
   * - When `fn` throws `SandboxGoneError` (the instance is gone) the instance is rebuilt on the
   *   kept files (or the one another holder rebuilt is taken) and `fn` runs once more with
   *   `restarted: true`; a second `gone` is thrown. Other errors are thrown as they are.
   * - Lost files throw `device.files_lost` (409), also when `fn` throws
   *   `FileSystemGoneError` (the files are then recorded lost, ruling R24).
   * - When `ctx.holderConversationId` last used another instance (another holder rebuilt it
   *   meanwhile), `info.restarted` is true, so it learns its processes are gone (final review m5).
   */
  async withSandbox<T>(
    ctx: SandboxUseContext,
    fn: (
      h: SandboxHandle,
      p: HeldProvider,
      info: SandboxUseInfo,
      signal: AbortSignal,
    ) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const p = await this.require(ctx.deviceId, ctx.orgId);
    const env = ctx.deviceId;
    const holder = ctx.holderConversationId;
    const want = await this.wantedLimits(ctx, p);
    let e = await this.seenBy(env, holder, await this.enter(ctx, p, signal, null, want));
    try {
      try {
        return await this.runAs(e, ctx, p, fn, signal);
      } catch (err) {
        if (isFileSystemGoneError(err)) throw await this.filesGone(env, p, e);
        if (!isSandboxGoneError(err)) throw err;
        this.log.info("sandbox instance is gone during use; recreating", { deviceId: env });
        const gone: Instance = { handle: e.handle, createdAt: e.createdAt };
        const prev = e;
        await this.leave(env, prev);
        e = await this.seenBy(env, holder, await this.enter(ctx, p, signal, gone, want));
        // a reset seen on the first try still has to be told (it covers the restart)
        const info: EnteredInfo = prev.info.filesReset
          ? { fresh: true, restarted: false, filesReset: true }
          : { fresh: true, restarted: true };
        try {
          return await this.runAs({ ...e, info }, ctx, p, fn, signal);
        } catch (err2) {
          if (isFileSystemGoneError(err2)) throw await this.filesGone(env, p, e);
          throw err2;
        }
      }
    } finally {
      await this.leave(env, e);
    }
  }

  /**
   * The limits a cloud device's instance must run with for this use (sandbox dev tiers spec
   * §7.1), read fresh; null for a local device (its machine gets the tier with each command).
   * A scheduled run without a person on a cloud device whose effective tier is open, without the
   * task's `tier:open` grant, is refused (`device.tier_not_granted`, recorded in the task run's
   * `missing_grants`): the tier belongs to the shared instance, so it is not switched under the
   * device's attended sessions (spec §11.4).
   */
  private async wantedLimits(
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
  ): Promise<SandboxLimits | null> {
    if (p.plugin === LOCAL_PROVIDER) return null;
    const policy = await this.devicePolicy(ctx);
    const runId = ctx.actor.runId;
    if (policy.tier === "open" && runId !== undefined) {
      const u = await unattendedTierOf(this.db.db, runId, ctx.deviceId);
      if (u !== null && !u.openGranted) {
        await appendMissingGrant(this.db.db, u.taskRunId, TIER_OPEN_GRANT_KEY).catch(
          (err: unknown) =>
            this.log.warn("cannot record a missing task grant", { taskRunId: u.taskRunId, err }),
        );
        this.log.warn("scheduled run refused on a cloud device in the open tier", {
          deviceId: ctx.deviceId,
          taskRunId: u.taskRunId,
        });
        throw new ApiError("device.tier_not_granted", UNATTENDED_OPEN_TIER_ERROR);
      }
    }
    return await this.deviceLimits(ctx, { policy });
  }

  /**
   * Ruling R24: an operation on the held instance `e` found its file system gone. Records
   * `fs_status = 'lost'` while the row still records that instance on its file system (the
   * instance handle stays, so a reset still destroys it), moving the fence on, and returns
   * `device.files_lost` to throw. Uses then fail until the files are reset (a connected
   * machine: until a new login, which resets the row). A failed write only logs.
   */
  private async filesGone(env: string, p: SandboxProviderEntry, e: Entered): Promise<ApiError> {
    this.log.warn("device file system is gone at the provider; its files are lost", {
      deviceId: env,
      provider: p.plugin,
    });
    try {
      await this.db
        .updateTable("device_instances")
        .set((eb) => ({ fs_status: "lost", generation: eb("generation", "+", 1) }))
        .where("device_id", "=", env)
        .where("fs_status", "=", "ready")
        // `createdAt` is the row's value read back in milliseconds
        .where(sql<Date>`date_trunc('milliseconds', created_at)`, "=", new Date(e.createdAt))
        .execute();
    } catch (err) {
      this.log.warn("cannot record lost device files", { deviceId: env, err });
    }
    return deviceFilesLost(p.plugin === LOCAL_PROVIDER);
  }

  /**
   * Records that `holder` uses the instance of `e` (`capk:sandbox-seen:<env>:<holder>` =
   * `<created_at>:<fs_resets>`, with a TTL of the inactivity destruction plus a day). When the
   * holder last used another instance under the same reset count `e` is marked restarted (files
   * kept); under another count it is marked `filesReset` instead. The count, not the provider's
   * file system id, tells them apart: a provider may give the new file system the old id
   * (sandbox-docker's volumes are named after the device). Best effort: a Redis error only
   * logs.
   */
  private async seenBy(deviceId: string, holder: string, e: Entered): Promise<Entered> {
    try {
      const ttl = (this.config.get().sandbox.limits.destroyAfterInactiveDays + 1) * 86_400;
      const seen = `${e.createdAt}:${e.fsResets}`;
      const prev = await this.redis.set(
        `capk:sandbox-seen:${deviceId}:${holder}`,
        seen,
        "EX",
        ttl,
        "GET",
      );
      if (prev !== null && prev !== seen) {
        // `<createdAt>:<fsResets>`: another reset count means the files were reset since; another
        // instance under the same count is a restart on kept files
        const sameFiles = prev.slice(prev.indexOf(":") + 1) === String(e.fsResets);
        if (!sameFiles) {
          return { ...e, info: { fresh: e.info.fresh, restarted: false, filesReset: true } };
        }
        if (!e.info.restarted) return { ...e, info: { fresh: e.info.fresh, restarted: true } };
      }
    } catch (err) {
      this.log.warn("cannot record the sandbox instance a holder uses", {
        deviceId,
        holder,
        err,
      });
    }
    return e;
  }

  /** Runs `fn` as the holder `e`: its tag and the caller's actor on every exec, its lease's signal. */
  private runAs<T>(
    e: Entered,
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
    fn: (
      h: SandboxHandle,
      p: HeldProvider,
      info: SandboxUseInfo,
      signal: AbortSignal,
    ) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const sig = AbortSignal.any([signal, e.lease.signal]);
    const env = ctx.deviceId;
    const impl = tagged<HeldProvider>(p.impl, e.lease.token, ctx.actor, () =>
      this.register(env, e.lease.token),
    );
    return fn(e.handle, impl, { ...e.info, roots: rootsOf(e.handle) }, sig);
  }

  /**
   * Becomes a holder: loops until it has a shared lease on a running instance, or `sandbox.busy`.
   * An instance recorded `running` (with the current provider, not the `gone` instance) is used
   * under a shared lease; otherwise the exclusive lease (with intent) makes it run and is
   * downgraded. One token serves both, so the waiter passes its own intent.
   */
  private async enter(
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
    signal: AbortSignal,
    gone: Instance | null,
    want: SandboxLimits | null,
  ): Promise<Entered> {
    const env = ctx.deviceId;
    const deadline = Date.now() + this.config.get().sandbox.lockWaitSeconds * 1000;
    const token = randomUUID();
    let intent = false;
    try {
      for (;;) {
        if (signal.aborted) throw abortReason(signal);
        const row = await this.readRow(ctx);
        // an instance whose tier or egress must change goes through the exclusive lease
        const ready = (r: Row | undefined): r is Row & { handle: SandboxHandle } =>
          this.usable(r, p, gone) && !this.mustApply(r, p, want);
        if (ready(row)) {
          const lease = await this.leases.tryShared(env, this.cap, token);
          if (lease) {
            if (intent) await this.clearIntent(env, token);
            intent = false;
            const e = await this.asShared(ctx, p, lease, ready, signal);
            if (e) return e;
          }
        } else {
          const lease = await this.leases.tryExclusive(env, { token, intent: true });
          intent = lease === null;
          if (lease) return await this.asExclusive(ctx, p, lease, gone, signal, want);
        }
        if (Date.now() + this.pollMs > deadline) throw sandboxBusy();
        await sleep(this.pollMs + Math.floor(Math.random() * this.pollMs), signal);
      }
    } catch (err) {
      if (intent) await this.clearIntent(env, token);
      throw err;
    }
  }

  private async clearIntent(env: string, token: string): Promise<void> {
    await this.leases
      .clearIntent(env, token)
      .catch((err: unknown) =>
        this.log.warn("cannot clear sandbox intent", { deviceId: env, err }),
      );
  }

  private async readRow(ctx: { orgId: string; deviceId: string }): Promise<Row | undefined> {
    const row = await this.db
      .selectFrom("device_instances")
      .selectAll()
      .where("device_id", "=", ctx.deviceId)
      .executeTakeFirst();
    if (row && row.org_id !== ctx.orgId) throw this.foreign(ctx);
    return row;
  }

  /** The instance row belongs to another org: reported as not found, so ids cannot be probed. */
  private foreign(_ctx: { orgId: string; deviceId: string }): ApiError {
    return deviceNotFound();
  }

  /**
   * Recorded running with the current provider on files not lost (lost ones go through the
   * exclusive path, which refuses them), and not the instance found gone.
   */
  private usable(
    row: Row | undefined,
    p: SandboxProviderEntry,
    gone: Instance | null,
  ): row is Row & { handle: SandboxHandle } {
    return (
      row !== undefined &&
      row.status === "running" &&
      row.fs_status !== "lost" &&
      row.provider === p.plugin &&
      row.handle !== null &&
      !isInstance(row, gone)
    );
  }

  /**
   * Under a just-taken shared lease: confirms the row is still `accept`ed (else releases and
   * returns null), records the holder and kills crashed holders' commands.
   */
  private async asShared(
    ctx: { orgId: string; deviceId: string },
    p: SandboxProviderEntry,
    lease: SandboxLease,
    accept: (row: Row | undefined) => row is Row & { handle: SandboxHandle },
    signal: AbortSignal,
  ): Promise<Entered | null> {
    const env = ctx.deviceId;
    try {
      const row = await this.readRow(ctx);
      if (!accept(row)) {
        await lease.release();
        return null;
      }
      // Bump the fence as every acquisition did before phase C: an exclusive holder whose lease
      // expired unnoticed (a stalled sweep) then fails its next write instead of suspending or
      // destroying the instance under this holder. Shared holders never compare it.
      await this.db
        .updateTable("device_instances")
        .set((eb) => ({ generation: eb("generation", "+", 1) }))
        .where("device_id", "=", env)
        .execute();
      await this.register(env, lease.token);
      // other holders (any conversation of the device) may be running: only the dead
      // holders' own commands are killed
      await this.killTagged(env, row.handle, p, await this.claim(env), signal, lease);
      return {
        lease,
        handle: row.handle,
        createdAt: row.created_at.getTime(),
        fsResets: row.fs_resets,
        info: { fresh: false, restarted: false },
      };
    } catch (err) {
      await this.unregister(env, lease.token);
      await lease.release();
      throw err;
    }
  }

  /**
   * Under a just-taken exclusive lease: makes the instance run (file system, create / resume /
   * rebuild when the recorded instance is the one found gone), kills leftovers, then downgrades to
   * a shared lease. Crashed holders' records are claimed here: on an instance just resumed from
   * `suspended` one `killAll` covers them and anything else left (nobody else holds the instance),
   * on a new instance there is nothing to kill, and on one that already ran their tags are killed.
   */
  private async asExclusive(
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
    lease: SandboxLease,
    gone: Instance | null,
    signal: AbortSignal,
    want: SandboxLimits | null,
  ): Promise<Entered> {
    const env = ctx.deviceId;
    const sig = AbortSignal.any([signal, lease.signal]);
    try {
      const s = await this.ensure(ctx, p, lease, sig, gone, want);
      const dead = await this.claim(env);
      if (s.resumed) await this.killLeftovers(env, s.handle, p, sig, dead);
      else if (!s.info.fresh) await this.killTagged(env, s.handle, p, dead, signal, lease);
      if (s.resumed || s.info.fresh) {
        await this.killPendingTasks(env, s.handle, s.createdAt, p, lease.token, ctx.actor, sig);
      }
      const shared = await lease.downgrade();
      await this.register(env, shared.token);
      return {
        lease: shared,
        handle: s.handle,
        createdAt: s.createdAt,
        fsResets: s.fsResets,
        info: s.info,
      };
    } catch (err) {
      await this.unregister(env, lease.token);
      // releases the lease in whatever kind it has now (also after a downgrade)
      await lease.release();
      throw err;
    }
  }

  /** Ends a holder: unregisters it before releasing its lease, then moves `last_used_at` forward. */
  private async leave(env: string, e: Entered): Promise<void> {
    await this.unregister(env, e.lease.token);
    await e.lease.release();
    await this.db
      .updateTable("device_instances")
      .set({ last_used_at: sql<Date>`GREATEST(last_used_at, now())` })
      .where("device_id", "=", env)
      .where("status", "=", "running")
      .execute()
      .catch((err: unknown) =>
        this.log.warn("cannot update sandbox last_used_at", { deviceId: env, err }),
      );
  }

  private async register(env: string, token: string): Promise<void> {
    const ttl = this.config.get().sandbox.limits.maxCommandSeconds * 1000 + HOLDER_TTL_MARGIN_MS;
    await this.leases
      .registerHolder(env, token, ttl)
      .catch((err: unknown) =>
        this.log.warn("cannot record sandbox holder", { deviceId: env, err }),
      );
  }

  private async unregister(env: string, token: string): Promise<void> {
    await this.leases
      .unregisterHolder(env, token)
      .catch((err: unknown) =>
        this.log.warn("cannot clear sandbox holder record", { deviceId: env, err }),
      );
  }

  /** Crashed holders' tags (claimed); a Redis error counts as none. */
  private async claim(env: string): Promise<string[]> {
    try {
      return await this.leases.claimDeadHolders(env);
    } catch (err) {
      this.log.warn("cannot read sandbox holder records", { deviceId: env, err });
      return [];
    }
  }

  /** Kills the commands of crashed holders by their tags (`killTagged`); nothing without tags. */
  private async killTagged(
    env: string,
    handle: SandboxHandle,
    p: SandboxProviderEntry,
    tags: string[],
    signal: AbortSignal,
    lease: SandboxLease,
  ): Promise<void> {
    if (tags.length === 0) return;
    const sig = AbortSignal.any([signal, lease.signal]);
    await this.kill(env, "takeover", () => p.impl.killTagged(handle, tags, sig), sig);
  }

  /** Runs one kill call: gone and abort are thrown, other failures only warned. */
  private async kill(
    deviceId: string,
    why: "takeover" | "resume",
    call: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await call();
      if (why === "takeover") {
        this.log.info(
          "sandbox taken over from a holder that did not finish; leftover commands killed",
          { deviceId },
        );
      }
    } catch (err) {
      if (signal?.aborted || isSandboxGoneError(err)) throw err;
      this.log.warn("cannot kill leftover sandbox commands", { deviceId, err });
    }
  }

  /**
   * Suspends running instances idle longer than `suspendAfterIdleMinutes` or running continuously
   * longer than `maxRunningMinutes`. Skips a device with any holder; one past
   * `maxRunningMinutes` gets the intent for one poll window (about a second) first. Returns how
   * many it suspended. Called every minute by the `sandbox-suspend-idle` cron.
   */
  async suspendIdle(now: Date): Promise<number> {
    // cloud only: suspendDue keeps to this provider's rows, so `@local` is never suspended here
    const p = this.providers.cloud();
    if (!p) return 0;
    const due = this.suspendDue(now, p.plugin);
    const runningBefore = new Date(
      now.getTime() - this.config.get().sandbox.limits.maxRunningMinutes * 60_000,
    );
    const rows = await this.candidates(due);
    let n = 0;
    await inPool(rows, SWEEP_CONCURRENCY, async (c) => {
      const overdue = c.running_since !== null && c.running_since < runningBefore;
      const done = await this.tryLocked(
        c.device_id,
        async (lease) => {
          const id = c.device_id;
          const row = await this.db
            .selectFrom("device_instances")
            .selectAll()
            .where("device_id", "=", id)
            .where(due)
            .executeTakeFirst();
          if (!row?.handle) return false;
          const fence = { gen: row.generation };
          await p.impl.suspend(row.handle, opSignal(lease));
          if (!(await lease.renew())) throw new SandboxLockLostError(id);
          await this.fenced(lease, id, fence, {
            status: "suspended",
            suspended_at: sql<Date>`now()`,
            running_since: null,
            sweep_failed_at: null,
          });
          this.log.info("sandbox suspended", { deviceId: id });
          return true;
        },
        overdue,
      );
      if (done) n++;
    });
    return n;
  }

  /**
   * Destruction sweep: an instance unused for longer than `destroyAfterInactiveDays` is destroyed
   * (the instance only; the file system is kept and the next use builds a new instance on it); an
   * device that was deleted, or whose org was deleted, loses its instance and its file system
   * and its row is deleted (as {@link destroyDevice} does). Devices with any holder are
   * skipped. Inactivity never destroys a `@local` instance; a gone `@local` device is
   * destroyed like any other while `@local` is registered. Returns how many it destroyed. Called
   * hourly by the `sandbox-destroy-inactive` cron.
   */
  async destroyInactive(now: Date): Promise<number> {
    const p = this.providers.cloud();
    const local = this.providers.forName(LOCAL_PROVIDER) !== undefined;
    let n = 0;
    // Gone devices (deleted, or of a deleted org) on every provider that is here, `@local`
    // too (its destroy calls never need the machine online); rows whose provider is missing wait.
    const here = (eb: ExpressionBuilder<KernelDatabase, "device_instances">) =>
      eb.or([
        ...(p ? [this.cloudRow(eb)] : []),
        ...(local ? [eb("provider", "=", LOCAL_PROVIDER)] : []),
      ]);
    const gone = (eb: ExpressionBuilder<KernelDatabase, "device_instances">) =>
      eb.and([here(eb), this.deviceGone(eb)]);
    if (p || local) {
      await inPool(await this.candidates(gone), SWEEP_CONCURRENCY, async ({ device_id: id }) => {
        const done = await this.tryLocked(id, async (lease) => {
          const row = await this.db
            .selectFrom("device_instances")
            .selectAll()
            .where("device_id", "=", id)
            .where(gone)
            .executeTakeFirst();
          const owner = row && this.rowProvider(row);
          if (!row || !owner) return false;
          await this.destroyRow(row, owner, lease, "device");
          return true;
        });
        if (done) n++;
      });
    }
    // inactivity destroys cloud instances only: `@local` instances are never swept
    if (!p) return n;
    const due = this.instanceDue(now);
    const idle = (eb: ExpressionBuilder<KernelDatabase, "device_instances">) =>
      eb.and([this.cloudRow(eb), due(eb)]);
    await inPool(await this.candidates(idle), SWEEP_CONCURRENCY, async ({ device_id: id }) => {
      const done = await this.tryLocked(id, async (lease) => {
        const row = await this.db
          .selectFrom("device_instances")
          .selectAll()
          .where("device_id", "=", id)
          .where(idle)
          .executeTakeFirst();
        if (!row) return false;
        await this.destroyRow(row, p, lease, "instance");
        return true;
      });
      if (done) n++;
    });
    return n;
  }

  /**
   * Destroys the device's instance, then its file system, then deletes its instance row
   * (device deletion, offboarding); nothing to do without a row. Waits for the exclusive lease
   * (with intent, so running commands finish and new ones wait) up to 10 minutes. Without the
   * device's provider it throws and the row stays, marked `sweep_failed_at` (the job is
   * retried, and the destruction sweep finishes a deleted device once the provider is back).
   * Files kept by another provider that is not loaded cannot be destroyed: it throws and the row
   * stays.
   */
  async destroyDevice(deviceId: string): Promise<void> {
    const row = await this.db
      .selectFrom("device_instances")
      .select("device_id")
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    if (!row) return;
    const p = await this.providerOf(deviceId);
    if (!p) {
      await this.db
        .updateTable("device_instances")
        .set({ sweep_failed_at: sql<Date>`now()` })
        .where("device_id", "=", deviceId)
        .execute();
      throw new Error(
        `cannot destroy device ${deviceId}: its sandbox provider is not there; ` +
          "the destruction sweep retries it",
      );
    }
    const lease = await this.leases.acquireExclusive(
      deviceId,
      AbortSignal.timeout(EXCLUSIVE_WAIT_MS),
      undefined,
      { intent: true },
    );
    try {
      const current = await this.db
        .selectFrom("device_instances")
        .selectAll()
        .where("device_id", "=", deviceId)
        .executeTakeFirst();
      if (current) await this.destroyRow(current, p, lease, "device");
    } finally {
      await lease.release();
    }
  }

  /**
   * Starts the device over with empty files (after `device.files_lost`, or on request):
   * under the exclusive lease (waited for like {@link destroyDevice}) destroys any instance and
   * the file system (a `lost` one is only dropped), and records no file system; the next use
   * creates a new one. Nothing to do without a row. Throws `sandbox.unavailable` without a provider.
   */
  async resetFileSystem(deviceId: string): Promise<void> {
    const p = await this.require(deviceId);
    const lease = await this.leases.acquireExclusive(
      deviceId,
      AbortSignal.timeout(EXCLUSIVE_WAIT_MS),
      undefined,
      { intent: true },
    );
    try {
      const row = await this.db
        .selectFrom("device_instances")
        .selectAll()
        .where("device_id", "=", deviceId)
        .executeTakeFirst();
      if (!row) return;
      const fence = { gen: row.generation };
      const signal = opSignal(lease);
      const prev = await this.destroyInstance(row, p, signal);
      await this.destroyFiles(row, p, signal, true);
      if (!(await lease.renew())) throw new SandboxLockLostError(deviceId);
      await this.fenced(lease, deviceId, fence, {
        fs_handle: null,
        fs_status: "none",
        handle: null,
        status: "none",
        running_since: null,
        suspended_at: null,
        destroyed_at: sql<Date>`now()`,
        sweep_failed_at: null,
        // conversations that used the old files are told they were reset (seenBy)
        fs_resets: sql<number>`fs_resets + 1`,
        // the next file system and instance record their own limits
        instance_limits: null,
        ...prev,
      });
      this.log.info("device files reset", { deviceId });
    } finally {
      await lease.release();
    }
  }

  /**
   * Under the exclusive lease (before the downgrade), on an instance just resumed from
   * `suspended`: kills every command left in it (`killAll`), crashed holders' (`dead`, already
   * claimed) included. Never on the shared path: other holders may be running commands. A gone
   * instance (`SandboxGoneError`) and an abort are thrown (`withSandbox` rebuilds / ends); other
   * failures are only warned.
   */
  private async killLeftovers(
    deviceId: string,
    handle: SandboxHandle,
    p: SandboxProviderEntry,
    signal: AbortSignal,
    dead: string[],
  ): Promise<void> {
    await this.kill(
      deviceId,
      dead.length > 0 ? "takeover" : "resume",
      () => p.impl.killAll(handle, signal),
      signal,
    );
  }

  /**
   * Under the exclusive lease, right after a resume or a (re)build: kills the sessions of the
   * background tasks marked lost while their process may live on (`kill_pending`), in one exec of
   * `pkill -KILL -s <sid>`, then clears their flags. Tasks of another instance have no process
   * here and are only cleared. A gone instance and an abort are thrown; another failure is warned
   * and leaves the flags of this instance's tasks for the next resume.
   */
  private async killPendingTasks(
    deviceId: string,
    handle: SandboxHandle,
    createdAt: number,
    p: SandboxProviderEntry,
    tag: string,
    actor: SandboxActor,
    signal: AbortSignal,
  ): Promise<void> {
    const rows = await this.background.pendingKills(deviceId);
    if (rows.length === 0) return;
    const mine = rows.filter(
      (r): r is typeof r & { sid: string } =>
        r.sandboxCreatedAt?.getTime() === createdAt && r.sid !== null && SID_RE.test(r.sid),
    );
    let cleared = rows;
    if (mine.length > 0) {
      // pkill exits 1 when the session has no process left: only a higher status is a failure
      const command = `rc=0; for sid in ${mine.map((r) => r.sid).join(" ")}; do pkill -KILL -s "$sid"; c=$?; [ "$c" -le 1 ] || rc=$c; done; exit $rc`;
      try {
        const r = await p.impl.exec(handle, {
          command,
          timeoutMs: PENDING_KILL_TIMEOUT_MS,
          maxOutputBytes: 4096,
          signal,
          tag,
          actor,
        });
        if (r.exitCode !== 0) {
          throw new Error(
            `pkill exited with ${r.exitCode === null ? "no status" : r.exitCode}: ${r.stderr.slice(0, 500)}`,
          );
        }
        this.log.info("lost background tasks killed after a sandbox resume", {
          deviceId,
          tasks: mine.map((t) => t.id),
        });
      } catch (err) {
        if (signal.aborted || isSandboxGoneError(err)) throw err;
        this.log.warn("cannot kill lost background tasks after a sandbox resume", {
          deviceId,
          err,
        });
        const kept = new Set(mine.map((r) => r.id));
        cleared = rows.filter((r) => !kept.has(r.id));
      }
    }
    await this.background.clearKill(cleared.map((r) => r.id));
  }

  /**
   * A fenced write: only while the lease holds and the row's generation is still the one read
   * under it (and incremented); otherwise {@link SandboxLockLostError}.
   */
  private async fenced(lease: SandboxLease, id: string, fence: Fence, set: Patch): Promise<Date> {
    if (lease.signal.aborted) throw new SandboxLockLostError(id);
    const r = await this.db
      .updateTable("device_instances")
      .set({ ...set, generation: fence.gen + 1 })
      .where("device_id", "=", id)
      .where("generation", "=", fence.gen)
      .returning("created_at")
      .executeTakeFirst();
    if (!r) throw new SandboxLockLostError(id, "generation");
    fence.gen++;
    return r.created_at;
  }

  /** Sweep candidates: those whose last sweep failed come last, the rest least recently used first. */
  private async candidates(
    due: (eb: ExpressionBuilder<KernelDatabase, "device_instances">) => Expression<SqlBool>,
  ): Promise<{ device_id: string; running_since: Date | null }[]> {
    return await this.db
      .selectFrom("device_instances")
      .select(["device_id", "running_since"])
      .where(due)
      .orderBy(sql`sweep_failed_at ASC NULLS FIRST`)
      .orderBy("last_used_at")
      .limit(SWEEP_BATCH)
      .execute();
  }

  /**
   * One try at the exclusive lease: null → false; else runs `fn`. With `overdue` (past
   * `maxRunningMinutes`) a busy device gets the intent for about a second, so new commands
   * wait briefly and the sweep gets in if the running ones end. Failures are warned, recorded in
   * `sweep_failed_at` (sorted last next time) and return false.
   */
  private async tryLocked(
    deviceId: string,
    fn: (lease: SandboxLease) => Promise<boolean>,
    overdue = false,
  ): Promise<boolean> {
    let lease: SandboxLease | null;
    try {
      lease = await this.leases.tryExclusive(deviceId);
      if (!lease && overdue) {
        lease = await this.leases
          .acquireExclusive(
            deviceId,
            AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS),
            Math.max(this.pollMs * 2, SWEEP_INTENT_WAIT_MS),
            { intent: true },
          )
          .catch((err: unknown) => {
            if (err instanceof ApiError && err.code === "sandbox.busy") return null;
            throw err;
          });
      }
    } catch (err) {
      this.log.warn("cannot take sandbox lock", { deviceId, err });
      return false;
    }
    if (!lease) return false;
    try {
      return await fn(lease);
    } catch (err) {
      this.log.warn("sandbox maintenance failed; will retry", { deviceId, err });
      await this.db
        .updateTable("device_instances")
        .set({ sweep_failed_at: sql<Date>`now()` })
        .where("device_id", "=", deviceId)
        .execute()
        .catch(() => {});
      return false;
    } finally {
      await lease.release();
    }
  }

  /**
   * Under the exclusive lease: make the device's instance run. `gone`: the instance a holder
   * found gone; when it is still the recorded one it is rebuilt, when another holder already
   * rebuilt it the new one is used.
   */
  private async ensure(
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
    held: SandboxLease,
    signal: AbortSignal,
    gone: Instance | null,
    want: SandboxLimits | null,
  ): Promise<{
    handle: SandboxHandle;
    createdAt: number;
    fsResets: number;
    info: EnteredInfo;
    fence: Fence;
    resumed?: boolean;
  }> {
    const id = ctx.deviceId;
    // Only a live device of the caller's org gets a row, with the device's own org; a
    // row made earlier (another use) keeps its file system handle.
    await this.db
      .insertInto("device_instances")
      .columns(["device_id", "org_id", "provider", "status"])
      .expression((eb) =>
        eb
          .selectFrom("devices")
          .select((e) => [
            "devices.id",
            "devices.org_id",
            e.val(p.plugin).as("provider"),
            e.val("creating").as("status"),
          ])
          .where("devices.id", "=", id)
          .where("devices.org_id", "=", ctx.orgId)
          .where("devices.deleted_at", "is", null),
      )
      .onConflict((oc) => oc.column("device_id").doNothing())
      .execute();
    // Under the lease: a use that waited behind destroyDevice (or raced a deletion) must not
    // bring the device's provider resources back.
    const live = await this.db
      .selectFrom("devices")
      .select("id")
      .where("id", "=", id)
      .where("org_id", "=", ctx.orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!live) throw deviceNotFound();
    const row = await this.db
      .selectFrom("device_instances")
      .selectAll()
      .where("device_id", "=", id)
      .executeTakeFirst();
    if (!row) throw deviceNotFound();
    if (row.org_id !== ctx.orgId) throw this.foreign(ctx);
    const fence = { gen: row.generation };
    // Every acquisition first does a fenced increment: an old holder whose lease expired while it
    // kept running (a stalled sweep) then fails its next write.
    await this.fenced(held, id, fence, {});
    if (row.fs_status === "lost") throw deviceFilesLost(p.plugin === LOCAL_PROVIDER);
    if (
      row.provider !== null &&
      row.provider !== p.plugin &&
      (row.fs_status !== "none" || row.handle !== null)
    ) {
      throw otherProvider(row.provider);
    }
    if (
      row.provider !== null &&
      row.provider !== p.plugin &&
      row.fs_status === "none" &&
      row.status === "creating"
    ) {
      // a create by the previous provider ended before its file system was recorded: that
      // provider may have made it by name, and nothing else would ever destroy it
      await this.dropUnrecordedFiles(id, row.provider, signal);
    }
    const handle = row.handle;
    const createdAt = row.created_at.getTime();
    const fsResets = row.fs_resets;
    if (handle && isInstance(row, gone) && row.status === "running") {
      const created = await this.create(ctx, p, held, row, fence, signal, want);
      return { ...created, fsResets, info: { fresh: true, restarted: true }, fence };
    }
    if (handle && row.status === "running") {
      if (want !== null && this.mustApply(row, p, want)) {
        const created = await this.applyLimits(ctx, p, held, row, handle, fence, signal, want);
        if (created) return { ...created, fsResets, info: { fresh: true, restarted: true }, fence };
      }
      return { handle, createdAt, fsResets, info: { fresh: false, restarted: false }, fence };
    }
    if (handle && row.status === "suspended") {
      const r = await p.impl.resume(handle, signal);
      if (r === "resumed") {
        await this.fenced(held, id, fence, {
          status: "running",
          running_since: sql<Date>`now()`,
          suspended_at: null,
          sweep_failed_at: null,
        });
        if (want !== null && this.mustApply(row, p, want)) {
          const created = await this.applyLimits(ctx, p, held, row, handle, fence, signal, want);
          if (created) {
            return { ...created, fsResets, info: { fresh: true, restarted: true }, fence };
          }
        }
        return {
          handle,
          createdAt,
          fsResets,
          info: { fresh: false, restarted: false },
          fence,
          resumed: true,
        };
      }
      this.log.info("sandbox instance is gone at the provider; recreating", {
        deviceId: id,
      });
    }
    const created = await this.create(ctx, p, held, row, fence, signal, want);
    // had_instance only ever becomes true: any earlier instance (even if a rebuild failed since)
    // makes this one a restart on the kept files
    return {
      ...created,
      fsResets,
      info: { fresh: true, restarted: row.had_instance && row.fs_status === "ready" },
      fence,
    };
  }

  /**
   * Under the lease: fenced reset to `creating`, the file system when there is none
   * (`createFileSystem`, its handle written fenced), then the instance on it, then a fenced write
   * of the instance handle. `FileSystemGoneError` from `create` records `fs_status = 'lost'` and
   * throws `device.files_lost`. When the instance handle cannot be written (lease lost), the
   * new instance is destroyed (best effort) before {@link SandboxLockLostError} is thrown.
   */
  private async create(
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
    held: SandboxLease,
    row: Row,
    fence: Fence,
    signal: AbortSignal,
    want: SandboxLimits | null,
  ): Promise<Instance> {
    const id = ctx.deviceId;
    const name = deviceResourceName(id);
    await this.fenced(held, id, fence, {
      org_id: ctx.orgId,
      provider: p.plugin,
      handle: null,
      status: "creating",
      last_used_at: sql<Date>`now()`,
      running_since: null,
      suspended_at: null,
      destroyed_at: null,
      sweep_failed_at: null,
    });
    // the device's effective limits apply at creation (a changed tier or egress mode is applied
    // on use, see applyLimits; other changes reach only instances created afterwards)
    const limits = want ?? (await this.deviceLimits(ctx));
    // the record says what is in force: a provider whose limits are fixed at its file system
    // records them with the file system, any other with the instance (spec §7.1)
    const record = instanceLimitsJson(appliedOf(limits));
    const atFileSystem = p.impl.limitsApplyAt === "fileSystem";
    const cfg = this.config.get().sandbox;
    let fs: FileSystemHandle | null =
      row.fs_status === "ready" && (row.provider === null || row.provider === p.plugin)
        ? row.fs_handle
        : null;
    if (fs === null) {
      fs = await p.impl.createFileSystem({ name, limits, signal });
      // A lost lease fails this write and leaves the file system alone: createFileSystem returns
      // the existing one for a name, so the new holder may already use it, files and all.
      await this.fenced(held, id, fence, {
        provider: p.plugin,
        fs_handle: JSON.stringify(fs),
        fs_status: "ready",
        ...(atFileSystem && { instance_limits: record }),
      });
      this.log.info("device file system created", { deviceId: id, provider: p.plugin });
    }
    let handle: SandboxHandle;
    try {
      handle = await p.impl.create({
        name,
        ...(cfg.image !== undefined && { image: cfg.image }),
        limits,
        fileSystem: fs,
        signal,
      });
    } catch (err) {
      if (!isFileSystemGoneError(err)) {
        if (limits.egress === "open" && !signal.aborted) {
          // spec §5.3: a provider set to refuse open egress (`openEgress: "off"`) fails here
          this.log.warn(
            "the sandbox provider did not create an instance in the open tier; check its openEgress setting or lower sandbox.tiers.max",
            { deviceId: id, provider: p.plugin, err },
          );
        }
        throw err;
      }
      this.log.warn("device file system is gone at the provider; its files are lost", {
        deviceId: id,
        provider: p.plugin,
      });
      await this.fenced(held, id, fence, { fs_status: "lost", status: "none" });
      throw deviceFilesLost(p.plugin === LOCAL_PROVIDER);
    }
    let createdAt: Date;
    try {
      createdAt = await this.fenced(held, id, fence, {
        status: "running",
        handle: JSON.stringify(handle),
        had_instance: true,
        created_at: sql<Date>`now()`,
        running_since: sql<Date>`now()`,
        last_used_at: sql<Date>`now()`,
        ...(!atFileSystem && { instance_limits: record }),
      });
    } catch (e) {
      // Lease lost before the handle was recorded: destroy the new instance (best effort) so it
      // does not leak. A provider that reuses instances by name (Ruling M10) may then hit the one
      // the new holder just resumed or created; that heals: its next provider call throws
      // SandboxGoneError (or resume returns gone) and withSandbox rebuilds in place. The file
      // system is never touched here.
      await p.impl.destroy(handle, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)).catch((err: unknown) =>
        this.log.warn("cannot destroy sandbox created after the lock was lost", {
          deviceId: id,
          err,
        }),
      );
      throw e;
    }
    this.log.info("sandbox created", { deviceId: id, provider: p.plugin });
    return { handle, createdAt: createdAt.getTime() };
  }

  /**
   * Under the exclusive lease, on the running instance `handle` of `row` whose tier or egress
   * mode differs from `want` (sandbox dev tiers spec §7.1): the provider's `update` when it has
   * one; `updated` records `want`. Otherwise (`recreate`, no `update`, or the instance found gone
   * by `update`) the instance is destroyed and created again on the kept files, which records
   * `want` and is returned (the caller reports a restart). A provider whose limits are fixed at
   * its file system is not recreated (that would not apply them): `want` is recorded as
   * `unapplied` and the instance keeps running as is until a file reset.
   */
  private async applyLimits(
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
    held: SandboxLease,
    row: Row,
    handle: SandboxHandle,
    fence: Fence,
    signal: AbortSignal,
    want: SandboxLimits,
  ): Promise<Instance | null> {
    const id = ctx.deviceId;
    const target = appliedOf(want);
    const was = readInstanceLimits(row.instance_limits).applied;
    const facts = { deviceId: id, provider: p.plugin, from: was, to: target };
    let gone = false;
    if (p.impl.update) {
      try {
        if ((await p.impl.update(handle, want, signal)) === "updated") {
          await this.fenced(held, id, fence, { instance_limits: instanceLimitsJson(target) });
          this.log.info("sandbox instance limits updated", facts);
          return null;
        }
      } catch (err) {
        if (!isSandboxGoneError(err)) throw err;
        gone = true;
      }
    }
    if (p.impl.limitsApplyAt === "fileSystem" && !gone) {
      await this.fenced(held, id, fence, { instance_limits: instanceLimitsJson(was, target) });
      this.log.info("sandbox limits changed; they apply when the device's files are reset", facts);
      return null;
    }
    this.log.info("sandbox limits changed; recreating the instance on the kept files", facts);
    if (!gone) {
      try {
        await p.impl.destroy(handle, signal);
      } catch (err) {
        // `create` replaces an instance of the same name anyway
        if (signal.aborted) throw err;
        this.log.warn("cannot destroy the sandbox instance before recreating it", {
          deviceId: id,
          err,
        });
      }
    }
    return await this.create(ctx, p, held, row, fence, signal, want);
  }

  /**
   * Destroys the file system another provider may have made under the device's name without
   * the kernel recording it (`destroyFileSystemByName`; not there is success). That provider not
   * loaded, or a failure, is only warned (the files may leak there) so the device stays
   * usable; an abort is thrown.
   */
  private async dropUnrecordedFiles(
    id: string,
    provider: string,
    signal: AbortSignal,
  ): Promise<void> {
    const old = this.providers.forName(provider)?.impl;
    if (!old) {
      this.log.warn(
        "device file system may have been made by a provider that is not loaded; it may leak",
        { deviceId: id, provider },
      );
      return;
    }
    try {
      await old.destroyFileSystemByName(deviceResourceName(id), signal);
    } catch (err) {
      if (signal.aborted) throw err;
      this.log.warn("cannot destroy the file system of the previous sandbox provider", {
        deviceId: id,
        provider,
        err,
      });
    }
  }

  /**
   * Destroys an instance of another provider with that provider: still loaded and destroyed →
   * false; otherwise warns and returns true (the record must be kept).
   */
  private async retire(
    id: string,
    provider: string,
    handle: SandboxHandle,
    signal: AbortSignal,
  ): Promise<boolean> {
    const old = this.providers.forName(provider)?.impl;
    if (old) {
      try {
        await old.destroy(
          handle,
          AbortSignal.any([signal, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)]),
        );
        return false;
      } catch (err) {
        this.log.warn("cannot destroy sandbox instance of the previous provider", {
          deviceId: id,
          provider,
          err,
        });
        return true;
      }
    }
    this.log.warn(
      "sandbox was created by another provider that is not loaded; its instance may leak",
      { deviceId: id, provider },
    );
    return true;
  }

  /**
   * Under the lease: destroys the row's instance (and a leaked one of an earlier provider). An
   * instance without a handle (a create that ended before the handle was recorded) is destroyed by
   * name. Returns the `prev_*` patch for instances that could not be destroyed.
   */
  private async destroyInstance(
    row: Row,
    p: SandboxProviderEntry,
    signal: AbortSignal,
  ): Promise<Patch> {
    const id = row.device_id;
    const owner = row.provider ?? p.plugin;
    let prev: Patch = {};
    if (row.handle && owner === p.plugin) {
      await p.impl.destroy(row.handle, signal);
    } else if (row.handle && row.status !== "destroyed") {
      if (await this.retire(id, owner, row.handle, signal)) {
        prev = { prev_provider: owner, prev_handle: JSON.stringify(row.handle) };
      }
    } else if (!row.handle && row.status === "creating") {
      // the provider may have built it already: only the name finds it
      const impl = owner === p.plugin ? p.impl : this.providers.forName(owner)?.impl;
      await impl?.destroyByName(deviceResourceName(id), signal);
    }
    if (row.prev_handle && row.prev_provider && !("prev_handle" in prev)) {
      if (!(await this.retire(id, row.prev_provider, row.prev_handle, signal))) {
        prev = { prev_provider: null, prev_handle: null };
      }
    }
    return prev;
  }

  /**
   * Under the lease: destroys the row's file system with the provider that made it (by name when
   * no handle was recorded: `createFileSystem` may have finished before the kernel stopped). With
   * that provider not loaded it throws (the row must stay for a retry), or with `lenient` only
   * warns (the files leak at that provider).
   */
  private async destroyFiles(
    row: Row,
    p: SandboxProviderEntry,
    signal: AbortSignal,
    lenient = false,
  ): Promise<void> {
    const id = row.device_id;
    const owner = row.provider ?? p.plugin;
    const impl = owner === p.plugin ? p.impl : this.providers.forName(owner)?.impl;
    if (!impl) {
      if (row.fs_handle === null) return;
      if (!lenient) {
        throw new Error(
          `cannot destroy the file system of device ${id}: its sandbox provider ${owner} is not loaded`,
        );
      }
      this.log.warn("device file system of a provider that is not loaded is leaked", {
        deviceId: id,
        provider: owner,
      });
      return;
    }
    if (row.fs_handle !== null) await impl.destroyFileSystem(row.fs_handle, signal);
    else await impl.destroyFileSystemByName(deviceResourceName(id), signal);
  }

  /**
   * Under the lease: `instance` destroys the instance and marks the row `destroyed` (the file
   * system stays); `device` also destroys the file system and deletes the row.
   */
  private async destroyRow(
    row: Row,
    p: SandboxProviderEntry,
    held: SandboxLease,
    mode: "instance" | "device",
  ): Promise<void> {
    const id = row.device_id;
    const fence = { gen: row.generation };
    const signal = opSignal(held);
    const prev = await this.destroyInstance(row, p, signal);
    if (mode === "device") await this.destroyFiles(row, p, signal);
    if (!(await held.renew())) throw new SandboxLockLostError(id);
    if (mode === "instance") {
      await this.fenced(held, id, fence, {
        status: "destroyed",
        destroyed_at: sql<Date>`now()`,
        running_since: null,
        sweep_failed_at: null,
        ...prev,
      });
      this.log.info("sandbox instance destroyed", { deviceId: id });
      return;
    }
    const r = await this.db
      .deleteFrom("device_instances")
      .where("device_id", "=", id)
      .where("generation", "=", fence.gen)
      .executeTakeFirst();
    if (Number(r.numDeletedRows) !== 1) throw new SandboxLockLostError(id, "generation");
    this.log.info("device destroyed", { deviceId: id });
  }

  /** Due for suspension: made by this provider, running, and idle or running for too long. */
  private suspendDue(now: Date, plugin: string) {
    const lim = this.config.get().sandbox.limits;
    const idleBefore = new Date(now.getTime() - lim.suspendAfterIdleMinutes * 60_000);
    const runningBefore = new Date(now.getTime() - lim.maxRunningMinutes * 60_000);
    return (eb: ExpressionBuilder<KernelDatabase, "device_instances">) =>
      eb.and([
        eb("status", "=", "running"),
        eb("provider", "=", plugin),
        eb.or([eb("last_used_at", "<", idleBefore), eb("running_since", "<", runningBefore)]),
      ]);
  }

  /** The provider of an instance row: an internal one (`@local`) by name, else the cloud one. */
  private rowProvider(row: Row): SandboxProviderEntry | undefined {
    return providerForDevice(this.providers, row.provider);
  }

  /**
   * A row the idle sweeps may touch: not on a kernel-internal provider (`@local` instances live on
   * people's machines and are never suspended or destroyed for inactivity).
   */
  private cloudRow(eb: ExpressionBuilder<KernelDatabase, "device_instances">): Expression<SqlBool> {
    return eb.or([eb("provider", "is", null), eb("provider", "not like", "@%")]);
  }

  /** The device was deleted, or its org was: the instance and the files go. */
  private deviceGone(
    eb: ExpressionBuilder<KernelDatabase, "device_instances">,
  ): Expression<SqlBool> {
    return eb.or([
      eb.exists(
        eb
          .selectFrom("devices")
          .select("devices.id")
          .whereRef("devices.id", "=", "device_instances.device_id")
          .where("devices.deleted_at", "is not", null),
      ),
      eb.exists(
        eb
          .selectFrom("orgs")
          .select("orgs.id")
          .whereRef("orgs.id", "=", "device_instances.org_id")
          .where("orgs.deleted_at", "is not", null),
      ),
    ]);
  }

  /** Due for instance destruction: an instance (or a create in progress) unused for too long. */
  private instanceDue(now: Date) {
    const days = this.config.get().sandbox.limits.destroyAfterInactiveDays;
    const before = new Date(now.getTime() - days * 24 * 3_600_000);
    return (eb: ExpressionBuilder<KernelDatabase, "device_instances">) =>
      eb.and([
        eb("status", "in", ["creating", "running", "suspended"]),
        eb("last_used_at", "<", before),
      ]);
  }
}
