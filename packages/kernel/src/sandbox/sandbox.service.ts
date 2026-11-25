import { posix } from "node:path";
import {
  DeviceAccessError,
  isDeviceOfflineError,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  parseSandboxBrowseScope,
  parseSandboxExecutionRef,
  parseSandboxOperationScope,
  parseSandboxPreparationScope,
  type SandboxBrowse,
  type SandboxExecutionRef,
  SandboxOperationOutcomeUnknownError,
  SandboxPermissionUnsupportedError,
  type SandboxPreparation,
  type SandboxPreparationScope,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { asPlatform } from "../infra/database/org-scope.js";
import { runOutsideTransaction } from "../infra/database/transaction-host.js";
import {
  createHeldOperations,
  type HeldProvider,
  type ManagedStartArgs,
  withKernelGeneration,
} from "./held-operations.js";
import { SandboxOperationAuthority } from "./operation-authority.js";
import {
  type BackgroundDispatchBinding,
  type OperationFailureKind,
  type OperationInvocation,
  PermissionAdmissionStale,
  type RevokedIncarnation,
  SandboxOperationIntents,
} from "./operation-intents.js";
import { PermissionInstanceWrites, type SupportReport } from "./permission-instance-writes.js";

export type { HeldProvider } from "./held-operations.js";

/**
 * The recorded kind of a definite pre-effect refusal: `not_sent` for a request refused before it
 * was sent (`isDeviceRequestNotSent`; checked before `denied`, which it subclasses), else
 * `denied` or `unsupported`.
 */
const failureKindOf = (error: Error): OperationFailureKind =>
  isDeviceRequestNotSent(error)
    ? "not_sent"
    : isSandboxScopeDeniedError(error)
      ? "denied"
      : "unsupported";

/**
 * A provider found the instance gone before it sent the request (#643): a
 * `DeviceRequestNotSentError` whose `cause` is a `SandboxGoneError`. Nothing ran, so the operation
 * is a definite `not_sent` failure, and the instance is rebuilt like any gone one.
 */
const goneBeforeSent = (error: unknown): boolean =>
  isDeviceRequestNotSent(error) && isSandboxGoneError((error as { cause?: unknown }).cause);

/** The reservation fields a managed start's dispatch must match (its stable input). */
const backgroundBinding = (
  args: ManagedStartArgs,
  instanceId: string,
): BackgroundDispatchBinding => ({
  taskId: args.taskId,
  workingRoot: args.cwd,
  outputPath: args.outputPath,
  retainUntilMs: args.retainUntilMs,
  instanceId,
});

import { randomUUID } from "node:crypto";
import {
  type DeviceFence,
  type DeviceProvider,
  type ExecResult,
  type FileSystemHandle,
  isFileSystemGoneError,
  isSandboxGoneError,
  isSandboxOperationOutcomeUnknownError,
  isStaleFenceError,
  rootsOf,
  type SandboxActor,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxRoots,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import {
  type Expression,
  type ExpressionBuilder,
  type Selectable,
  type SqlBool,
  sql,
  type UpdateObject,
} from "kysely";
import { MANAGED_STOP_GRACE_MS } from "../background/managed.js";
import type { KernelConfig } from "../config/schema.js";
import type { DeviceInstancesTable, KernelDatabase } from "../db/kernel-schema.js";
import { deviceInstanceForeign, deviceUnavailable } from "../devices/access.js";
import { DeviceProviderSelection } from "../devices/device-provider-selection.js";
import { deviceNotFound } from "../devices/errors.js";
import { DialInRelay } from "../dial-in/relay.js";
import { ApiError } from "../errors.js";
import { readSandboxLimitOverride } from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { effectiveSandboxLimits, readOrgSettings } from "../orgs/settings.service.js";
import { isStorageError } from "../runtime/permission-context-errors.js";
import { canonicalJson } from "../tools/canonical-json.js";
import { attachmentsDir } from "./attachments-path.js";
import {
  CloudPermissionSnapshots,
  type CloudSnapshotOutcome,
} from "./cloud-permission-snapshot.js";
import { DeviceReports } from "./device-reports.js";
import type { DeviceSandbox, HostGrantCeiling } from "./device-sandbox.js";
import {
  isKernelReadMethod,
  type KernelReadInvocation,
  KernelReadNotAdmitted,
  KernelReadUnsupported,
} from "./kernel-read.js";
import {
  type SandboxLease,
  SandboxLeases,
  SandboxLockLostError,
  type SandboxPathLease,
  sandboxBusy,
} from "./leases.js";
import { isKnownProvider, LegacyRetirementStore } from "./legacy-retirement.js";
import { ManagedDeviceContextFailed } from "./managed-device-context.js";
import {
  type AppliedLimits,
  appliedLacksHost,
  appliedOf,
  appliedWider,
  type DeviceLimits,
  type EffectiveDevicePolicy,
  installedWider,
  instanceLimitsJson,
  orgEffectiveHosts,
  providerLimits,
  readInstanceLimits,
  sameApplied,
  sameAppliedExact,
  sameAppliedExactly,
} from "./modes.js";
import type { HeldDeviceContextEvidence } from "./permission-context-types.js";
import { PermissionFacts } from "./permission-facts.js";
import { reportOwed, supportOf } from "./permission-runtime-reports.js";
import {
  type DeviceProviderEntry,
  DeviceProviders,
  isInProcessName,
  servesDialIn,
} from "./providers.js";
import { isDeviceRequestNotSent } from "./request-not-sent.js";
import { SandboxProviderUnreachableError } from "./unreachable.js";
import type { SandboxUseContext } from "./use-context.js";

// Moved to leases.ts (phase C); re-exported for existing importers
export {
  SANDBOX_LOCK_PREFIX,
  SANDBOX_LOCK_TTL_MS,
  SandboxLockLostError,
  sandboxBusy,
} from "./leases.js";
export type { SandboxUseContext } from "./use-context.js";

/** Margin (ms) of a holder record's TTL beyond the longest command: by then the in-sandbox limit has ended its commands. */
const HOLDER_TTL_MARGIN_MS = 10 * 60_000;
/** How long the kernel's own read-modify-write of one file waits for another holder's (ms, spec §10.4). */
const PATH_LEASE_WAIT_MS = 30_000;
/** Time limit of one provider call in maintenance (suspend, destroy). */
const SWEEP_OP_TIMEOUT_MS = 120_000;
/** How long a cloud device's lifecycle reconcile waits before the sweep tries it again (B-12). */
const RECONCILE_RETRY_SECONDS = 600;
/**
 * Where the reconcile sweep goes on from for one provider (the last device id it visited; B-12):
 * one cursor per provider, since each provider's rows are swept on their own.
 */
const reconcileCursorKey = (plugin: string): string => `capk:sandbox-reconcile-cursor:${plugin}`;
/** The bound on one cloud `permissionSupport` read under a lifecycle lease (B-15). */
const PERMISSION_SUPPORT_TIMEOUT_MS = 30_000;
/** The bound on one `appliedNetwork` read under a lifecycle lease (issue #766). */
const APPLIED_NETWORK_TIMEOUT_MS = 30_000;
/** How long the suspension sweep holds the intent on a sandbox past `maxRunningMinutes` (ms). */
const SWEEP_INTENT_WAIT_MS = 1000;
/** Rows one sweep handles at most, and the provider calls it runs at once. */
const SWEEP_BATCH = 200;
const SWEEP_CONCURRENCY = 4;
/** How long `destroyDevice` / `resetFileSystem` wait for the exclusive lease (running commands). */
const EXCLUSIVE_WAIT_MS = 10 * 60_000;
/** The time limit of one best-effort maintenance call and of one inline exact revoke (ms). */
const MAINTENANCE_CALL_TIMEOUT_MS = 30_000;
/** How many owed operation revokes a lifecycle holder delivers inline (the revoke jobs do the rest). */
const INLINE_REVOKE_LIMIT = 100;

/** What a silent use caused, kept for the holder's next ordinary use (`SandboxService.deferNotice`). */
interface DeferredNotice {
  /** `<created_at>:<fs_resets>` of the instance it entered. */
  seen: string;
  fresh: boolean;
  restarted: boolean;
  filesReset: boolean;
}

const noticeKey = (deviceId: string, holder: string): string =>
  `capk:sandbox-notice:${deviceId}:${holder}`;

/** A stored {@link DeferredNotice}, or null (none, or not one). */
function parseDeferred(raw: string | null): DeferredNotice | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<DeferredNotice>;
    if (typeof v.seen !== "string") return null;
    return {
      seen: v.seen,
      fresh: v.fresh === true,
      restarted: v.restarted === true,
      filesReset: v.filesReset === true,
    };
  } catch {
    return null;
  }
}

/** The third argument of a use's callback ({@link SandboxService.withOperations} and others). */
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
  /**
   * Kernel-private: what this managed entry holds for the device's model-facing context (the
   * entered provider, the held instance id and generation, its installed binding, its roots and the
   * base working root), present only when the invocation asked for it and the held instance has
   * an installed binding. Never an SDK field, never read from model or tool input.
   */
  contextEvidence?: HeldDeviceContextEvidence;
}

/** {@link SandboxUseInfo} before the roots are read from the handle. */
type EnteredInfo = Omit<SandboxUseInfo, "roots" | "contextEvidence">;

/** The callback of an operation use or a kernel read: every provider call admitted first. */
export type SandboxUseCallback<T> = (
  h: SandboxHandle,
  p: HeldProvider,
  info: SandboxUseInfo,
  signal: AbortSignal,
) => Promise<T>;
/** An entry bound to one route (its invocation or kernel read), as a caller hands it on. */
export type SandboxUseEntry = <T>(
  ctx: SandboxUseContext,
  fn: SandboxUseCallback<T>,
  signal: AbortSignal,
) => Promise<T>;
/**
 * How a use reaches the provider: an operation invocation (every call admitted and claimed), a
 * trusted preparation (staging only), a kernel read or the device service methods (browser use
 * spec §5). There is no raw route.
 */
type UseRoute<T> =
  | { kind: "operations"; invocation: OperationSessionInvocation; fn: SandboxUseCallback<T> }
  | {
      kind: "preparation";
      run: (
        h: SandboxHandle,
        p: DeviceProvider,
        info: SandboxUseInfo,
        signal: AbortSignal,
      ) => Promise<T>;
    }
  | { kind: "kernelRead"; read: KernelReadInvocation; fn: SandboxUseCallback<T> }
  | {
      kind: "services";
      fn: (h: SandboxHandle, p: DeviceServiceMethods, signal: AbortSignal) => Promise<T>;
    };

type Row = Selectable<DeviceInstancesTable>;
type Patch = UpdateObject<KernelDatabase, "device_instances">;
type ExecArgs = Parameters<DeviceProvider["exec"]>[1];
/** The fence read under the lease (incremented by every fenced write). */
interface Fence {
  gen: number;
}

/**
 * The token a lifecycle call carries (device update fencing design §3.2): the generation this
 * holder's own last fenced write committed; null without a fence (nothing to compare).
 */
const tokenOf = (fence: Fence | null): DeviceFence | null =>
  fence === null ? null : { token: fence.gen };

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
 * The provider {@link SandboxService.ifRunning} passes to its callback: every `exec` carries the
 * holder's tag; the caller names the actor.
 */
export type TaggedProvider = Omit<DeviceProvider, "exec"> & {
  exec(h: SandboxHandle, args: Omit<ExecArgs, "tag">): Promise<ExecResult>;
};

/** The device service methods of a provider ({@link SandboxService.withDeviceServices}), bound. */
export type DeviceServiceMethods = Pick<
  DeviceProvider,
  "ensureService" | "stopService" | "serviceRequest" | "openStream"
>;

function serviceMethodsOf(impl: DeviceProvider): DeviceServiceMethods {
  return {
    ...(impl.ensureService && { ensureService: impl.ensureService.bind(impl) }),
    ...(impl.stopService && { stopService: impl.stopService.bind(impl) }),
    ...(impl.serviceRequest && { serviceRequest: impl.serviceRequest.bind(impl) }),
    ...(impl.openStream && { openStream: impl.openStream.bind(impl) }),
  };
}

/** A device held for a stream ({@link SandboxService.holdForStream}). */
export interface StreamHold {
  h: SandboxHandle;
  /** The provider's `openStream`, bound. */
  p: Required<Pick<DeviceProvider, "openStream">>;
  /**
   * Aborts when the caller's signal aborts or the hold ends (a lifecycle change of the device);
   * the hold is then released.
   */
  signal: AbortSignal;
  /** Ends the hold (idempotent): holder record cleared, lease released, `last_used_at` moved. */
  release(): Promise<void>;
}

const streamUnavailable = (
  message = "The device is not running; use a device tool first to start it, then open the stream again.",
): DeviceAccessError => new DeviceAccessError("provider_unavailable", message);

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
  /** The mode and network kind the instance (or its file system) runs with; null = unknown. */
  applied: AppliedLimits | null;
  /** The mode and network kind it should run with now (the device's effective policy). */
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

/**
 * The device's file system is gone at the provider (409); never replaced silently: the device's
 * page resets its files where its provider offers that (its report's `reset`).
 */
export const deviceFilesLost = (): ApiError =>
  new ApiError(
    "device.files_lost",
    "The device's files are gone; reset its files from the devices page to start with an empty workspace.",
  );

/**
 * A cloud sandbox provider refused to make (or move) an instance with the open public network
 * (409; auto mode spec §4.2): a provider that cannot or is set not to offer it. The text is
 * provider-neutral (hardening spec K5); the provider's own error goes only to the log: it may name
 * the provider's settings.
 */
export const sandboxOpenNetworkRefused = (): ApiError =>
  new ApiError(
    "sandbox.open_network_refused",
    "The cloud sandbox provider refused to give this device the open network, so its sandbox was not created. An org admin can switch the organization's cloud network to an allowlist, with the device in sandbox mode (its owner switches it, or the org turns auto mode off), or a super admin can use a sandbox provider that offers the open network.",
  );

/**
 * A cloud sandbox provider failed to make a device's file system or instance for another reason
 * (502): often its deployment config (image, runtime, network), sometimes a passing fault. The
 * provider's own error goes only to the log.
 */
export const sandboxCreateFailed = (): ApiError =>
  new ApiError(
    "sandbox.create_failed",
    "The cloud sandbox provider could not create this device's sandbox. Retry; if it keeps failing, a super admin should check the sandbox extension's settings.",
  );

/**
 * What a failed `createFileSystem` / `create` / `update` of a cloud provider becomes: an abort,
 * a gone error, an unreachable provider and a kernel error stay as they are (their callers and the
 * tools handle them); any other error is logged (warn, redacted) and replaced by
 * {@link sandboxOpenNetworkRefused} when `limits` ask for the open public network (the only
 * network a provider's config refuses), else (a create) by {@link sandboxCreateFailed}; a failed
 * `update` below the open network stays as it is. A dial-in device that is offline keeps its
 * error (the tools tell the person to connect its machine).
 */
function providerRefusal(
  log: Pick<KernelLogger, "warn">,
  err: unknown,
  facts: { deviceId: string; provider: string; op: "createFileSystem" | "create" | "update" },
  limits: SandboxLimits,
  signal: AbortSignal,
): unknown {
  if (
    signal.aborted ||
    isDeviceOfflineError(err) ||
    isSandboxGoneError(err) ||
    isFileSystemGoneError(err) ||
    err instanceof SandboxProviderUnreachableError ||
    err instanceof ApiError
  ) {
    return err;
  }
  // a provider that refuses the open network fails on it in either mode: auto always has it, a
  // narrowed cloud device has it while the org's network is open
  if (limits.network.kind === "open-public") {
    log.warn(
      "the sandbox provider refused an instance with the open public network; check the provider's network settings or switch the org's cloud network to the allowlist",
      { ...facts, err },
    );
    return sandboxOpenNetworkRefused();
  }
  if (facts.op === "update") return err;
  log.warn("the sandbox provider failed to create a device's sandbox", { ...facts, err });
  return sandboxCreateFailed();
}

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
  impl: DeviceProvider,
  tag: string,
  actor: SandboxActor | undefined,
  before: () => Promise<void>,
): P {
  const wrapped = Object.create(impl) as DeviceProvider;
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
 * - a loaded provider plugin refuses the open public network (`refuseOpenNetwork: true` in its
 *   startup config; one line per such provider) while an org can be on it: auto mode always is, and a sandbox-mode cloud device
 *   keeps its org's cloud network, open by default, so turning auto mode off does not avoid it
 *   (auto mode hardening spec K3). Only the kill switch (`sandbox.limits.egress: none`) does.
 * - `sandbox.limits.orgHosts: within` while the startup config does not turn auto mode off: the
 *   ceiling limits sandbox mode only, and auto mode (the default of every device) keeps the open
 *   network (org egress ceiling spec §D2). The admin console's runtime choice is not seen here.
 * No run duration limit (`runtime.maxRunSeconds` 0, the default) cuts no command, so there is
 * nothing to tell.
 */
export function sandboxConfigWarnings(
  cfg: Pick<KernelConfig, "runtime" | "sandbox" | "extensionConfig"> &
    Partial<Pick<KernelConfig, "devices">>,
  providerPlugins: readonly string[] = [],
): { level: "warn"; message: string }[] {
  const out: { level: "warn"; message: string }[] = [];
  for (const providerPlugin of cfg.sandbox.limits.egress !== "none" ? providerPlugins : []) {
    const pc = cfg.extensionConfig[providerPlugin] as { refuseOpenNetwork?: unknown } | undefined;
    if (pc?.refuseOpenNetwork === true) {
      out.push({
        level: "warn",
        message: `extensionConfig."${providerPlugin}".refuseOpenNetwork is true: the ${providerPlugin} plugin refuses cloud devices on the open public network, which every device uses whose network is open (devices.network.default, open by default, and an organization's deviceNetwork); set refuseOpenNetwork to false, or set devices.network.ceiling to allowlist`,
      });
    }
  }
  if (
    cfg.sandbox.limits.orgHosts === "within" &&
    cfg.sandbox.limits.egress !== "none" &&
    cfg.devices?.network?.ceiling !== "allowlist"
  ) {
    out.push({
      level: "warn",
      message:
        "sandbox.limits.orgHosts is within but devices.network.ceiling is not allowlist: the platform allowlist limits the hosts of the allowlist only; devices on the open network (the default) still reach any public host. Set devices.network.ceiling to allowlist (or in the admin console) for a hard ceiling",
    });
  }
  const run = cfg.runtime.maxRunSeconds;
  const cmd = cfg.sandbox.limits.maxCommandSeconds;
  if (run > 0 && run < cmd) {
    out.push({
      level: "warn",
      message: `runtime.maxRunSeconds (${run}) is less than sandbox.limits.maxCommandSeconds (${cmd}): sandbox commands are limited to the time left in the run, so commands longer than about ${run} seconds cannot finish; raise runtime.maxRunSeconds to at least ${cmd} if agents need long commands`,
    });
  }
  return out;
}

/** No device to run on: none bound and none can be made (no device provider on in the org; 503). */
export const sandboxUnavailable = (): ApiError =>
  new ApiError(
    "sandbox.unavailable",
    "No device provider is on in this organization; ask an org admin to switch one on",
  );

/**
 * An owner browse found no running instance of the device (409): the picker starts the device
 * for its owner first ({@link SandboxService.ensureRunningForOwner}), so this is an instance that
 * stopped in between (idle suspension) or one that could not be started; retrying starts it.
 */
export const deviceNotRunning = (): ApiError =>
  new ApiError(
    "device.not_running",
    "The device stopped before it could be read. Try again; it will be started first.",
  );

/** The holder name of {@link SandboxService.ensureRunningForOwner}: no conversation holds it. */
const OWNER_START_HOLDER = "device-owner";

/**
 * The device's old instance incarnation may still run legacy work that was never retired (503):
 * the device stays unavailable until the provider confirms that incarnation destroyed, or for
 * good when it is quarantined (permission runtime cutover 8.5). Never a retirement claim.
 */
export class RetirementPendingError extends ApiError {
  override name = "RetirementPendingError";
}
export const retirementPending = (): ApiError =>
  new RetirementPendingError(
    "device.unavailable",
    "This device is unavailable: background work started by an earlier version may still run on its previous instance, and that instance has not been confirmed destroyed. A cloud device becomes usable once its provider confirms the old instance destroyed.",
  );
/**
 * A cloud device's earlier instance may still run legacy work and no evidence the kernel can get
 * will ever cover it (an incarnation replaced without a recorded confirmed destruction, or an
 * unknown one it cannot clear) (503, 8.5): the owner deletes the device and creates it again.
 */
export const recreateRequired = (): ApiError =>
  new RetirementPendingError(
    "device.recreate_required",
    "Background work started by an earlier version may still be running on an earlier instance of this device, and that instance can no longer be verified as destroyed. Delete this device and create it again.",
  );
const isRetirementPending = (err: unknown): boolean => err instanceof RetirementPendingError;

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
 * The kernel's sandbox service over the `device-provider@1` provider, keyed by **device** (spec
 * 2026-11-07-environments-design §4.2, §5.1): one file system kept until the device is
 * deleted, plus one instance attached to it that comes and goes; all conversations bound to the
 * device (and their sub-agents) share both.
 *
 * - **Lazy creation**: the first use ({@link withOperations} and the others) creates the file
 *   system (`createFileSystem`, name `cap-device-<deviceId>`) and then the instance on it; state
 *   lives in `device_instances`. A file system gone at the provider is never replaced silently:
 *   `fs_status` becomes `lost` and uses fail with `device.files_lost` until
 *   {@link resetFileSystem}.
 * - **Leases** (phase C, spec §10, {@link SandboxLeases}), keyed by device id: using an
 *   instance recorded `running` with the device's provider takes a **shared** lease, so up to
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
 * - **Takeover** (spec §10.5; permission runtime cutover B-1): every holder records itself in
 *   `capk:sandbox-holders:<env>` (again before each `exec`), and the operations it admits carry
 *   its lease token as their holder. An acquirer that finds a record without a live lease (a
 *   crashed holder) revokes exactly that holder's operations, never by a broad kill: the
 *   revocation is owed durably (an outbox row per token) before the record is forgotten, runs
 *   inline, and the owed operation revokes of the instance are delivered by operation id. Under
 *   the exclusive lease, on an instance just resumed from `suspended` (nobody else holds it; a
 *   provider that keeps memory across a pause brings old work back), every started-or-unknown
 *   operation of that generation is revoked too, before the row says running. Nothing is ever
 *   `killAll`ed or `killTagged`. Inline delivery failures are only warned: the revoke jobs keep
 *   them owed.
 * - **Instance identity**: a holder that hits `gone` names the instance by its handle and the
 *   row's `created_at` (set by the fenced write after each `create`); the handle alone is the same
 *   after a rebuild on providers whose handle is the instance name (sandbox-docker).
 *
 * - **Provider per device** (device-provider spec §6.1): a device is bound to its provider
 *   (`devices.provider`, fixed at creation) for life, resolved at every call
 *   ({@link DeviceProviders.forDevice}), the same way for every provider (a dial-in one reaches its
 *   machine through the generic channel inside its own calls). Several
 *   providers serve one org side by side. A use needs the provider loaded **and** on in the
 *   device's org ({@link DeviceProviderSelection.isOnInOrg}); otherwise, and for an instance row
 *   naming another provider, the use fails `device.unavailable` (503) and nothing changes: the
 *   files and instance stay, nothing is demoted, recreated or moved to another provider.
 *   Lifecycle cleanup (destroy, sweeps, reset) only needs the provider loaded. The sweeps run
 *   per provider over its own rows; rows of a provider that is not loaded are never touched.
 *
 * No in-process state: replicas share it through PG and Redis.
 */
/** Available only to kernel staging callbacks, never to a held user-operation callback. */
export interface SandboxStaging {
  prepare<T>(
    purpose: SandboxPreparationScope["purpose"],
    roots: readonly string[],
    fn: (p: SandboxPreparation, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}
export type OperationSessionInvocation = Omit<OperationInvocation, "ordinal"> & {
  /** Read the held {@link SandboxUseInfo.contextEvidence} once after entry (managed route). */
  contextEvidence?: true;
  beforeUser?: (
    staging: SandboxStaging,
    info: SandboxUseInfo,
    signal: AbortSignal,
  ) => Promise<void>;
};

/**
 * Lifecycle work on an instance row runs only with the row's own provider (a device is bound to
 * its provider for life; an instance row of another provider is never written by this kernel).
 */
function assertOwnRow(row: Row, p: DeviceProviderEntry): void {
  if (row.provider !== null && row.provider !== p.plugin) {
    throw new Error(
      `device ${row.device_id}: its instance row belongs to ${row.provider}, not ${p.plugin}`,
    );
  }
}

@Injectable()
export class SandboxService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    /** The record of the instance each holder last used (`capk:sandbox-seen:…`). */
    @Inject(REDIS) private readonly redis: Pick<Redis, "get" | "set" | "getdel">,
    @Inject(SandboxLeases) private readonly leases: SandboxLeases,
    /** The providers (read at every call: providers are ready after the extension load). */
    @Inject(DeviceProviders)
    private readonly providers: Pick<DeviceProviders, "forDevice" | "loaded" | "all">,
    /** Whether a device's provider serves its org now (read at every use, never cached). */
    @Inject(DeviceProviderSelection)
    private readonly selection: Pick<DeviceProviderSelection, "isOnInOrg">,
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info" | "warn">,
    @Inject(PermissionFacts)
    private readonly facts: Pick<
      PermissionFacts,
      | "devicePolicy"
      | "assertCloudReconciled"
      | "readHeldEnvironment"
      | "readDevice"
      | "deviceSandbox"
      | "deviceSandboxFacts"
      | "orgHostGrantCeiling"
    >,
    @Inject(SandboxOperationIntents) private readonly operationIntents: SandboxOperationIntents,
    @Inject(SandboxOperationAuthority) private readonly authority: SandboxOperationAuthority,
    @Inject(PermissionInstanceWrites) private readonly instanceWrites: PermissionInstanceWrites,
    /** The retirement obligations every lifecycle acquisition is gated on (8.5). */
    @Inject(LegacyRetirementStore)
    private readonly retirement: Pick<
      LegacyRetirementStore,
      | "unresolved"
      | "hasUnresolved"
      | "scanUntilStable"
      | "frozen"
      | "frozenAt"
      | "quarantine"
      | "noteFailure"
      | "resolveDestroyed"
      | "resolveCancelled"
      | "membersOf"
      | "recordDestruction"
      | "destructionRecorded"
    >,
    /** The cloud snapshot writer's reconcile, for the lifecycle reconcile of marked devices (B-12). */
    @Inject(CloudPermissionSnapshots)
    private readonly snapshots: Pick<CloudPermissionSnapshots, "reconcileHeld">,
    /** The stored device report, refreshed after a create or a resume (never fails the use). */
    @Inject(DeviceReports) private readonly reports: Pick<DeviceReports, "refresh">,
    /**
     * The dial-in relay: a dial-in provider's device whose machine is not connected refuses a new
     * operation before its dispatch is recorded (absent in hand-built services: not checked).
     */
    @Optional()
    @Inject(DialInRelay)
    private readonly relay?: Pick<DialInRelay, "connection">,
  ) {}

  /** Poll interval while waiting for a lease (the leases' own). */
  private get pollMs(): number {
    return this.leases.pollMs;
  }

  /**
   * Whether the device of `orgId` can be used now: its provider is loaded and on in the org
   * ({@link DeviceProviderSelection.isOnInOrg}). A missing device, one of
   * another org or one without a provider is not.
   */
  async availableFor(deviceId: string, orgId: string): Promise<boolean> {
    const provider = await this.deviceProvider(deviceId, orgId);
    return provider != null && (await this.selection.isOnInOrg(orgId, provider));
  }

  /**
   * Whether the provider the device is bound to is loaded here, whatever
   * its org says: for lifecycle work that goes on while the org has the provider off (owed
   * revocations, cleanup).
   */
  async providerLoaded(deviceId: string): Promise<boolean> {
    return (await this.providerOf(deviceId)) !== undefined;
  }

  /**
   * The device's `devices.provider` (null: none recorded; undefined: no such device, or one of
   * another org with `orgId`).
   */
  private async deviceProvider(
    deviceId: string,
    orgId?: string,
  ): Promise<string | null | undefined> {
    const row = await this.db
      .selectFrom("devices")
      .select("provider")
      .where("id", "=", deviceId)
      .$if(orgId !== undefined, (q) => q.where("org_id", "=", orgId as string))
      .executeTakeFirst();
    return row === undefined ? undefined : row.provider;
  }

  /**
   * The loaded provider the device is bound to (no org check: lifecycle work and reads that
   * need no use); undefined when the device is missing, has none or its provider is not loaded.
   */
  private async providerOf(
    deviceId: string,
    orgId?: string,
  ): Promise<DeviceProviderEntry | undefined> {
    return this.providers.forDevice((await this.deviceProvider(deviceId, orgId)) ?? null);
  }

  /**
   * The provider a use of the device of `orgId` runs on: loaded and on in the org, else
   * `device.unavailable` (503, files kept); a missing device or one of another org is
   * `device.not_found`.
   */
  private async require(deviceId: string, orgId: string): Promise<DeviceProviderEntry> {
    const provider = await this.deviceProvider(deviceId, orgId);
    if (provider === undefined) throw deviceNotFound();
    const p = this.providers.forDevice(provider);
    if (!p || !(await this.selection.isOnInOrg(orgId, p.plugin))) throw deviceUnavailable(provider);
    return p;
  }

  /**
   * The loaded provider for lifecycle work on the device (no org check: cleanup and maintenance
   * go on while its org has the provider off), else `device.unavailable`; a missing device is
   * `device.not_found`.
   */
  private async loadedFor(deviceId: string): Promise<DeviceProviderEntry> {
    const provider = await this.deviceProvider(deviceId);
    if (provider === undefined) throw deviceNotFound();
    const p = this.providers.forDevice(provider);
    if (!p) throw deviceUnavailable(provider);
    return p;
  }

  /** Concurrent holders of one device (`sandbox.maxConcurrentCommands`, read at every use). */
  private get cap(): number {
    return this.config.get().sandbox.maxConcurrentCommands;
  }

  /**
   * The effective device policy of a device (auto mode spec §4.3): the platform's switch and the
   * org's settings with the device's own mode (a missing device has none). Without `deviceId`:
   * an org-level policy with no choice.
   */
  async devicePolicy(device: { orgId: string; deviceId?: string }): Promise<EffectiveDevicePolicy> {
    return this.facts.devicePolicy(device);
  }

  /** The device's per-call host grant ceiling (`PermissionFacts.readDevice`). */
  async hostGrantCeiling(device: { orgId: string; deviceId: string }): Promise<HostGrantCeiling> {
    return (await this.facts.readDevice(device.orgId, device.deviceId)).hostCeiling;
  }

  /**
   * The device's effective sandbox limits (spec §8.4; auto mode spec §4.2), the same for every
   * provider: the deployment's `sandbox.limits` resources, cpu / memory per the super admin's org
   * override (C19 / Ruling M16), the effective mode and the device's sandbox network
   * ({@link devicePolicy}: its own `devices.network_*` within the platform's and the org's
   * ceilings). An operation-boundary provider also gets each operation's network in its scope.
   * `opts.policy`: what the caller already read (avoids the policy queries).
   */
  async deviceLimits(
    device: { orgId: string; deviceId?: string },
    opts: { policy?: EffectiveDevicePolicy } = {},
  ): Promise<DeviceLimits> {
    const cfg = this.config.get().sandbox;
    const [policy, override] = await Promise.all([
      opts.policy ?? this.devicePolicy(device),
      readSandboxLimitOverride(this.db.db, device.orgId),
    ]);
    return effectiveSandboxLimits(
      {
        cpu: cfg.limits.cpu,
        memoryMb: cfg.limits.memoryMb,
        diskMb: cfg.limits.diskMb,
        mode: policy.mode,
        network: { kind: policy.network.kind, hosts: [...policy.network.hosts] },
      },
      override,
    );
  }

  /**
   * The org's limits for a standing network grant (a scheduled task's grant, a network approval):
   * {@link deviceLimits} with the org's per-call host ceiling as an allowlist (`hostGrantCeiling`
   * with no device). Where that ceiling is bounded by the kernel only (`any`, which an allowlist
   * cannot carry with its exclusions), the org's effective hosts: a standing grant never reaches
   * past what the org lists. A device's own layers narrow it further at each exec.
   */
  async ceilingLimits(orgId: string): Promise<SandboxLimits> {
    const [ceiling, override, { deviceNetwork: org }] = await Promise.all([
      this.facts.orgHostGrantCeiling(orgId),
      readSandboxLimitOverride(this.db.db, orgId),
      readOrgSettings(this.db.db, orgId),
    ]);
    const cfg = this.config.get().sandbox;
    return effectiveSandboxLimits(
      {
        cpu: cfg.limits.cpu,
        memoryMb: cfg.limits.memoryMb,
        diskMb: cfg.limits.diskMb,
        network: {
          kind: "allowlist",
          hosts: ceiling.kind === "any" ? orgEffectiveHosts(cfg.limits, org) : [...ceiling.hosts],
        },
      },
      override,
    );
  }

  /**
   * What a network ask may offer on the device (device-provider spec §6.3): why a per-call host
   * grant is unavailable (`hostGrantRefusal`; null: grantable), why a host cannot join the
   * device's own list (`deviceListAddRefusal`), whether it has a list of its own (`ownList`) and
   * its hosts (`ownHosts`),
   * where its provider applies new limits (`limitsApplyAt`) and its sandbox (`box.perCallHosts`:
   * the provider's per-operation hosts).
   */
  async hostRefusal(device: { orgId: string; deviceId: string }): Promise<{
    refusal: (host: string) => string | null;
    listAddRefusal: (host: string) => string | null;
    box: DeviceSandbox;
    ownList: boolean;
    ownHosts: string[];
    limitsApplyAt: "instance" | "fileSystem" | undefined;
  }> {
    const facts = await this.facts.deviceSandboxFacts(device.orgId, device.deviceId);
    return {
      refusal: facts.refusal,
      listAddRefusal: facts.listAddRefusal,
      box: facts.box,
      ownList: facts.ownList,
      ownHosts: facts.ownHosts,
      limitsApplyAt: facts.limitsApplyAt,
    };
  }

  /**
   * The limits state of a device's instance for its page (auto mode spec §4.2), read without a
   * lease: `applied` is what the instance or file system was made with or updated to (null:
   * unknown, or no instance yet), `effective` what it should run with now.
   * `pendingNextUse`: a cloud instance exists and differs; its next use applies the new limits
   * (files kept). `pendingFilesReset`: the provider fixes limits at its file system
   * (`limitsApplyAt: "fileSystem"`) and cannot `update` them, so only a file reset applies them.
   * `opts.policy`: the device's effective policy when the caller already
   * read it ({@link devicePolicy}).
   */
  async limitsState(
    device: { orgId: string; deviceId: string },
    opts: { policy?: EffectiveDevicePolicy } = {},
  ): Promise<DeviceLimitsState> {
    const [policy, row, p] = await Promise.all([
      opts.policy ?? this.devicePolicy(device),
      this.db
        .selectFrom("device_instances")
        .select(["provider", "status", "handle", "fs_status", "instance_limits"])
        .where("device_id", "=", device.deviceId)
        .where("org_id", "=", device.orgId)
        .executeTakeFirst(),
      this.providerOf(device.deviceId, device.orgId),
    ]);
    const effective = appliedOf({
      mode: policy.mode,
      network: policy.network,
    });
    if (p === undefined || row === undefined) {
      return { applied: null, effective, pendingNextUse: false, pendingFilesReset: false };
    }
    const rec = readInstanceLimits(row.instance_limits);
    // what mustApply applies at the next use: another kind, a host the instance allows that the
    // desired list does not (a narrowing), or a desired host it lacks (a host added to a list)
    const differs =
      row.provider === p.plugin &&
      (!sameApplied(rec.applied, effective) ||
        appliedWider(rec.applied, effective) ||
        appliedLacksHost(rec.applied, effective));
    const fsBound = differs && row.fs_status === "ready" && this.fsBound(p, rec, effective);
    const hasInstance =
      row.handle !== null && (row.status === "running" || row.status === "suspended");
    // an update the kernel never heard back from is applied again at the next use (§7.2)
    const inFlight = row.provider === p.plugin && rec.pending !== null;
    return {
      applied: rec.applied,
      effective,
      pendingNextUse: ((differs && !fsBound) || inFlight) && hasInstance,
      pendingFilesReset: fsBound,
    };
  }

  /**
   * Whether a provider whose limits are fixed at its file system cannot apply `effective`
   * without a file reset: it has no `update`, or its `update` already answered `recreate` for it.
   */
  private fsBound(
    p: DeviceProviderEntry,
    rec: ReturnType<typeof readInstanceLimits>,
    effective: AppliedLimits,
  ): boolean {
    if (p.impl.limitsApplyAt !== "fileSystem") return false;
    return p.impl.update === undefined || sameApplied(rec.unapplied, effective);
  }

  /**
   * Whether the running instance of `row` must get `want` before use (auto mode spec §4.2): a
   * cloud instance whose recorded network kind differs (never the mode alone), whose recorded
   * limits are more permissive than `want` in any dimension (a host-only narrowing too, spec
   * §124), or whose recorded allowlist lacks a host `want` allows (a host added to the device's or
   * the org's list, device-provider spec §6.3; applied once, then recorded), unless only a file
   * reset could apply it ({@link fsBound}). A provider bound to its file system still goes through
   * the exclusive lease once for a narrowing, so `applyLimits` records it as `unapplied` (the
   * device is then unprobed until the reset, never silently supported); an added host there only
   * waits for the reset (`pendingFilesReset`).
   *
   * A recorded `pending` (an `update` sent and never answered, device update fencing design §7.2)
   * always applies again, even when `applied` already matches `want`: the instance may enforce
   * the in-flight target, and only a newer call with this holder's higher token settles it.
   */
  private mustApply(row: Row, p: DeviceProviderEntry, want: DeviceLimits): boolean {
    const rec = readInstanceLimits(row.instance_limits);
    if (rec.pending !== null) return true;
    const target = appliedOf(want);
    const wider = appliedWider(rec.applied, target);
    if (sameApplied(rec.applied, target) && !wider && !appliedLacksHost(rec.applied, target))
      return false;
    if (!this.fsBound(p, rec, target)) return true;
    return wider && !sameAppliedExact(rec.unapplied, target);
  }

  /**
   * Under the exclusive lease, at a lifecycle step on the instance `handle` of `row` (issue #766):
   * whether the network the provider reports it enforces (`appliedNetwork`) may allow more than
   * the recorded limits ({@link installedWider}), so the desired limits must be applied again even
   * though the record matches them. It closes the residual of a provider whose `update` cannot
   * honor the fence: a stale holder's late `update` that landed after the newer holder's. Only a
   * provider with both `update` and `appliedNetwork` is asked. An unknown answer, a failed read or
   * an abort counts as wider (fail closed: applying the desired limits never widens anything).
   * Never throws.
   */
  private async installedNetworkWider(
    id: string,
    p: DeviceProviderEntry,
    row: Row,
    handle: SandboxHandle,
    signal: AbortSignal,
    want: DeviceLimits,
  ): Promise<boolean> {
    const read = p.impl.appliedNetwork?.bind(p.impl);
    if (!read || !p.impl.update) return false;
    const recorded = readInstanceLimits(row.instance_limits).applied;
    let installed: unknown;
    try {
      const sig = AbortSignal.any([signal, AbortSignal.timeout(APPLIED_NETWORK_TIMEOUT_MS)]);
      installed = await read(handle, sig);
    } catch (err) {
      if (!signal.aborted)
        this.log.warn(
          "cannot read the instance's installed network; applying the desired limits again",
          { deviceId: id, provider: p.plugin, err },
        );
      return true;
    }
    try {
      const wider = installedWider(installed, recorded, appliedOf(want));
      if (wider) {
        const kind =
          typeof installed === "object" && installed !== null
            ? (installed as { kind?: unknown }).kind
            : null;
        this.log.warn(
          "the instance's installed network allows more than its record; applying again",
          {
            deviceId: id,
            provider: p.plugin,
            recorded: recorded?.network.kind ?? null,
            installed: typeof kind === "string" ? kind : typeof kind,
          },
        );
      }
      return wider;
    } catch {
      // a malformed answer the comparison cannot read (a sparse host list, say): fail closed
      return true;
    }
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
   * suspended; null otherwise. Read without a lease: a caller inside a use reads the
   * instance its own lease keeps.
   */
  async currentInstance(
    deviceId: string,
  ): Promise<{ createdAt: Date; provider: string | null } | null> {
    // org-filter: deviceId is the device its caller already resolved in its org (the tool's bound
    // device); the instance row is keyed by its device
    const row = await this.db
      .selectFrom("device_instances")
      .select(["status", "handle", "created_at", "provider"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    if (!row || row.handle === null) return null;
    if (row.status !== "running" && row.status !== "suspended") return null;
    return { createdAt: row.created_at, provider: row.provider };
  }

  /**
   * Runs `fn` on the device's instance only while it runs the instance created at
   * `instance.createdAt` (background tasks, spec 2026-11-05-background-bash-design §4.3). It never
   * creates, resumes or rebuilds one: an instance that is missing, suspended, being created or
   * destroyed (or recorded with another provider) is `not_running`, one that records another
   * instance is `other_instance`. Otherwise `fn` runs under a shared lease, as a use's
   * holder does (crashed holders' operations revoked exactly), with its tag on every exec, and
   * `last_used_at` moves forward when it ends. Waits for the lease up to `sandbox.lockWaitSeconds`
   * (`sandbox.busy`); `signal` (optional) ends the wait with its abort reason. The signal passed
   * to `fn` aborts with `signal` or when the lease is lost. Errors of `fn` (`SandboxGoneError`
   * too) are thrown as they are.
   */
  async ifRunning<T>(
    deviceId: string,
    /**
     * `exactRef`: an exact-ref managed drain (status, stop, the revoke worker), allowed on an
     * incarnation under a retirement obligation; every other caller (legacy SID polls, stops and
     * reads, staged browse) is refused there with a {@link RetirementPendingError} (8.5).
     */
    instance: { createdAt: Date; exactRef?: boolean },
    fn: (p: TaggedProvider, h: SandboxHandle, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<IfRunningResult<T>> {
    return this.ifRunningAs(deviceId, instance, fn, signal, false);
  }

  /**
   * {@link ifRunning}; `use` (staged owner browse) also refuses a device carrying the B1
   * reconcile marker under the shared lease, before any provider call (B-11).
   */
  private async ifRunningAs<T>(
    deviceId: string,
    instance: { createdAt: Date; exactRef?: boolean },
    fn: (p: TaggedProvider, h: SandboxHandle, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    use: boolean,
  ): Promise<IfRunningResult<T>> {
    const p = await this.loadedFor(deviceId);
    const env = deviceId;
    const deadline = Date.now() + this.config.get().sandbox.lockWaitSeconds * 1000;
    const token = randomUUID();
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      // org-filter: deviceId comes from an org-scoped background task row or a kernel-written
      // operation intent, never caller input; the instance row is keyed by its device
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
      // an incarnation that may still run unretired legacy work: no SID signal, no new exec or
      // admission there; only exact-ref managed drains go on (I1)
      if (!instance.exactRef && (await this.retirement.hasUnresolved(env)))
        throw retirementPending();
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
          !instance.exactRef,
          use ? "reconciled" : "none",
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
   * Holds the device's running instance for a stream to one of its services (browser use spec
   * §6.2: an open viewer counts as device use). It never creates, resumes or rebuilds an
   * instance: a device without a running instance, whose provider is off in `orgId`, or that is
   * in a lifecycle change (an exclusive lease or a pending intent) is refused with
   * `DeviceAccessError("provider_unavailable")`; a provider without `openStream` with
   * `capability_missing`.
   *
   * A hold is not a lease ({@link SandboxLeases.streamHold}): it takes no
   * `sandbox.maxConcurrentCommands` slot and never blocks a lifecycle change. Idle suspension and
   * the inactivity destruction (on any replica) skip a device with a live hold; the forced
   * suspension after `maxRunningMinutes` does not. A hold yields to every lifecycle change:
   * an exclusive acquisition ends the device's holds, and a pending intent makes their next
   * renewal fail, so the returned `signal` aborts (also when the caller's `signal` aborts or a
   * renewal deadline passes) and the hold is released. `release()` is idempotent and moves
   * `last_used_at` forward, so the idle clock starts when the viewer goes.
   */
  async holdForStream(deviceId: string, orgId: string, signal: AbortSignal): Promise<StreamHold> {
    signal.throwIfAborted();
    let p: DeviceProviderEntry;
    try {
      p = await this.require(deviceId, orgId);
    } catch (err) {
      if (err instanceof ApiError && err.code === "device.unavailable")
        throw streamUnavailable(err.message);
      if (err instanceof ApiError && err.code === "device.not_found")
        throw new DeviceAccessError("no_device", err.message);
      throw err;
    }
    const impl = p.impl;
    if (!impl.openStream)
      throw new DeviceAccessError(
        "capability_missing",
        "This device's provider cannot open streams to device services; choose a device on a provider that supports them.",
      );
    const row = () =>
      this.db
        .selectFrom("device_instances")
        .selectAll()
        .where("device_id", "=", deviceId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
    const before = await row();
    if (!before || !this.usable(before, p, null)) throw streamUnavailable();
    const lease = await this.leases.streamHold(deviceId);
    if (!lease) throw streamUnavailable();
    // read again after the hold is recorded: a lifecycle change that finished before it was
    // recorded shows in the row; one that starts later ends the hold
    let after: Row | undefined;
    try {
      after = await row();
    } catch (err) {
      await lease.release();
      throw err;
    }
    if (
      !after ||
      !this.usable(after, p, null) ||
      after.created_at.getTime() !== before.created_at.getTime()
    ) {
      await lease.release();
      throw streamUnavailable();
    }
    // an open viewer is device use: its last use moves when the hold is taken and when it ends
    const touch = () =>
      this.db
        .updateTable("device_instances")
        .set({ last_used_at: sql<Date>`GREATEST(last_used_at, now())` })
        .where("device_id", "=", deviceId)
        .where("org_id", "=", orgId)
        .where("status", "=", "running")
        .execute()
        .then(
          () => undefined,
          (err: unknown) => this.log.warn("cannot update sandbox last_used_at", { deviceId, err }),
        );
    await touch();
    const sig = AbortSignal.any([signal, lease.lost]);
    let released: Promise<void> | undefined;
    const onAbort = () => void release();
    const release = (): Promise<void> => {
      released ??= (async () => {
        sig.removeEventListener("abort", onAbort);
        await lease.release();
        await touch();
      })();
      return released;
    };
    sig.addEventListener("abort", onAbort, { once: true });
    if (sig.aborted) {
      await release();
      throw abortReason(sig);
    }
    return {
      h: after.handle as SandboxHandle,
      p: { openStream: impl.openStream.bind(impl) },
      signal: sig,
      release,
    };
  }

  /**
   * Runs `fn` with the device service methods of the device's provider (browser use spec §5),
   * as any use of the device does ({@link withSandbox}: the instance is created or resumed,
   * `last_used_at` moves forward). `admit` sees the provider's methods first, before any lease
   * or instance work, so a provider without services is refused without touching the device.
   */
  async withDeviceServices<T>(
    ctx: SandboxUseContext,
    admit: (p: DeviceServiceMethods) => void,
    fn: (h: SandboxHandle, p: DeviceServiceMethods, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    admit(serviceMethodsOf((await this.require(ctx.deviceId, ctx.orgId)).impl));
    return this.withSandboxUse(ctx, { kind: "services", fn }, signal);
  }

  /**
   * A short lease on one path of the device around the kernel's own read-modify-write of
   * that file (spec §10.4); waits up to 30 s, then throws `SandboxPathBusyError`. Its `signal`
   * aborts when a renewal finds it lost.
   */
  pathLease(deviceId: string, path: string, signal: AbortSignal): Promise<SandboxPathLease> {
    return this.leases.pathLease(deviceId, path, signal, PATH_LEASE_WAIT_MS);
  }

  /** Trusted staging only. The callback receives no exec, browsing or lifecycle methods. */
  async withPreparation<T>(
    ctx: SandboxUseContext,
    purpose: SandboxPreparationScope["purpose"],
    roots: readonly string[],
    fn: (p: SandboxPreparation, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return this.withSandboxUse(
      ctx,
      {
        kind: "preparation",
        run: (h, provider, info, sig) =>
          this.prepareFor(ctx, h, provider, info, purpose, roots, fn, sig),
      },
      signal,
    );
  }
  private async prepareFor<T>(
    ctx: SandboxUseContext,
    h: SandboxHandle,
    provider: DeviceProvider,
    info: SandboxUseInfo,
    purpose: SandboxPreparationScope["purpose"],
    roots: readonly string[],
    fn: (p: SandboxPreparation, signal: AbortSignal) => Promise<T>,
    sig: AbortSignal,
  ): Promise<T> {
    if (!provider.prepare)
      throw new SandboxPermissionUnsupportedError(
        "Trusted preparation is unavailable on this provider",
      );
    const prepare = provider.prepare.bind(provider);
    const operation = async () => {
      const authority = await runOutsideTransaction(() => this.authority.resolve(ctx, "stat", sig));
      // attachments: exactly the one directory FetchAttachment writes for the call's root
      // conversation, derived by the same helper, nothing else under the attachments root
      const base =
        purpose === "skills"
          ? info.roots.skills
          : attachmentsDir(info.roots, authority.rootConversationId);
      if (
        roots.length === 0 ||
        roots.some(
          (root) =>
            posix.normalize(root) !== root || (root !== base && !root.startsWith(`${base}/`)),
        )
      )
        throw new SandboxScopeDeniedError(
          "Preparation roots must stay inside the trusted purpose directory",
        );
      const operationId = randomUUID();
      return prepare(
        h,
        parseSandboxPreparationScope({
          operationId,
          deviceId: ctx.deviceId,
          purpose,
          writeRoots: [...roots],
          tag: operationId,
        }),
        sig,
      );
    };
    return fn(
      {
        readFile: async (path, opts) =>
          (await operation()).readFile(path, {
            ...opts,
            signal: AbortSignal.any([sig, opts.signal]),
          }),
        writeFile: async (path, data, signal) =>
          (await operation()).writeFile(path, data, AbortSignal.any([sig, signal])),
        stat: async (path, signal) =>
          (await operation()).stat(path, AbortSignal.any([sig, signal])),
      },
      sig,
    );
  }
  /** Owner browse scopes never manufacture a conversation or Full consent. */
  async withBrowse<T>(
    ctx: { orgId: string; deviceId: string; accountId: string },
    fn: (p: SandboxBrowse, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    await this.authority.resolveBrowse(ctx, signal);
    const row = await this.readRow(ctx);
    if (!row) throw deviceNotRunning();
    const entry = await this.require(ctx.deviceId, ctx.orgId);
    const result = await this.ifRunningAs(
      ctx.deviceId,
      { createdAt: row.created_at },
      async (provider, h, sig) => {
        if (!provider.browse)
          throw new SandboxPermissionUnsupportedError(
            "Owner browsing is unavailable on this provider",
          );
        const browse = provider.browse.bind(provider);
        const call = async <R>(
          method: "stat" | "list" | "scan",
          input: unknown,
          s: AbortSignal,
          invoke: (p: SandboxBrowse, s: AbortSignal) => Promise<R>,
        ): Promise<R> => {
          const combined = AbortSignal.any([sig, s]);
          const intent = await this.operationIntents.admitBrowse(
            ctx,
            {
              provider: entry.plugin,
              providerVersion: entry.version,
              generation: String(row.created_at.getTime()),
            },
            method,
            input,
            combined,
          );
          const admitted = await this.operationIntents.claimBrowse(ctx, intent.operation_id);
          combined.throwIfAborted();
          try {
            const operation = await browse(h, parseSandboxBrowseScope(admitted.scope), combined);
            const value = await invoke(operation, combined);
            await runOutsideTransaction(() =>
              this.operationIntents.complete(admitted.operation_id, admitted.execution_id, value),
            );
            return value;
          } catch (error) {
            await runOutsideTransaction(() =>
              this.operationIntents.unknown(admitted.operation_id, admitted.execution_id),
            );
            throw error;
          }
        };
        return fn(
          {
            stat: (path, s) => call("stat", { path }, s, (p, signal) => p.stat(path, signal)),
            list: (path, opts) =>
              call("list", { path, limit: opts.limit }, opts.signal, (p, signal) =>
                p.list(path, { limit: opts.limit, signal }),
              ),
            scan: (base, opts) =>
              call("scan", { base }, opts.signal, (p, signal) => p.scan(base, { signal })),
          },
          sig,
        );
      },
      signal,
      true,
    );
    if (result.kind !== "ran") throw deviceNotRunning();
    return result.value;
  }

  /**
   * Makes the device's instance run for its owner (permission activation L2, Hook 3), before an
   * owner browse ({@link withBrowse}) of a device that may be stopped: the owner, membership and
   * browsing ceiling checks of the browse first (`resolveBrowse`), then the lifecycle `enter` a
   * use takes (the exclusive lease creates or resumes the instance through the retirement gate,
   * the B-11 reconcile marker, `maxRunningSandboxes` and fencing), and the lease
   * is left at once. No conversation holds it and nothing runs in it; what the start caused is
   * not marked seen, so each conversation's next use still learns of it.
   */
  async ensureRunningForOwner(
    ctx: { orgId: string; deviceId: string; accountId: string },
    signal: AbortSignal,
  ): Promise<void> {
    await this.authority.resolveBrowse(ctx, signal);
    const p = await this.require(ctx.deviceId, ctx.orgId);
    const use: SandboxUseContext = {
      orgId: ctx.orgId,
      deviceId: ctx.deviceId,
      holderConversationId: OWNER_START_HOLDER,
      actor: { accountId: ctx.accountId, conversationId: OWNER_START_HOLDER },
    };
    const e = await this.enter(use, p, signal, null, () => this.wantedLimits(use));
    await this.leave(ctx.deviceId, e);
  }

  /**
   * Makes the device's instance run for a managed call before its permission review reads the
   * device's facts: the lifecycle `enter` the call's own use takes (the exclusive lease creates
   * or resumes the instance through the retirement gate, the binding, the limits and fencing, and
   * records a cloud instance's permission evidence), then the lease is left at once. Nothing runs
   * in it; what the start caused is kept for the holder's next use to tell (as a silent use).
   */
  async ensureRunning(use: SandboxUseContext, signal: AbortSignal): Promise<void> {
    const p = await this.require(use.deviceId, use.orgId);
    const e = await this.enter(use, p, signal, null, () => this.wantedLimits(use));
    try {
      await this.deferNotice(use.deviceId, use.holderConversationId, e);
    } finally {
      await this.leave(use.deviceId, e);
    }
  }

  /**
   * Applies the device's current limits to its running instance now, as the exclusive step of a
   * use does ({@link ensure}: the fence moves, then {@link applyLimits}, the provider's `update`
   * or a recreate on the kept files), without waiting for the next use: a device allowlist written
   * outside a tool call (the panel's allow, browser use spec §7) reaches the running services. It
   * never creates, resumes or rebuilds an instance: without a running one (none, suspended, being
   * created or destroyed, files lost) there is nothing to apply and the next use's resume applies
   * the limits. Nothing is done when the limits already apply (no lease is taken, so open viewers
   * stay), or while the device carries a retirement obligation (only a use's gate settles it).
   *
   * The exclusive lease is taken with intent. Only the wait is bounded by `signal` and by
   * `sandbox.lockWaitSeconds` (`sandbox.busy` after that: a tool call holding the device keeps
   * it, and the next use applies the limits); an abort there reaches no provider. The apply under
   * the lease has its own budget (the lifecycle steps' {@link SWEEP_OP_TIMEOUT_MS} and the lease's
   * signal), never what is left of the caller's, so a long wait does not cut an `update` or a
   * recreate short. Taking the lease ends the device's stream holds (ruling R7), so viewers
   * reconnect to the service as it runs afterwards. A device deleted meanwhile is left alone.
   * `applied` with the instance now recorded (a new one after a recreate), `unchanged` when
   * nothing had to be applied, `not_running` without a running instance.
   */
  async applyLimitsIfRunning(
    use: SandboxUseContext,
    signal: AbortSignal,
  ): Promise<"applied" | "unchanged" | "not_running"> {
    const p = await this.require(use.deviceId, use.orgId);
    const env = use.deviceId;
    // a first look without a lease: nothing to apply leaves the device and its viewers alone
    const before = await this.readRow(use);
    if (!this.usable(before, p, null)) return "not_running";
    if (!this.mustApply(before, p, await this.wantedLimits(use))) return "unchanged";
    if (await this.retirement.hasUnresolved(env)) return "unchanged";
    const lease = await this.leases.acquireExclusive(
      env,
      signal,
      this.config.get().sandbox.lockWaitSeconds * 1000,
      { intent: true },
    );
    try {
      // the apply's own budget: the caller's signal bounded only the wait (an abort mid-update
      // would quarantine the instance, one mid-recreate would leave it `creating`)
      const sig = AbortSignal.any([AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS), lease.signal]);
      // under the lease the B1 snapshot writer needs: no limits change on a device carrying the
      // reconcile marker (B-11)
      await this.facts.assertCloudReconciled(use.orgId, env);
      // under the lease, as `ensure` checks: a device deleted while this waited gets nothing
      // recreated on it
      const live = await this.db
        .selectFrom("devices")
        .select("id")
        .where("id", "=", env)
        .where("org_id", "=", use.orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!live) return "not_running";
      // read again under the lease: another holder may have applied, suspended or replaced it
      const row = await this.readRow(use);
      if (!this.usable(row, p, null)) return "not_running";
      if (await this.retirement.hasUnresolved(env)) return "unchanged";
      const fence = { gen: row.generation };
      // every acquisition first does a fenced increment, so a holder whose lease ended unnoticed
      // fails its next write; the provider calls below carry this holder's token
      await this.fenced(lease, env, fence, {});
      const want = await this.wantedLimits(use);
      const must = this.mustApply(row, p, want);
      const installed =
        !must && (await this.installedNetworkWider(env, p, row, row.handle, sig, want));
      if (installed && sig.aborted) throw abortReason(sig);
      if (!must && !installed) return "unchanged";
      const created = await this.applyLimits(
        use,
        p,
        lease,
        row,
        row.handle,
        fence,
        sig,
        want,
        installed,
      );
      // B-15: evidence recorded for the old limits or the old instance is read again
      await this.refreshCloudSupport(
        use,
        p,
        created ?? { handle: row.handle, createdAt: row.created_at.getTime() },
        sig,
        false,
      );
      return "applied";
    } finally {
      await lease.release();
    }
  }

  /**
   * A run start's kernel read of the bound project (permission activation L2, Hook 1): the use
   * a tool call's would be (the instance made or resumed, the read silent for the holder), whose
   * provider stats, reads and lists only, each call a kernel read admitted and claimed on its own
   * (`SandboxOperationIntents.admitKernelRead`: the run's current claim with its run still
   * `queued`, a random operation id, the profile scope narrowed to the root, its `AGENTS.md` and
   * its `.agents/skills`). Any other method is refused before admission. Only
   * `ProjectKnowledgeService` calls this: no tool context, Platform operation or route has it.
   */
  async withKernelRead<T>(
    ctx: SandboxUseContext,
    read: KernelReadInvocation,
    fn: (
      h: SandboxHandle,
      p: HeldProvider,
      info: SandboxUseInfo,
      signal: AbortSignal,
    ) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const c = read.claim;
    if (
      read.purpose !== "project_root" ||
      c.orgId !== ctx.orgId ||
      c.conversationId !== ctx.holderConversationId ||
      c.runId !== ctx.actor.runId ||
      ctx.actor.conversationId !== ctx.holderConversationId
    )
      throw new SandboxScopeDeniedError("The kernel read does not match its run start");
    return this.withSandboxUse(ctx, { kind: "kernelRead", read, fn }, signal);
  }

  async withOperations<T>(
    ctx: SandboxUseContext,
    invocation: OperationSessionInvocation,
    fn: (
      h: SandboxHandle,
      p: HeldProvider,
      info: SandboxUseInfo,
      signal: AbortSignal,
    ) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return this.withSandboxUse(ctx, { kind: "operations", invocation, fn }, signal);
  }

  /**
   * Every use of the device's instance ({@link withOperations}, {@link withPreparation},
   * {@link withKernelRead}; there is no raw route): take a lease → make sure the instance runs
   * (file system, create / resume / rebuild, under the exclusive lease) → the route's callback
   * under a shared lease → update `last_used_at` → release.
   * - Waiting longer than `sandbox.lockWaitSeconds` throws `sandbox.busy` (409); `signal` aborts
   *   the wait and the creation / resume.
   * - The fourth argument of `fn` combines `signal` with the lease's: use it for commands, so they
   *   stop when the lease is lost.
   * - The provider passed to `fn` admits and claims every call (an operation or a kernel read)
   *   before it reaches the provider; a preparation gets only the staging methods.
   * - When `SandboxGoneError` is raised outside a dispatched operation (staging, context
   *   evidence), the instance is rebuilt on the kept files (or the one another holder rebuilt is
   *   taken) and the route runs once more with `restarted: true`; a second `gone` is thrown. A
   *   gone after a durable dispatch stays unknown: the instance is rebuilt, the call is not
   *   retried. Other errors are thrown as they are.
   * - Lost files throw `device.files_lost` (409), also when `fn` throws
   *   `FileSystemGoneError` (the files are then recorded lost, ruling R24).
   * - When `ctx.holderConversationId` last used another instance (another holder rebuilt it
   *   meanwhile), `info.restarted` is true, so it learns its processes are gone (final review m5).
   */
  private async withSandboxUse<T>(
    ctx: SandboxUseContext,
    route: UseRoute<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const p = await this.require(ctx.deviceId, ctx.orgId);
    const env = ctx.deviceId;
    const holder = ctx.holderConversationId;
    // decides the shared fast path only (read again before each shared lease is used): the
    // exclusive path reads it again under the lease
    const want = () => this.wantedLimits(ctx);
    const seen = (x: Entered) =>
      ctx.silent ? this.deferNotice(env, holder, x) : this.seenBy(env, holder, x);
    let e = await seen(await this.enter(ctx, p, signal, null, want));
    let left = false;
    try {
      try {
        return await this.runAs(e, ctx, p, route, signal);
      } catch (err) {
        if (isFileSystemGoneError(err)) throw await this.filesGone(env, p, e);
        const notSentGone = goneBeforeSent(err);
        if (
          notSentGone ||
          (isSandboxOperationOutcomeUnknownError(err) &&
            (isSandboxGoneError((err as { cause?: unknown }).cause) ||
              goneBeforeSent((err as { cause?: unknown }).cause)))
        ) {
          // gone after a durable dispatch: the outcome stays unknown and the call is never retried
          // under a new identity. Gone before the request was sent (#643): the operation is
          // recorded as not sent, and the call answers that nothing ran. Either way the gone
          // instance is rebuilt on the kept files now, so the holder's next call (a retry
          // included) runs on it and is told of the restart (its seen record still names the
          // gone instance)
          this.log.info(
            notSentGone
              ? "sandbox instance is gone before an operation was sent; recreating"
              : "sandbox instance is gone after a dispatched operation; recreating",
            { deviceId: env },
          );
          const gone: Instance = { handle: e.handle, createdAt: e.createdAt };
          await this.leave(env, e);
          left = true;
          try {
            const rebuilt = await this.enter(ctx, p, signal, gone, want);
            await this.leave(env, rebuilt);
          } catch (rebuildErr) {
            this.log.warn("cannot recreate the gone sandbox instance; the next use will", {
              deviceId: env,
              err: rebuildErr,
            });
          }
          throw err;
        }
        if (!isSandboxGoneError(err)) throw err;
        this.log.info("sandbox instance is gone during use; recreating", { deviceId: env });
        const gone: Instance = { handle: e.handle, createdAt: e.createdAt };
        const prev = e;
        await this.leave(env, prev);
        e = await seen(await this.enter(ctx, p, signal, gone, want));
        // a reset seen on the first try still has to be told (it covers the restart)
        const info: EnteredInfo = prev.info.filesReset
          ? { fresh: true, restarted: false, filesReset: true }
          : { fresh: true, restarted: true };
        try {
          return await this.runAs({ ...e, info }, ctx, p, route, signal);
        } catch (err2) {
          if (isFileSystemGoneError(err2)) throw await this.filesGone(env, p, e);
          throw err2;
        }
      }
    } finally {
      if (!left) await this.leave(env, e);
    }
  }

  /**
   * The limits a device's instance must run with for this use (auto mode spec §4.2), read fresh,
   * the same for every provider. A scheduled run has no separate mode grant: the effective policy
   * applies to it as to any use.
   */
  private async wantedLimits(ctx: SandboxUseContext): Promise<DeviceLimits> {
    return await this.deviceLimits(ctx);
  }

  /**
   * Ruling R24: an operation on the held instance `e` found its file system gone. Records
   * `fs_status = 'lost'` while the row still records that instance on its file system (the
   * instance handle stays, so a reset still destroys it), moving the fence on, and returns
   * `device.files_lost` to throw. Uses then fail until the files are reset (a connected
   * machine: until a new login, which resets the row). A failed write only logs.
   */
  private async filesGone(env: string, p: DeviceProviderEntry, e: Entered): Promise<ApiError> {
    this.log.warn("device file system is gone at the provider; its files are lost", {
      deviceId: env,
      provider: p.plugin,
    });
    try {
      // org-filter: the device this holder entered under its lease after readRow's org check
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
    return deviceFilesLost();
  }

  /**
   * A silent use ({@link SandboxUseContext.silent}) of `holder`: the seen record is left alone, so
   * the holder's next ordinary use compares against the instance it last saw itself (and learns
   * of a restart or a files reset since); a creation or rebuild this use caused is kept
   * (`capk:sandbox-notice:<env>:<holder>`, merged with an earlier one for the same instance, same
   * TTL as the seen record) for {@link seenBy} to tell. Best effort: a Redis error only logs.
   */
  private async deferNotice(deviceId: string, holder: string, e: Entered): Promise<Entered> {
    if (!e.info.fresh && !e.info.restarted && e.info.filesReset !== true) return e;
    try {
      const ttl = (this.config.get().sandbox.limits.destroyAfterInactiveDays + 1) * 86_400;
      const seen = `${e.createdAt}:${e.fsResets}`;
      const key = noticeKey(deviceId, holder);
      const mine: DeferredNotice = {
        seen,
        fresh: e.info.fresh,
        restarted: e.info.restarted,
        filesReset: e.info.filesReset === true,
      };
      // swapped in, then merged with an earlier silent use's notice for the same instance
      const prev = parseDeferred(await this.redis.set(key, JSON.stringify(mine), "EX", ttl, "GET"));
      if (prev !== null && prev.seen === seen) {
        const merged: DeferredNotice = {
          seen,
          fresh: mine.fresh || prev.fresh,
          restarted: mine.restarted || prev.restarted,
          filesReset: mine.filesReset || prev.filesReset,
        };
        await this.redis.set(key, JSON.stringify(merged), "EX", ttl);
      }
    } catch (err) {
      this.log.warn("cannot keep the sandbox notice of a silent use", { deviceId, holder, err });
    }
    return e;
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
  private async seenBy(deviceId: string, holder: string, entered: Entered): Promise<Entered> {
    let e = entered;
    try {
      const ttl = (this.config.get().sandbox.limits.destroyAfterInactiveDays + 1) * 86_400;
      const seen = `${e.createdAt}:${e.fsResets}`;
      // what a silent use of this holder caused on this same instance is told now
      const deferred = parseDeferred(await this.redis.getdel(noticeKey(deviceId, holder)));
      if (deferred !== null && deferred.seen === seen) {
        e = {
          ...e,
          info:
            e.info.filesReset === true || deferred.filesReset
              ? { fresh: e.info.fresh || deferred.fresh, restarted: false, filesReset: true }
              : {
                  fresh: e.info.fresh || deferred.fresh,
                  restarted: e.info.restarted || deferred.restarted,
                },
        };
      }
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

  /** Runs the route as the holder `e`, under its lease's signal. */
  private async runAs<T>(
    e: Entered,
    ctx: SandboxUseContext,
    p: DeviceProviderEntry,
    route: UseRoute<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const sig = AbortSignal.any([signal, e.lease.signal]);
    if (route.kind === "preparation")
      return route.run(e.handle, p.impl, { ...e.info, roots: rootsOf(e.handle) }, sig);
    if (route.kind === "services") return route.fn(e.handle, serviceMethodsOf(p.impl), sig);
    const env = ctx.deviceId;
    if (route.kind === "kernelRead")
      return route.fn(
        e.handle,
        this.kernelReadProvider(e, ctx, p, route.read, sig),
        { ...e.info, roots: rootsOf(e.handle) },
        sig,
      );
    const { invocation, fn } = route;
    let ordinal = 0;
    // a provider's background starts are told the held instance's kernel generation
    const held = withKernelGeneration(p.impl, String(e.createdAt));
    const impl = createHeldOperations(
      held,
      e.handle,
      sig,
      async (method, input, invoke, preflight) => {
        const identity = { ...invocation, ordinal: ordinal++ };
        sig.throwIfAborted();
        await this.register(env, e.lease.token);
        const refreshPending = () =>
          runOutsideTransaction(() =>
            this.operationIntents.pending(
              ctx,
              identity,
              {
                provider: p.plugin,
                providerVersion: p.version,
                generation: String(e.createdAt),
              },
              method,
              input,
              e.lease.token,
              sig,
            ),
          );
        const pending = await refreshPending();
        // An acknowledged start returns its recorded exact ref; it never dispatches again.
        if (pending.state === "background-running" && pending.execution_ref)
          return parseSandboxExecutionRef(pending.execution_ref) as Awaited<
            ReturnType<typeof invoke>
          >;
        if (pending.state === "completed")
          return (await this.operationIntents.result(pending)) as Awaited<
            ReturnType<typeof invoke>
          >;
        let current: typeof pending;
        try {
          current = await runOutsideTransaction(() => this.operationIntents.admit(ctx, identity));
        } catch (error) {
          if (!(error instanceof PermissionAdmissionStale)) throw error;
          await refreshPending();
          current = await runOutsideTransaction(() => this.operationIntents.admit(ctx, identity));
        }
        // Kernel checks on the admitted scope come before any dispatch state is written.
        if (preflight && current.state !== "completed" && current.state !== "background-running") {
          try {
            await preflight(parseSandboxOperationScope(current.scope), sig);
          } catch (error) {
            if (
              current.state === "admitted" &&
              (isSandboxScopeDeniedError(error) || isSandboxPermissionUnsupportedError(error))
            ) {
              const kind = failureKindOf(error);
              await runOutsideTransaction(() =>
                this.operationIntents.refusePreDispatch(ctx, identity, {
                  kind,
                  message: error.message,
                }),
              );
            }
            throw error;
          }
        }
        const reconciling = ["dispatching", "started-or-unknown"].includes(pending.state);
        // a dial-in device's machine must be connected before a new dispatch is recorded: its
        // typed answer (offline, machine revoked, device deleted) proves nothing was sent
        if (!reconciling && current.state === "admitted" && this.relay && servesDialIn(p))
          await this.relay.connection(env);
        const admitted = reconciling
          ? await runOutsideTransaction(() =>
              this.operationIntents.claimReconciliation(
                ctx,
                identity,
                {
                  provider: p.plugin,
                  providerVersion: p.version,
                  generation: String(e.createdAt),
                },
                method,
                input,
                e.lease.token,
              ),
            )
          : await runOutsideTransaction(() =>
              this.operationIntents.claimDispatch(
                ctx,
                identity,
                e.lease.token,
                method === "backgroundStart"
                  ? backgroundBinding(input as ManagedStartArgs, e.handle.id)
                  : undefined,
              ),
            );
        if (admitted.state === "revoked")
          throw admitted.outcome_unknown
            ? new SandboxOperationOutcomeUnknownError(
                "The background task was stopped before its start was confirmed; it is not started again and its cancellation is owed",
              )
            : new SandboxScopeDeniedError(
                "The background task was stopped or settled before it launched; nothing was started",
              );
        if (admitted.state === "background-running" && admitted.execution_ref)
          return parseSandboxExecutionRef(admitted.execution_ref) as Awaited<
            ReturnType<typeof invoke>
          >;
        if (admitted.state === "completed")
          return (await this.operationIntents.result(admitted)) as Awaited<
            ReturnType<typeof invoke>
          >;
        sig.throwIfAborted();
        let result: Awaited<ReturnType<typeof invoke>>;
        try {
          result = await invoke(parseSandboxOperationScope(admitted.scope), sig);
        } catch (error) {
          if (isSandboxScopeDeniedError(error) || isSandboxPermissionUnsupportedError(error)) {
            if (["dispatching", "started-or-unknown"].includes(pending.state)) {
              await runOutsideTransaction(() =>
                this.operationIntents.unknown(admitted.operation_id, admitted.execution_id),
              );
              throw new SandboxOperationOutcomeUnknownError(
                "The recorded operation remains unknown; changed runtime authority cannot prove it had no effect",
                { cause: error },
              );
            }
            const kind = failureKindOf(error);
            await runOutsideTransaction(() =>
              this.operationIntents.complete(admitted.operation_id, identity.claim.executionId, {
                $failure: { kind, message: error.message },
              }),
            );
            throw error;
          }
          await runOutsideTransaction(() =>
            this.operationIntents.unknown(admitted.operation_id, admitted.execution_id),
          );
          // The machine's files are gone (R24): the operation stays unknown, and the caller still
          // records the files lost so later calls fail without reaching the machine.
          if (isFileSystemGoneError(error)) throw error;
          // A transport/gone error after durable dispatch cannot justify a new identity retry.
          throw new SandboxOperationOutcomeUnknownError(
            "The operation outcome must be reconciled with its recorded identity",
            { cause: error },
          );
        }
        // The provider has returned: storage/serialization errors cannot establish denial.
        if (method === "backgroundStart") {
          try {
            await runOutsideTransaction(() =>
              this.operationIntents.acknowledgeBackground(
                admitted.operation_id,
                admitted.execution_id,
                result as SandboxExecutionRef,
                e.handle.id,
              ),
            );
          } catch (error) {
            await runOutsideTransaction(() =>
              this.operationIntents.unknown(admitted.operation_id, admitted.execution_id),
            );
            throw new SandboxOperationOutcomeUnknownError(
              "The start returned but could not be acknowledged; reconcile the same identity",
              { cause: error },
            );
          }
          return result;
        }
        try {
          await runOutsideTransaction(() =>
            this.operationIntents.complete(
              admitted.operation_id,
              identity.claim.executionId,
              result,
            ),
          );
        } catch (error) {
          await runOutsideTransaction(() =>
            this.operationIntents.unknown(admitted.operation_id, admitted.execution_id),
          );
          throw new SandboxOperationOutcomeUnknownError(
            "The operation returned but its result could not be retained; reconcile the same identity",
            { cause: error },
          );
        }
        return result;
      },
    );
    const contextEvidence = invocation.contextEvidence
      ? await this.heldContextEvidence(ctx, p, e)
      : undefined;
    const info: SandboxUseInfo = {
      ...e.info,
      roots: rootsOf(e.handle),
      ...(contextEvidence && { contextEvidence }),
    };
    if (invocation.beforeUser)
      await invocation.beforeUser(
        {
          prepare: (purpose, roots, stage) =>
            this.prepareFor(ctx, e.handle, p.impl, info, purpose, roots, stage, sig),
        },
        info,
        sig,
      );
    return fn(e.handle, impl, info, sig);
  }

  /**
   * The held provider of a kernel read ({@link withKernelRead}): every call admitted and claimed
   * as its own kernel read, then dispatched inline under the held lease, as an owner browse's
   * call is ({@link withBrowse}). Exec, writes and scans are refused before any admission.
   */
  private kernelReadProvider(
    e: Entered,
    ctx: SandboxUseContext,
    p: DeviceProviderEntry,
    read: KernelReadInvocation,
    sig: AbortSignal,
  ): HeldProvider {
    const env = ctx.deviceId;
    return createHeldOperations(p.impl, e.handle, sig, async (method, input, invoke) => {
      const path = (input as { path?: unknown }).path;
      if (!isKernelReadMethod(method) || typeof path !== "string")
        throw new SandboxScopeDeniedError("A kernel read only stats, reads and lists files");
      const given = input as { path: string };
      sig.throwIfAborted();
      await this.register(env, e.lease.token);
      let admitted: Awaited<ReturnType<SandboxOperationIntents["claimKernelRead"]>>;
      try {
        const intent = await runOutsideTransaction(() =>
          this.operationIntents.admitKernelRead(
            ctx,
            read,
            {
              provider: p.plugin,
              providerVersion: p.version,
              generation: String(e.createdAt),
            },
            method,
            given,
            e.lease.token,
            sig,
          ),
        );
        admitted = await runOutsideTransaction(() =>
          this.operationIntents.claimKernelRead(ctx, read, intent.operation_id, method, given),
        );
      } catch (error) {
        // a refusal before dispatch: nothing reached the device
        if (sig.aborted || error instanceof KernelReadUnsupported) throw error;
        throw new KernelReadNotAdmitted(error);
      }
      sig.throwIfAborted();
      try {
        const value = await invoke(parseSandboxOperationScope(admitted.scope), sig);
        await runOutsideTransaction(() =>
          this.operationIntents.complete(admitted.operation_id, admitted.execution_id, value),
        );
        return value;
      } catch (error) {
        await runOutsideTransaction(() =>
          this.operationIntents.unknown(admitted.operation_id, admitted.execution_id),
        );
        throw error;
      }
    });
  }

  /**
   * The held evidence of a managed entry (B3), read once under the shared lease the holder already
   * has: the entered provider, the held handle's id and its generation (the row's `created_at`
   * milliseconds), the installed binding of exactly that generation and provider, the handle's
   * roots and the base working root admission resolves. Undefined without an installed binding or
   * with a project binding that no longer matches: the managed writer then refuses the call. The
   * writer validates every field again under the authority locks.
   */
  private async heldContextEvidence(
    ctx: SandboxUseContext,
    p: DeviceProviderEntry,
    e: Entered,
  ): Promise<HeldDeviceContextEvidence | undefined> {
    try {
      return await this.readHeldContextEvidence(ctx, p, e);
    } catch (error) {
      // a storage failure reading the evidence fails the managed call as unrecorded, before any
      // callback, never as a provider error
      if (isStorageError(error)) throw new ManagedDeviceContextFailed("unavailable");
      throw error;
    }
  }

  private async readHeldContextEvidence(
    ctx: SandboxUseContext,
    p: DeviceProviderEntry,
    e: Entered,
  ): Promise<HeldDeviceContextEvidence | undefined> {
    const instanceGeneration = String(e.createdAt);
    // the instance is named by its installed environment as the managed writer reads it under the
    // authority locks (B-15), the same for every provider: current evidence, nothing unapplied,
    // nothing wider than desired; otherwise the device is unavailable for managed work, not a
    // stale retry
    const applied = await this.facts.readHeldEnvironment({
      orgId: ctx.orgId,
      deviceId: ctx.deviceId,
    });
    if (
      applied === null ||
      applied.provider !== p.plugin ||
      applied.instanceGeneration !== instanceGeneration
    )
      return undefined;
    let workingRoot: string;
    try {
      workingRoot = await this.authority.workingRootFor({
        orgId: ctx.orgId,
        deviceId: ctx.deviceId,
        conversationId: ctx.holderConversationId,
      });
    } catch (error) {
      if (error instanceof ApiError) return undefined;
      throw error;
    }
    const roots = rootsOf(e.handle);
    return {
      deviceId: ctx.deviceId,
      provider: p.plugin,
      instanceId: e.handle.id,
      instanceGeneration,
      revision: applied.revision,
      roots: { workspace: roots.workspace, skills: roots.skills, tmp: roots.tmp },
      workingRoot,
    };
  }

  /**
   * Becomes a holder: loops until it has a shared lease on a running instance, or `sandbox.busy`.
   * An instance recorded `running` (with the device's provider, not the `gone` instance) is used
   * under a shared lease; otherwise the exclusive lease (with intent) makes it run and is
   * downgraded. One token serves both, so the waiter passes its own intent. `wantNow` reads the
   * limits this use wants ({@link wantedLimits}), again after each wait, so a mode narrowed
   * during the wait is never used with the old, wider limits.
   */
  private async enter(
    ctx: SandboxUseContext,
    p: DeviceProviderEntry,
    signal: AbortSignal,
    gone: Instance | null,
    wantNow: () => Promise<DeviceLimits>,
  ): Promise<Entered> {
    const env = ctx.deviceId;
    const waitStart = Date.now();
    const deadline = waitStart + this.config.get().sandbox.lockWaitSeconds * 1000;
    const token = randomUUID();
    let intent = false;
    let want = await wantNow();
    try {
      for (let waited = false; ; waited = true) {
        if (signal.aborted) throw abortReason(signal);
        if (waited) want = await wantNow();
        const row = await this.readRow(ctx);
        // an instance whose mode or network must change goes through the exclusive lease
        const ready = (r: Row | undefined): r is Row & { handle: SandboxHandle } =>
          this.usable(r, p, gone) && !this.mustApply(r, p, want);
        // a device with an unresolved retirement obligation is only entered through the
        // exclusive lease, whose gate retires the old incarnation or refuses (8.5)
        if (!(await this.retirement.hasUnresolved(env)) && ready(row)) {
          const lease = await this.leases.tryShared(env, this.cap, token);
          if (lease) {
            if (intent) await this.clearIntent(env, token);
            intent = false;
            // after a wait, the limits again under the lease: a mode narrowed just before the
            // holder we waited for let go is applied now (asShared checks `ready` with them)
            if (waited) {
              try {
                want = await wantNow();
              } catch (err) {
                await lease.release();
                throw err;
              }
            }
            // an obligation recorded while the shared lease was taken: null, back to the gate
            const e = await this.asShared(ctx, p, lease, ready, signal, true, "use");
            if (e) {
              // B-15: cloud evidence gone stale while the instance ran (a provider upgrade)
              await this.refreshCloudSupport(
                ctx,
                p,
                e,
                AbortSignal.any([signal, e.lease.signal]),
                false,
              );
              return e;
            }
          }
        } else {
          const lease = await this.leases.tryExclusive(env, { token, intent: true });
          intent = lease === null;
          if (lease) return await this.asExclusive(ctx, p, lease, gone, signal);
        }
        if (Date.now() + this.pollMs > deadline) {
          this.log.info("sandbox lease wait gave up: the device stayed busy", {
            deviceId: env,
            waitedMs: Date.now() - waitStart,
          });
          throw sandboxBusy();
        }
        try {
          await sleep(this.pollMs + Math.floor(Math.random() * this.pollMs), signal);
        } catch (err) {
          if (signal.aborted)
            this.log.info("sandbox lease wait aborted", {
              deviceId: env,
              waitedMs: Date.now() - waitStart,
            });
          throw err;
        }
      }
    } catch (err) {
      if (intent) await this.clearIntent(env, token);
      throw err;
    }
  }

  /**
   * Whether the lifecycle records this provider's instances' evidence (B-15): a provider (with a
   * known version) that reads its own permission support, the same for every device.
   */
  private recordsSupport(p: DeviceProviderEntry): boolean {
    return p.version !== undefined && typeof p.impl.permissionSupport === "function";
  }

  /**
   * The provider's permission support of the held instance `handle`, read under the caller's
   * lifecycle lease within {@link PERMISSION_SUPPORT_TIMEOUT_MS}; undefined when it cannot be
   * read in time or is not a version 1 report. Never throws: missing evidence keeps the device
   * unprobed, it never fails the lifecycle step. A failure is logged once per instance generation
   * (`warnOnce`: a Redis marker shared by the replicas; without it, every failure is logged).
   */
  private async cloudSupport(
    deviceId: string,
    p: DeviceProviderEntry,
    handle: SandboxHandle,
    signal: AbortSignal,
    warnOnce?: string,
  ): Promise<SupportReport | undefined> {
    const read = p.impl.permissionSupport?.bind(p.impl);
    if (!read || p.version === undefined) return undefined;
    let failure: { message: string; err?: unknown };
    try {
      const sig = AbortSignal.any([signal, AbortSignal.timeout(PERMISSION_SUPPORT_TIMEOUT_MS)]);
      const report = supportOf(await read(handle, sig));
      if (report) return { provider: p.plugin, version: p.version, report };
      failure = { message: "cloud provider returned an invalid permission support report" };
    } catch (err) {
      if (signal.aborted) return undefined;
      failure = {
        message: "cannot read the cloud provider's permission support; device unprobed",
        err,
      };
    }
    // a log marker, not a lock: the previous value says whether this generation was logged (two
    // replicas racing may both log, which is harmless)
    const first =
      warnOnce === undefined ||
      (await this.redis
        .set(`capk:cloud-support-warned:${deviceId}:${warnOnce}`, "1", "EX", 86_400, "GET")
        .then((prev) => prev === null)
        .catch(() => true));
    if (first)
      this.log.warn(failure.message, {
        deviceId,
        provider: p.plugin,
        ...(failure.err !== undefined && { err: failure.err }),
      });
    return undefined;
  }

  /**
   * Under a lifecycle lease on the running instance `e`: records its cloud evidence again when
   * `force` (a resume) or when the recorded one is stale (another provider version, handle,
   * generation or applied limits; `cloudReportOwed`). The record is written only while the row
   * still holds the probed instance with the limits read before the probe, so a holder whose
   * lease was lost never overwrites newer evidence. A forced read that fails clears the recorded
   * identity (a resumed instance is unprobed until a read succeeds); any other failure leaves the
   * evidence as it was. Never throws.
   */
  private async refreshCloudSupport(
    ctx: { orgId: string; deviceId: string },
    p: DeviceProviderEntry,
    e: { handle: SandboxHandle; createdAt: number },
    signal: AbortSignal,
    force: boolean,
  ): Promise<void> {
    try {
      if (!this.recordsSupport(p)) return;
      if (!force && !(await reportOwed(this.db.db, ctx.deviceId, p.plugin, p.version))) return;
      const row = await this.db
        .selectFrom("device_instances")
        .select("instance_limits")
        .where("device_id", "=", ctx.deviceId)
        .where("org_id", "=", ctx.orgId)
        .executeTakeFirst();
      if (!row) return;
      const held = { ...e, limits: row.instance_limits };
      const support = await this.cloudSupport(
        ctx.deviceId,
        p,
        e.handle,
        signal,
        String(e.createdAt),
      );
      if (support)
        await runOutsideTransaction(() =>
          this.instanceWrites.recordSupport(ctx.orgId, ctx.deviceId, held, support, signal),
        );
      else if (force && !signal.aborted)
        await runOutsideTransaction(() =>
          this.instanceWrites.clearSupport(ctx.orgId, ctx.deviceId, held, p.plugin),
        );
    } catch (err) {
      if (!signal.aborted)
        this.log.warn("cannot record the cloud instance's permission evidence", {
          deviceId: ctx.deviceId,
          provider: p.plugin,
          err,
        });
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
    // org-filter: reads org_id and throws foreign below: a filter would turn another org's device
    // into a missing one
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
   * Recorded running with the device's provider on files not lost (lost ones go through the
   * exclusive path, which refuses them), and not the instance found gone.
   */
  private usable(
    row: Row | undefined,
    p: DeviceProviderEntry,
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
   * returns null), records the holder and revokes crashed holders' operations exactly.
   */
  private async asShared(
    ctx: { orgId: string; deviceId: string },
    p: DeviceProviderEntry,
    lease: SandboxLease,
    accept: (row: Row | undefined) => row is Row & { handle: SandboxHandle },
    signal: AbortSignal,
    /**
     * Refused (null) while the device has an unresolved retirement obligation, checked under the
     * lease and before anything is revoked or bumped; false only for exact-ref managed drains.
     */
    gated: boolean,
    /**
     * Checked under the lease (which the B1 snapshot writer's exclusive lease excludes) before
     * anything is revoked or bumped: `reconciled` and `use` refuse a device carrying the
     * reconcile marker (B-11). `none` for background polls, stops and drains.
     */
    check: "use" | "reconciled" | "none" = "none",
  ): Promise<Entered | null> {
    const env = ctx.deviceId;
    try {
      const row = await this.readRow(ctx);
      if (!accept(row) || (gated && (await this.retirement.hasUnresolved(env)))) {
        await lease.release();
        return null;
      }
      if (check !== "none") await this.facts.assertCloudReconciled(ctx.orgId, env);
      // Bump the fence as every acquisition did before phase C: an exclusive holder whose lease
      // expired unnoticed (a stalled sweep) then fails its next write instead of suspending or
      // destroying the instance under this holder. Shared holders never compare it.
      await this.db
        .updateTable("device_instances")
        .set((eb) => ({ generation: eb("generation", "+", 1) }))
        .where("device_id", "=", env)
        .where("org_id", "=", ctx.orgId)
        .execute();
      await this.register(env, lease.token);
      // other holders (any conversation of the device) may be running: only the dead holders'
      // own operations are revoked, exactly
      await this.takeOver(env, this.incarnationOf(row), row.handle, p, signal, lease);
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
   * rebuild when the recorded instance is the one found gone), revokes what crashed holders left,
   * then downgrades to a shared lease. A resumed instance's started-or-unknown operations were
   * revoked by `ensure` before its row said running; here the crashed holders' records are owed and
   * forgotten and every owed revoke of the instance is delivered (nothing is `killAll`ed).
   */
  private async asExclusive(
    ctx: SandboxUseContext,
    p: DeviceProviderEntry,
    lease: SandboxLease,
    gone: Instance | null,
    signal: AbortSignal,
  ): Promise<Entered> {
    const env = ctx.deviceId;
    const sig = AbortSignal.any([signal, lease.signal]);
    try {
      // under the lease the B1 snapshot writer needs: a device carrying the reconcile marker gets
      // no create, resume, rebuild, limits change, retirement destroy or revocation (B-11)
      await this.facts.assertCloudReconciled(ctx.orgId, env);
      const s = await this.ensure(ctx, p, lease, sig, gone);
      // the dead holders' records are forgotten only after their revocation is owed (on a fresh
      // instance too: their intents still name them); a resume delivers what `ensure` revoked
      await this.takeOver(
        env,
        { provider: p.plugin, generation: String(s.createdAt) },
        s.handle,
        p,
        signal,
        lease,
        s.resumed === true,
      );
      // a resumed instance: the provider's report is stored again (a new one stored it at its
      // create), still under the exclusive lease and outside any transaction, before the support
      // whose identity names its revision; a failure keeps the stored one and never fails the use
      if (s.resumed === true)
        await runOutsideTransaction(() =>
          this.reports.refresh(p, { deviceId: env, orgId: ctx.orgId, handle: s.handle }, sig),
        );
      // B-15: a resumed instance reads its permission support again; any other instance whose
      // recorded evidence is stale (a limits change, a provider version change, a new report
      // revision) too
      await this.refreshCloudSupport(ctx, p, s, sig, s.resumed === true);
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
    // org-filter: the device this holder entered under its lease after readRow's org check
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

  /**
   * The crashed holders' cleanup (permission runtime cutover B-1): their tokens are read without
   * removing them, their revocation is owed durably ({@link oweDeadHolders}), it runs inline
   * (`revokeHolders`), and the owed operation revokes of the instance are delivered by operation id
   * ({@link deliverRevocations}). `delivered`: a resume under the exclusive lease, which delivers
   * the revokes `ensure` owed on the incarnation even with no crashed holder. A failure after the
   * revocation is owed is only warned (the outbox retries it); gone and abort are thrown.
   */
  private async takeOver(
    env: string,
    instance: RevokedIncarnation,
    handle: SandboxHandle,
    p: DeviceProviderEntry,
    signal: AbortSignal,
    lease: SandboxLease,
    delivered = false,
  ): Promise<void> {
    const dead = await this.oweDeadHolders(env);
    if (dead.length === 0 && !delivered) return;
    const sig = AbortSignal.any([signal, lease.signal]);
    if (dead.length > 0) {
      try {
        await runOutsideTransaction(() => this.operationIntents.revokeHolders(env, dead));
        this.log.info(
          "sandbox taken over from a holder that did not finish; its operations revoked",
          {
            deviceId: env,
          },
        );
      } catch (err) {
        if (sig.aborted) throw err;
        this.log.warn("cannot revoke a crashed sandbox holder's operations now; a worker retries", {
          deviceId: env,
          err,
        });
      }
    }
    await this.deliverRevocations(env, instance, handle, p, sig);
  }

  /**
   * Crashed holders' tokens whose revocation is now owed durably: read without removing them, an
   * outbox row per token committed ({@link SandboxOperationIntents.oweHolderRevocations}), then
   * their records forgotten. A Redis or database error leaves the records for the next acquirer
   * and counts as none.
   */
  private async oweDeadHolders(env: string): Promise<string[]> {
    let dead: string[];
    try {
      dead = await this.leases.deadHolders(env);
    } catch (err) {
      this.log.warn("cannot read sandbox holder records", { deviceId: env, err });
      return [];
    }
    if (dead.length === 0) return [];
    try {
      await runOutsideTransaction(() => this.operationIntents.oweHolderRevocations(env, dead));
    } catch (err) {
      this.log.warn("cannot owe a crashed sandbox holder's revocation; the next acquirer will", {
        deviceId: env,
        err,
      });
      return [];
    }
    await this.leases
      .forgetHolders(env, dead)
      .catch((err: unknown) =>
        this.log.warn("cannot clear crashed sandbox holder records", { deviceId: env, err }),
      );
    return dead;
  }

  /**
   * The exact cleanup of an incarnation nobody else holds (exclusive lease), in place of a broad
   * `killAll`: revokes its started-or-unknown operations
   * ({@link SandboxOperationIntents.revokeIncarnation}) and delivers the owed revokes. Thrown when
   * the revocation cannot be recorded (`strict`), else only warned: the caller's row still says
   * suspended, so the next resume revokes again.
   */
  private async revokeIncarnation(
    env: string,
    instance: RevokedIncarnation,
    handle: SandboxHandle,
    p: DeviceProviderEntry,
    signal: AbortSignal,
    strict: boolean,
  ): Promise<void> {
    try {
      await runOutsideTransaction(() => this.operationIntents.revokeIncarnation(env, instance));
    } catch (err) {
      if (strict || signal.aborted) throw err;
      this.log.warn("cannot revoke the sandbox instance's leftover operations", {
        deviceId: env,
        err,
      });
      return;
    }
    await this.deliverRevocations(env, instance, handle, p, signal);
  }

  /**
   * Delivers the owed operation revokes of one instance generation inline, by operation id
   * (`revokeOperation`), acknowledging each: what the revoke jobs would deliver, sent before this
   * holder runs anything. Best effort, as the broad `killAll` it replaces was: at most
   * {@link INLINE_REVOKE_LIMIT} per call, nothing for a provider without `revokeOperation`, and any
   * failure only warned. Durability does not depend on it: every revocation wrote its
   * `sandbox-operation-revoke-<operationId>` outbox job in the same transaction, and those jobs
   * deliver until acknowledged. Gone and abort are thrown (the use rebuilds / ends).
   */
  private async deliverRevocations(
    env: string,
    instance: RevokedIncarnation,
    handle: SandboxHandle,
    p: DeviceProviderEntry,
    signal: AbortSignal,
  ): Promise<void> {
    const revoke = p.impl.revokeOperation?.bind(p.impl);
    if (!revoke) return;
    let owed: { operationId: string; deadline: Date }[];
    try {
      owed = await this.operationIntents.owedRevocations(env, instance, INLINE_REVOKE_LIMIT);
    } catch (err) {
      if (signal.aborted) throw err;
      this.log.warn("cannot read the sandbox instance's owed revocations", { deviceId: env, err });
      return;
    }
    for (const o of owed) {
      try {
        await revoke(
          handle,
          { operationId: o.operationId, admitBeforeMs: o.deadline.getTime() },
          AbortSignal.any([signal, AbortSignal.timeout(MAINTENANCE_CALL_TIMEOUT_MS)]),
        );
        await runOutsideTransaction(() =>
          this.operationIntents.acknowledgeRevocation(o.operationId),
        );
      } catch (err) {
        if (signal.aborted || isSandboxGoneError(err)) throw err;
        this.log.warn("cannot deliver an owed operation revoke now; its job retries", {
          deviceId: env,
          operationId: o.operationId,
          err,
        });
      }
    }
  }

  /** The {@link RevokedIncarnation} of an instance row. */
  private incarnationOf(row: Row): RevokedIncarnation {
    return { provider: row.provider ?? "", generation: String(row.created_at.getTime()) };
  }

  /**
   * The owed revocation job of one crashed holder (`sandbox-holder-revoke`): revokes its intents
   * still admitted, dispatching or started-or-unknown and owes each its exact revoke job.
   */
  async revokeDeadHolder(deviceId: string, token: string): Promise<void> {
    await this.operationIntents.revokeHolders(deviceId, [token]);
  }

  /**
   * Suspends running instances idle longer than `suspendAfterIdleMinutes` or running continuously
   * longer than `maxRunningMinutes`. Skips a device with any holder, and one with an open stream
   * hold ({@link holdForStream}) unless it is past `maxRunningMinutes`; one past
   * `maxRunningMinutes` gets the intent for one poll window (about a second) first. Returns how
   * many it suspended. Called every minute by the `sandbox-suspend-idle` cron.
   */
  async suspendIdle(now: Date): Promise<number> {
    let n = 0;
    // each provider over its own rows only; rows of a provider that is not loaded are left as
    // they are
    for (const p of this.providers.all()) n += await this.suspendIdleOf(p, now);
    return n;
  }

  /** Whether the device has a live stream hold; a Redis error counts as none (the sweep goes on). */
  private async streamHeld(deviceId: string): Promise<boolean> {
    try {
      return (await this.leases.streamHolds(deviceId)) > 0;
    } catch (err) {
      this.log.warn("cannot read the device's stream holds", { deviceId, err });
      return false;
    }
  }

  /** {@link suspendIdle} for the rows of one provider. */
  private async suspendIdleOf(p: DeviceProviderEntry, now: Date): Promise<number> {
    const due = this.suspendDue(now, p.plugin);
    const runningBefore = new Date(
      now.getTime() - this.config.get().sandbox.limits.maxRunningMinutes * 60_000,
    );
    const rows = await this.candidates(due);
    let n = 0;
    await inPool(rows, SWEEP_CONCURRENCY, async (c) => {
      const overdue = c.running_since !== null && c.running_since < runningBefore;
      // an open viewer exempts the device from idle suspension only, never from the forced one
      if (!overdue && (await this.streamHeld(c.device_id))) return;
      const done = await this.tryLocked(
        c.device_id,
        async (lease) => {
          return asPlatform("deployment-wide suspension sweep", async () => {
            const id = c.device_id;
            // org-filter: deployment-wide suspension sweep (worker) over every org's idle instances,
            // re-read under each device's lease
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
          });
        },
        overdue,
        // a hold taken since the first look (a viewer that opened meanwhile) refuses the lease:
        // an open viewer exempts the device from idle suspension, never from the forced one
        !overdue,
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
   * skipped. Each provider sweeps its own rows the same way. Returns how many it destroyed.
   * Called hourly by the `sandbox-destroy-inactive` cron.
   */
  async destroyInactive(now: Date): Promise<number> {
    const providers = this.providers.all();
    let n = 0;
    // Gone devices (deleted, or of a deleted org), each provider over its own rows; rows of a
    // provider that is not loaded wait, untouched.
    for (const p of providers) {
      n += await this.sweepRows(p, (eb) => this.deviceGone(eb), "device");
    }
    const due = this.instanceDue(now);
    for (const p of providers) n += await this.sweepRows(p, due, "instance");
    return n;
  }

  /**
   * One destruction sweep over the rows of provider `p` matching `due` (never another provider's
   * row: the row's provider is part of the condition, read again under the lease).
   */
  private async sweepRows(
    p: DeviceProviderEntry,
    due: (eb: ExpressionBuilder<KernelDatabase, "device_instances">) => Expression<SqlBool>,
    mode: "instance" | "device",
  ): Promise<number> {
    const mine = (eb: ExpressionBuilder<KernelDatabase, "device_instances">) =>
      eb.and([eb("provider", "=", p.plugin), due(eb)]);
    let n = 0;
    await inPool(await this.candidates(mine), SWEEP_CONCURRENCY, async ({ device_id: id }) => {
      // an open viewer is device use: the inactivity destruction waits (a deleted device does not)
      if (mode === "instance" && (await this.streamHeld(id))) return;
      const done = await this.tryLocked(id, async (lease) => {
        return asPlatform("deployment-wide destruction sweep", async () => {
          // org-filter: deployment-wide destruction sweep (worker) over every org's due instances,
          // re-read under each device's lease
          const row = await this.db
            .selectFrom("device_instances")
            .selectAll()
            .where("device_id", "=", id)
            .where(mine)
            .executeTakeFirst();
          if (!row) return false;
          await this.destroyRow(row, p, lease, mode);
          return true;
        });
      });
      if (done) n++;
    });
    return n;
  }

  /**
   * Destroys the device's instance, then its file system, then deletes its instance row
   * (device deletion, offboarding); nothing to do without a row. Waits for the exclusive lease
   * (with intent, so running commands finish and new ones wait) up to 10 minutes. Without the
   * provider of its instance row loaded it throws and the row stays, marked `sweep_failed_at` (the
   * job is retried, and the destruction sweep finishes a deleted device once the provider is
   * back). A provider that is no longer installed on this deployment (no install record, or its
   * catalog item removed; never an in-process `@…` one) will not be back: the instance is
   * abandoned instead ({@link abandonInstance}) and the call returns (#675). The provider only
   * needs to be loaded: a device is deleted while its org has the provider off too.
   */
  // org-filter: deviceId is the payload of the kernel's sandbox-destroy-for job, owed by the
  // transaction that soft-deleted the device in its org; never caller input
  async destroyDevice(deviceId: string): Promise<void> {
    const row = await this.db
      .selectFrom("device_instances")
      .select(["device_id", "provider"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    if (!row) return;
    const p =
      row.provider !== null
        ? this.providers.forDevice(row.provider)
        : await this.providerOf(deviceId);
    if (!p && row.provider !== null && !(await this.providerInstalled(row.provider))) {
      await this.abandonInstance(deviceId, row.provider);
      return;
    }
    if (!p) {
      await this.db
        .updateTable("device_instances")
        .set({ sweep_failed_at: sql<Date>`now()` })
        .where("device_id", "=", deviceId)
        .execute();
      throw new Error(
        `cannot destroy device ${deviceId}: its provider ${row.provider ?? "(none)"} is not ` +
          "loaded; the destruction sweep retries it",
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
      if (current && current.provider !== null && current.provider !== p.plugin) {
        throw new Error(`cannot destroy device ${deviceId}: its instance row changed provider`);
      }
      if (current) await this.destroyRow(current, p, lease, "device");
    } finally {
      await lease.release();
    }
  }

  /**
   * Whether `provider` is still installed on this deployment: an in-process `@…` provider always
   * counts (code, not an install), a plugin while its install record exists and the catalog item
   * it was installed from (if any) is not removed. Not loaded on this replica is a separate case.
   */
  private async providerInstalled(provider: string): Promise<boolean> {
    if (isInProcessName(provider)) return true;
    const install = await this.db
      .selectFrom("extension_installs as i")
      .leftJoin("catalog_items as c", "c.id", "i.catalog_item_id")
      .select(["i.catalog_item_id", "c.id as item_id", "c.deleted_at"])
      .where("i.name", "=", provider)
      .executeTakeFirst();
    if (!install) return false;
    return install.catalog_item_id === null || (install.item_id !== null && !install.deleted_at);
  }

  /**
   * Abandons the instance of a deleted device whose provider is no longer installed (#675): the
   * kernel can never destroy it, so the row is kept as the record of the provider-side names
   * (`handle`, `fs_handle`, `prev_handle`), marked `abandoned_at`, and one platform audit event
   * (`device.instance_abandoned`, for the super admin) carries the same names. One statement, so
   * the mark and its event commit together, and only the first call writes either (a retried job
   * finds the row abandoned and does nothing). The sweeps iterate loaded providers only, so
   * nothing retries the row; a plugin of that name installed again destroys it as before.
   */
  private async abandonInstance(deviceId: string, provider: string): Promise<void> {
    // org-filter: only from destroyDevice: the kernel destroy job's device, not caller input
    const written = await this.db
      .with("a", (db) =>
        db
          .updateTable("device_instances")
          .set({ abandoned_at: sql<Date>`now()`, sweep_failed_at: null })
          .where("device_id", "=", deviceId)
          .where("provider", "=", provider)
          .where("abandoned_at", "is", null)
          .returning([
            "device_id",
            "provider",
            "handle",
            "fs_handle",
            "prev_provider",
            "prev_handle",
          ]),
      )
      .insertInto("audit_events")
      .columns(["action", "target", "detail"])
      .expression((eb) =>
        eb
          .selectFrom("a")
          .leftJoin("devices as d", "d.id", "a.device_id")
          .select([
            sql<string>`'device.instance_abandoned'`.as("action"),
            "a.device_id as target",
            sql<string>`jsonb_build_object(
              'orgId', d.org_id,
              'provider', a.provider,
              'handle', a.handle,
              'fsHandle', a.fs_handle,
              'prevProvider', a.prev_provider,
              'prevHandle', a.prev_handle,
              'reason', 'provider_uninstalled'
            )`.as("detail"),
          ]),
      )
      .returning("detail")
      .execute();
    if (written.length > 0) {
      this.log.warn("device instance abandoned: its provider is no longer installed", {
        deviceId,
        provider,
        detail: written[0]?.detail,
      });
    }
  }

  /**
   * Starts the device over with empty files (after `device.files_lost`, or on request):
   * under the exclusive lease (waited for like {@link destroyDevice}) destroys any instance and
   * the file system (a `lost` one is only dropped), and records no file system; the next use
   * creates a new one. Nothing to do without a row. Throws `device.unavailable` while the device's
   * provider is not loaded, or when its instance row names another provider.
   */
  async resetFileSystem(deviceId: string): Promise<void> {
    const p = await this.loadedFor(deviceId);
    const lease = await this.leases.acquireExclusive(
      deviceId,
      AbortSignal.timeout(EXCLUSIVE_WAIT_MS),
      undefined,
      { intent: true },
    );
    try {
      // org-filter: deviceId is the payload of the kernel's sandbox-reset-files job (enqueued after
      // the org-checked device request), not caller input
      const row = await this.db
        .selectFrom("device_instances")
        .selectAll()
        .where("device_id", "=", deviceId)
        .executeTakeFirst();
      if (!row) return;
      if (row.provider !== null && row.provider !== p.plugin) {
        throw deviceInstanceForeign(p.plugin, row.provider);
      }
      const fence = { gen: row.generation };
      // the fenced increment first: the provider calls carry this holder's own token (§3.2)
      await this.fenced(lease, deviceId, fence, {});
      const signal = opSignal(lease);
      const prev = await this.destroyInstance(row, p, signal, lease, fence);
      await this.destroyFiles(row, p, signal);
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
   * The worker's retirement of a device's old incarnations (8.5, `RetireLegacyTasksJob`): one try
   * at the exclusive lifecycle lease, then the same gate as every acquisition. `busy`: a holder
   * has the device (the inline gate runs on its next lifecycle acquisition anyway); `unavailable`:
   * an obligation stays (quarantined, or a destroy that failed); `clear`: none left.
   */
  async retireLegacy(
    deviceId: string,
    /** The worker's signal (its stop, a lost run lock): ends a destroy in flight. */
    signal?: AbortSignal,
  ): Promise<"clear" | "unavailable" | "busy"> {
    const lease = await this.leases.tryExclusive(deviceId);
    if (!lease) return "busy";
    try {
      // org-filter: deviceId comes from the retire-legacy-tasks worker's due list (kernel-held,
      // not caller input); the worker runs it in the platform scope
      const row = await this.db
        .selectFrom("device_instances")
        .selectAll()
        .where("device_id", "=", deviceId)
        .executeTakeFirst();
      const fence = row ? { gen: row.generation } : null;
      if (row && fence) await this.fenced(lease, deviceId, fence, {});
      await this.retireIncarnations(deviceId, lease, row, fence, signal);
      return "clear";
    } catch (err) {
      if (isRetirementPending(err)) return "unavailable";
      throw err;
    } finally {
      await lease.release();
    }
  }

  /**
   * The lifecycle reconcile of a cloud device carrying `permission_reconcile_required` (B-12),
   * under one try at its exclusive lifecycle lease (`busy`: a holder has it). The snapshot
   * writer's reconcile runs first ({@link CloudPermissionSnapshots.reconcileHeld}: it narrows the
   * authority to what the instance is known to run, and may clear the marker by itself). A device
   * with an unresolved retirement obligation stops there: its incarnation is the retirement
   * gate's alone (never resumed here). When the
   * marker stays on a live instance whose provider can `update`, the provider applies the
   * reconcile target, which is never wider than the instance in any dimension, so this only
   * narrows; a suspended instance is resumed for it (its leftover operations revoked exactly,
   * nobody else holds it) and suspended again, as its row still says. `updated` records the target as
   * applied (fenced) and the reconcile runs again, which clears the marker. No `update`, a
   * `recreate` answer, a gone instance or a failure leave the marker and its file reset action.
   */
  async reconcileLimits(
    deviceId: string,
    signal: AbortSignal = AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS),
  ): Promise<CloudSnapshotOutcome | "busy"> {
    const lease = await this.leases.tryExclusive(deviceId);
    if (!lease) return "busy";
    try {
      // org-filter: reads the device's own org; deviceId comes from the reconcile sweep
      // (kernel-held, not caller input), which runs in the platform scope
      const device = await this.db
        .selectFrom("devices")
        .select(["org_id", "provider"])
        .where("id", "=", deviceId)
        .executeTakeFirst();
      if (!device) return { state: "skipped" };
      const orgId = device.org_id;
      const row = await this.db
        .selectFrom("device_instances")
        .selectAll()
        .where("device_id", "=", deviceId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      const fence = row ? { gen: row.generation } : null;
      if (row && fence) await this.fenced(lease, deviceId, fence, {});
      const before = await runOutsideTransaction(() =>
        this.snapshots.reconcileHeld(orgId, deviceId),
      );
      // an incarnation under a retirement obligation is never resumed or updated here: only the
      // retirement gate may touch it (C1); the marker stays until the gate cleared it
      if (before.state === "reconcile-required" && (await this.retirement.hasUnresolved(deviceId)))
        return before;
      const p = row ? this.rowProvider(row) : undefined;
      const update = p?.impl.update?.bind(p.impl);
      if (
        before.state !== "reconcile-required" ||
        before.target === undefined ||
        !row?.handle ||
        !fence ||
        !p ||
        !update ||
        row.provider !== p.plugin ||
        device.provider !== p.plugin ||
        row.fs_status !== "ready" ||
        (row.status !== "running" && row.status !== "suspended")
      )
        return before;
      const handle = row.handle;
      // the effective limits with their resources, read under the lease: exactly the target, or
      // the authority moved since the reconcile (the next round sees it)
      const want = await this.deviceLimits({ orgId, deviceId });
      if (!sameAppliedExactly(appliedOf(want), before.target)) return before;
      const sig = AbortSignal.any([signal, opSignal(lease)]);
      const facts = { deviceId, provider: p.plugin, to: before.target };
      const suspended = row.status === "suspended";
      // the intent first (device update fencing design §7.2): an update this holder never hears
      // back from is applied again by the next exclusive use
      const rec = readInstanceLimits(row.instance_limits);
      await this.fenced(lease, deviceId, fence, {
        instance_limits: instanceLimitsJson(
          rec.applied,
          rec.unapplied ?? undefined,
          appliedOf(want),
        ),
      });
      let answer: "updated" | "recreate" | "gone";
      // whether the provider answered without applying (nothing in flight): the intent goes again
      let settled = false;
      // a stale holder leaves the instance as it is (a newer holder may use it)
      let stale = false;
      try {
        if (suspended && (await p.impl.resume(handle, sig)) === "gone") answer = "gone";
        else {
          // what the pause brought back is revoked exactly before the update (the row still says
          // suspended: a failure is revoked again on the next resume)
          if (suspended)
            await this.revokeIncarnation(
              deviceId,
              { provider: p.plugin, generation: String(row.created_at.getTime()) },
              handle,
              p,
              sig,
              false,
            );
          answer = await update(handle, providerLimits(want), sig, { token: fence.gen });
        }
        settled = answer !== "updated";
      } catch (err) {
        // a newer holder applied a higher token: this one is stale (never recorded, §7.1)
        if (isStaleFenceError(err)) {
          stale = true;
          throw await this.staleHolder(lease, deviceId, p.plugin, fence, "update", err);
        }
        if (sig.aborted) throw err;
        this.log.warn("cannot apply the reconcile limits to the sandbox instance", {
          ...facts,
          err,
        });
        answer = "recreate";
      } finally {
        if (suspended && !stale)
          await this.bestEffort(deviceId, "suspend the instance again after a limits update", (s) =>
            p.impl.suspend(handle, s),
          );
      }
      if (answer !== "updated") {
        // the provider answered and changed nothing: the record goes back to what it was; a
        // failed update keeps the intent for the next use
        if (settled && (await lease.renew()))
          await this.fenced(lease, deviceId, fence, {
            instance_limits: instanceLimitsJson(
              rec.applied,
              rec.unapplied ?? undefined,
              rec.pending ?? undefined,
            ),
          });
        return before;
      }
      if (!(await lease.renew())) throw new SandboxLockLostError(deviceId);
      await this.fenced(lease, deviceId, fence, {
        instance_limits: instanceLimitsJson(appliedOf(want)),
      });
      this.log.info("sandbox instance limits reconciled by the provider's update", facts);
      const after = await runOutsideTransaction(() =>
        this.snapshots.reconcileHeld(orgId, deviceId),
      );
      // a running instance records its evidence for the new limits now; a suspended one on its
      // next use's resume
      if (!suspended)
        await this.refreshCloudSupport(
          { orgId, deviceId },
          p,
          { handle, createdAt: row.created_at.getTime() },
          sig,
          false,
        );
      return after;
    } finally {
      await lease.release();
    }
  }

  /**
   * The worker's sweep of {@link reconcileLimits} (`sandbox-reconcile-limits`): for each loaded
   * provider that can `update`, up to `limit` live cloud devices of its own carrying the marker on
   * a live instance, in id order from that provider's shared keyset cursor that wraps around (no
   * starvation), each tried at most once per {@link RECONCILE_RETRY_SECONDS} across replicas (a
   * Redis marker). Rows of a provider that is not loaded are never touched. Returns how many it
   * reconciled.
   */
  async reconcileMarked(limit = 10): Promise<number> {
    let n = 0;
    for (const p of this.providers.loaded()) {
      if (p.impl.update) n += await this.reconcileMarkedOf(p, limit);
    }
    return n;
  }

  /** {@link reconcileMarked} for the devices of one provider. */
  private async reconcileMarkedOf(p: DeviceProviderEntry, limit: number): Promise<number> {
    const cursorKey = reconcileCursorKey(p.plugin);
    // org-filter: deployment-wide reconcile sweep (worker) over every org's marked devices of
    // this provider
    const page = (after: string, n: number) =>
      asPlatform("deployment-wide reconcile sweep", () =>
        this.db
          .selectFrom("devices as d")
          .innerJoin("device_instances as i", "i.device_id", "d.id")
          .select("d.id")
          .where("d.deleted_at", "is", null)
          .where("d.permission_reconcile_required", "=", true)
          .where("d.provider", "=", p.plugin)
          .where("i.provider", "=", p.plugin)
          .where("i.handle", "is not", null)
          .where("i.status", "in", ["running", "suspended"])
          .where(sql<boolean>`d.id COLLATE "C" > ${after}`)
          .orderBy(sql`d.id COLLATE "C"`)
          .limit(n)
          .execute(),
      );
    // a keyset cursor shared by the replicas (the cron runs once per tick): each tick goes on
    // after the last device the previous one visited and wraps around, so devices that stay
    // marked never starve the ones after them
    const after = (await this.redis.get(cursorKey).catch(() => null)) ?? "";
    const rows = await page(after, limit);
    if (rows.length < limit && after !== "") {
      const seen = new Set(rows.map((r) => r.id));
      for (const r of await page("", limit - rows.length))
        if (!seen.has(r.id) && r.id <= after) rows.push(r);
    }
    const last = rows.at(-1)?.id;
    await this.redis
      .set(cursorKey, last ?? "", "EX", 86_400)
      .catch((err: unknown) => this.log.warn("cannot record the reconcile cursor", { err }));
    let n = 0;
    for (const { id } of rows) {
      // a retry window shared by the replicas, not a lock: a second try within it waits
      const first = await this.redis
        .set(`capk:cloud-reconcile-tried:${id}`, "1", "EX", RECONCILE_RETRY_SECONDS, "GET")
        .then((prev) => prev === null)
        .catch(() => false);
      if (!first) continue;
      try {
        const r = await this.reconcileLimits(id);
        if (r !== "busy" && r.state === "bound") n++;
      } catch (err) {
        this.log.warn("cannot reconcile a cloud device's limits; will retry", {
          deviceId: id,
          err,
        });
      }
    }
    return n;
  }

  /**
   * The retirement gate (permission runtime cutover 8.5), under the exclusive lifecycle lease and
   * before the instance is used, resumed, rebuilt, switched to another provider, bound or
   * downgraded to shared use: every unresolved obligation of the device is settled here or the
   * device is unavailable ({@link retirementPending}).
   * - The obligation names the **current** incarnation (provider and exact generation): it is
   *   destroyed whole by its provider, whatever the provider (never resumed, never `killAll`ed,
   *   the file system kept), the confirmed destruction is recorded and the row reads
   *   `destroyed`, so the use creates a fresh instance; a failed destroy keeps the obligation.
   * - B-22: a **suspended** current incarnation whose members are all revoked managed starts
   *   is not destroyed whole (its other tasks would be lost): each revoked ref gets its exact stop
   *   (persisted while suspended), the instance is resumed, each stop is confirmed (`stopped` or
   *   `already-exited`), and the obligation resolves as `exact-cancelled`. Any failure is noted on
   *   the obligation and falls back to the whole-instance destroy above. `resumed` given (a use):
   *   the resumed instance is left running for it (`resumed.resumed` set); otherwise (the worker),
   *   or when the device stays refused, it is suspended again, as its row still says.
   * - It names an incarnation that is **not current** (replaced, a reused handle with another
   *   generation, unknown): resolved only by a recorded provider-confirmed destruction of exactly
   *   it, else quarantined. A newer generation is never evidence.
   * Returns the row as it is afterwards.
   */
  private async retireIncarnations(
    id: string,
    held: SandboxLease,
    row: Row | undefined,
    fence: Fence | null,
    signal?: AbortSignal,
    /** A use's holder: a gate that resumed the instance (B-22) leaves it running and says so. */
    resumed?: { resumed: boolean },
  ): Promise<Row | undefined> {
    // the device's own candidates first: the gate never depends on the worker having scanned (C1)
    await this.retirement.scanUntilStable(5, id);
    const open = await this.retirement.unresolved(id);
    let now = row;
    // every obligation is tried (one that stays never hides another that can resolve); the
    // device is refused at the end while any stays, with the answer that tells what would help:
    // a failed or impossible destroy now → unavailable (a retry may succeed); an incarnation no
    // evidence can ever cover → recreate the device
    let pending = false;
    let failed = false;
    const isLive = (r: Row | undefined): r is Row & { handle: SandboxHandle } =>
      r !== undefined &&
      r.handle !== null &&
      (r.status === "running" || r.status === "suspended" || r.status === "creating");
    /** The instance this gate resumed for an exact cancel and still runs (B-22). */
    let resumedHere: { impl: DeviceProvider; handle: SandboxHandle } | null = null;
    const bounded = () =>
      AbortSignal.any([
        opSignal(held),
        AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]);
    /**
     * B-22: on a suspended current cloud incarnation whose members are all revoked managed
     * starts, cancels each by its exact ref and resumes the instance in between. `skip`: the
     * shape does not apply (the destroy follows); `failed`: a cancel could not be confirmed (the
     * reason is noted, the destroy follows).
     */
    const cancelOnResume = async (
      o: { id: string; orgId: string; provider: string; instanceGeneration: string },
      live: Row & { handle: SandboxHandle },
    ): Promise<{ cancelled: string[] } | "skip" | { failed: string }> => {
      if (live.status !== "suspended" || !isKnownProvider(o.provider)) return "skip";
      const impl = this.providers.forDevice(o.provider)?.impl;
      const background = impl?.background;
      if (!impl || !background) return "skip";
      const members = await this.retirement.membersOf(o.id);
      if (members.length === 0 || members.some((m) => m.kind !== "revoked-start")) return "skip";
      const owed: SandboxExecutionRef[] = [];
      for (const m of members) {
        const intent = await this.db
          .selectFrom("sandbox_operation_intents")
          .select([
            "method",
            "state",
            "revoke_acknowledged",
            "provider",
            "instance_generation",
            "execution_ref",
          ])
          .where("operation_id", "=", m.refId)
          .where("org_id", "=", o.orgId)
          .where("device_id", "=", id)
          .executeTakeFirst();
        if (intent?.revoke_acknowledged === true) continue;
        if (
          intent === undefined ||
          intent.method !== "backgroundStart" ||
          intent.state !== "revoked" ||
          intent.provider !== o.provider ||
          intent.instance_generation !== o.instanceGeneration
        )
          return { failed: `revoked start ${m.refId} cannot be named on this incarnation` };
        let ref: SandboxExecutionRef;
        try {
          ref = parseSandboxExecutionRef(intent.execution_ref);
        } catch {
          return { failed: `revoked start ${m.refId} has no valid execution reference` };
        }
        // the intent named the incarnation above; the ref's generation is the provider's own
        if (ref.operationId !== m.refId || ref.instanceId !== live.handle.id)
          return { failed: `revoked start ${m.refId} names another instance` };
        owed.push(ref);
      }
      try {
        // persisted while suspended: the provider applies a pending cancel before any work of
        // the instance runs again; the answer is confirmed after the resume
        for (const ref of owed) {
          const r = await background.stop(live.handle, ref, {
            graceMs: MANAGED_STOP_GRACE_MS,
            signal: bounded(),
          });
          // anything but a recorded (or already settled) cancel: never resume into the work
          if (
            r.outcome !== "cancel-pending" &&
            r.outcome !== "stopped" &&
            r.outcome !== "already-exited"
          )
            return {
              failed: `the exact stop of ${ref.operationId} answered ${r.outcome} while suspended`,
            };
        }
        if ((await impl.resume(live.handle, bounded())) === "gone")
          return { failed: "the instance is gone at the provider" };
        resumedHere = { impl, handle: live.handle };
        for (const ref of owed) {
          const r = await background.stop(live.handle, ref, {
            graceMs: MANAGED_STOP_GRACE_MS,
            signal: bounded(),
          });
          if (r.outcome !== "stopped" && r.outcome !== "already-exited")
            return { failed: `the exact stop of ${ref.operationId} answered ${r.outcome}` };
        }
      } catch (err) {
        if (held.signal.aborted || signal?.aborted) throw err;
        return { failed: err instanceof Error ? err.message : String(err) };
      }
      if (!(await held.renew())) throw new SandboxLockLostError(id);
      this.log.info("revoked starts cancelled exactly on a resumed instance", {
        deviceId: id,
        operations: owed.map((r) => r.operationId),
      });
      // every member read is covered (an acknowledged one needed no stop)
      return { cancelled: members.map((m) => m.refId) };
    };
    /**
     * Destroys the live incarnation of `now` whole with its own provider (never resumed or
     * killAll'ed, files kept), records the confirmed destruction and marks the row destroyed.
     */
    const destroyLive = async (
      o: { id: string },
      live: Row & { handle: SandboxHandle },
    ): Promise<boolean> => {
      const provider = live.provider ?? "unknown";
      const impl = isKnownProvider(provider) ? this.providers.forDevice(provider)?.impl : undefined;
      if (!impl) {
        await this.retirement.noteFailure(o.id, `provider ${provider} is not loaded`);
        return false;
      }
      try {
        // bounded (M5): a hung provider never holds the lease or the worker's tick
        await impl.destroy(
          live.handle,
          AbortSignal.any([
            opSignal(held),
            AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS),
            ...(signal ? [signal] : []),
          ]),
          tokenOf(fence),
        );
      } catch (err) {
        if (held.signal.aborted || signal?.aborted) throw err;
        if (isStaleFenceError(err) && fence)
          throw await this.staleHolder(held, id, provider, fence, "destroy", err);
        await this.retirement.noteFailure(o.id, err);
        this.log.warn("cannot destroy an instance that may run legacy work; device unavailable", {
          deviceId: id,
          err,
        });
        return false;
      }
      if (!(await held.renew())) throw new SandboxLockLostError(id);
      resumedHere = null;
      await this.retirement.recordDestruction(id, provider, String(live.created_at.getTime()));
      if (fence)
        await this.fenced(held, id, fence, {
          status: "destroyed",
          destroyed_at: sql<Date>`now()`,
          running_since: null,
          suspended_at: null,
          sweep_failed_at: null,
        });
      this.log.info("instance that may run legacy work destroyed", { deviceId: id });
      // org-filter: the device this retirement gate holds under its exclusive lease; the instance
      // row is keyed by its device
      now = await this.db
        .selectFrom("device_instances")
        .selectAll()
        .where("device_id", "=", id)
        .executeTakeFirst();
      return true;
    };
    /**
     * R2-I1: the row is not live (destroyed before 0157 without a record, or a create that left
     * `creating` with no handle). With no `prev_handle`, the row's own cloud provider holds at
     * most one instance of the device's name (device-provider@1 same-name replacement), so its destroy by
     * that name confirms every incarnation there; it is recorded as the destruction of the row's
     * incarnation. A provider not loaded or a failed destroy keeps the obligation open.
     */
    const destroyNamed = async (o: { id: string }, row: Row): Promise<boolean> => {
      const provider = row.provider ?? "unknown";
      const impl = isKnownProvider(provider) ? this.providers.forDevice(provider)?.impl : undefined;
      if (!impl) {
        await this.retirement.noteFailure(o.id, `provider ${provider} is not loaded`);
        return false;
      }
      try {
        await impl.destroyByName(
          deviceResourceName(id),
          AbortSignal.any([
            opSignal(held),
            AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS),
            ...(signal ? [signal] : []),
          ]),
          tokenOf(fence),
        );
      } catch (err) {
        if (held.signal.aborted || signal?.aborted) throw err;
        if (isStaleFenceError(err) && fence)
          throw await this.staleHolder(held, id, provider, fence, "destroy", err);
        await this.retirement.noteFailure(o.id, err);
        this.log.warn("cannot destroy by name an instance that may run legacy work", {
          deviceId: id,
          err,
        });
        return false;
      }
      if (!(await held.renew())) throw new SandboxLockLostError(id);
      await this.retirement.recordDestruction(id, provider, String(row.created_at.getTime()));
      if (fence && row.status === "creating")
        await this.fenced(held, id, fence, {
          status: "destroyed",
          destroyed_at: sql<Date>`now()`,
          running_since: null,
          suspended_at: null,
          sweep_failed_at: null,
        });
      this.log.info("instance that may run legacy work destroyed by name", { deviceId: id });
      // org-filter: the device this retirement gate holds under its exclusive lease; the instance
      // row is keyed by its device
      now = await this.db
        .selectFrom("device_instances")
        .selectAll()
        .where("device_id", "=", id)
        .executeTakeFirst();
      return true;
    };
    try {
      for (const o of open) {
        const gen = o.instanceGeneration;
        const current =
          isLive(now) && now.provider === o.provider && String(now.created_at.getTime()) === gen;
        if (current && isLive(now)) {
          let cancel = await cancelOnResume(o, now);
          if (cancel !== "skip" && "cancelled" in cancel) {
            // resolved only while no member outside the stopped refs exists (a concurrent scan's)
            if (await this.retirement.resolveCancelled(o.id, cancel.cancelled)) continue;
            cancel = { failed: "a revoked start was recorded while the cancel ran" };
          }
          if (cancel !== "skip") {
            this.log.warn("cannot cancel revoked starts exactly; destroying the instance", {
              deviceId: id,
              reason: cancel.failed,
            });
            await this.retirement.noteFailure(o.id, cancel.failed);
          }
          if (await destroyLive(o, now)) await this.retirement.resolveDestroyed(o.id);
          else {
            pending = true;
            failed = true;
          }
          continue;
        }
        // the existing whole-instance destroy left the row `destroyed` on exactly this incarnation
        // with nothing kept for a later retry: the provider confirmed it
        const destroyedHere =
          now !== undefined &&
          now.status === "destroyed" &&
          now.provider === o.provider &&
          String(now.created_at.getTime()) === gen &&
          now.prev_handle === null &&
          isKnownProvider(o.provider);
        if (destroyedHere || (await this.retirement.destructionRecorded(id, o.provider, gen))) {
          await this.retirement.resolveDestroyed(o.id);
          continue;
        }
        if (gen === "unknown" || o.provider === "unknown") {
          // R1-I1 (b): an incarnation the kernel cannot name. Every incarnation the device had
          // stopped being current through a kernel destroy, a provider `gone` or a kept
          // `prev_handle`; so once the device's current incarnation is destroyed with
          // confirmation, nothing earlier is kept (`prev_handle`) and the obligation was recorded
          // under the freeze (no dispatch after it), no instance of the device can run legacy work.
          // This rests on device-provider@1 same-name replacement: every rebuild on the same provider goes
          // through `create`, which first removes the old `cap-device-<id>` instance (so a `gone`
          // answer, E2B's token-failure `gone` included, and `applyLimits`' swallowed destroy
          // failure leave nothing behind), and E2B's incarnations are one sandbox (destroying the
          // current one ends the earlier processes). A provider or kernel path that rebuilds
          // without same-name replacement breaks this barrier.
          const frozenAt = await this.retirement.frozenAt();
          const reason =
            frozenAt === null || o.createdAt < frozenAt
              ? "an unknown cloud incarnation recorded before the freeze"
              : now === undefined || !now.had_instance
                ? // a row (re)inserted by this acquisition knows nothing of the earlier instances
                  "an unknown cloud incarnation and no instance record to destroy"
                : now.prev_handle !== null
                  ? "an unknown cloud incarnation while an earlier provider's instance may still exist"
                  : null;
          if (reason === null && now !== undefined) {
            if (isLive(now)) {
              if (await destroyLive(o, now)) await this.retirement.resolveDestroyed(o.id);
              else {
                pending = true;
                failed = true;
              }
              continue;
            }
            if (
              now.status === "destroyed" &&
              now.provider !== null &&
              (await this.retirement.destructionRecorded(
                id,
                now.provider,
                String(now.created_at.getTime()),
              ))
            ) {
              await this.retirement.resolveDestroyed(o.id);
              continue;
            }
            // not live and nothing recorded (R2-I1): confirm by name with the row's provider
            if (await destroyNamed(o, now)) await this.retirement.resolveDestroyed(o.id);
            else {
              pending = true;
              failed = true;
            }
            continue;
          }
          await this.retirement.quarantine(
            o.id,
            reason ??
              "an unknown cloud incarnation and no confirmed destruction of the current one",
          );
          pending = true;
          continue;
        }
        await this.retirement.quarantine(
          o.id,
          "the old instance was replaced without a recorded confirmed destruction",
        );
        pending = true;
      }
    } catch (err) {
      // a throw after a resume (a lost lease, an abort, a failed write): the row still says
      // suspended, so the instance is suspended again (best effort) before the error goes on
      const left = resumedHere as { impl: DeviceProvider; handle: SandboxHandle } | null;
      if (left !== null)
        await this.bestEffort(id, "suspend the instance again after a failed retirement", (s) =>
          left.impl.suspend(left.handle, s),
        );
      throw err;
    }
    // a use runs on the instance this gate resumed; anything else leaves it as its row says
    const still = resumedHere as { impl: DeviceProvider; handle: SandboxHandle } | null;
    if (still !== null && (pending || resumed === undefined)) {
      await this.bestEffort(id, "suspend the instance again after an exact cancel", (s) =>
        still.impl.suspend(still.handle, s),
      );
    } else if (still !== null && resumed !== undefined) resumed.resumed = true;
    if (pending) throw failed ? retirementPending() : recreateRequired();
    return now;
  }

  /**
   * A fenced write: only while the lease holds and the row's generation is still the one read
   * under it (and incremented); otherwise {@link SandboxLockLostError}.
   */
  private async fenced(lease: SandboxLease, id: string, fence: Fence, set: Patch): Promise<Date> {
    if (lease.signal.aborted) throw new SandboxLockLostError(id);
    // committed on its own, never inside a caller's transaction: the generation it writes is the
    // token the next provider call carries, which every replica must see before that call (device
    // update fencing design §3.2)
    // org-filter: fenced write on the device this holder leases (entered after the org check, or a
    // sweep's device); the fence generation guards it
    const r = await runOutsideTransaction(() =>
      this.db
        .updateTable("device_instances")
        .set({ ...set, generation: fence.gen + 1 })
        .where("device_id", "=", id)
        .where("generation", "=", fence.gen)
        .returning("created_at")
        .executeTakeFirst(),
    );
    if (!r) throw new SandboxLockLostError(id, "generation");
    fence.gen++;
    return r.created_at;
  }

  /** Sweep candidates: those whose last sweep failed come last, the rest least recently used first. */
  private async candidates(
    due: (eb: ExpressionBuilder<KernelDatabase, "device_instances">) => Expression<SqlBool>,
  ): Promise<{ device_id: string; running_since: Date | null }[]> {
    return asPlatform("deployment-wide sweep candidates", async () => {
      // org-filter: deployment-wide sweep candidates (suspension and destruction workers) across
      // every org
      return await this.db
        .selectFrom("device_instances")
        .select(["device_id", "running_since"])
        .where(due)
        .orderBy(sql`sweep_failed_at ASC NULLS FIRST`)
        .orderBy("last_used_at")
        .limit(SWEEP_BATCH)
        .execute();
    });
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
    /** Refused (false) while the device has a live stream hold ({@link holdForStream}). */
    unlessStreams = false,
  ): Promise<boolean> {
    let lease: SandboxLease | null;
    try {
      lease = await this.leases.tryExclusive(deviceId, unlessStreams ? { unlessStreams } : {});
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
      // org-filter: sweep bookkeeping on the device the calling sweep (platform scope) holds
      // under its lease
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
    p: DeviceProviderEntry,
    held: SandboxLease,
    signal: AbortSignal,
    gone: Instance | null,
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
    // org-filter: reads org_id and throws foreign below (the device itself was just checked in
    // ctx.orgId)
    const read = await this.db
      .selectFrom("device_instances")
      .selectAll()
      .where("device_id", "=", id)
      .executeTakeFirst();
    if (!read) throw deviceNotFound();
    if (read.org_id !== ctx.orgId) throw this.foreign(ctx);
    const fence = { gen: read.generation };
    // Every acquisition first does a fenced increment: an old holder whose lease expired while it
    // kept running (a stalled sweep) then fails its next write.
    await this.fenced(held, id, fence, {});
    // the retirement gate (8.5), before any use, resume, rebuild or bind: an
    // old incarnation that may run legacy work is destroyed (cloud, confirmed) or refuses
    signal.throwIfAborted();
    const gate = { resumed: false, running: false };
    const row = (await this.retireIncarnations(id, held, read, fence, undefined, gate)) ?? read;
    try {
      if (row.fs_status === "lost") throw deviceFilesLost();
      // a device is bound to its provider for life: an instance row of another provider (never
      // written by this kernel) is refused as it is, never taken over
      if (row.provider !== null && row.provider !== p.plugin) {
        throw deviceInstanceForeign(p.plugin, row.provider);
      }
      // read under the lease, after the fence moved: a value read before the wait may be stale
      // (another replica may have changed the mode meanwhile)
      const want = await this.wantedLimits(ctx);
      const handle = row.handle;
      const createdAt = row.created_at.getTime();
      const fsResets = row.fs_resets;
      if (handle && isInstance(row, gone) && row.status === "running") {
        const created = await this.createSettled(ctx, p, held, row, fence, signal, want);
        return { ...created, fsResets, info: { fresh: true, restarted: true }, fence };
      }
      if (handle && row.status === "running") {
        const must = this.mustApply(row, p, want);
        const installed =
          !must && (await this.installedNetworkWider(id, p, row, handle, signal, want));
        // aborted while reading: the instance runs as it was (no quarantine of a healthy instance
        // for a cancel); the next exclusive step reads again
        if (installed && signal.aborted) throw abortReason(signal);
        if (must || installed) {
          const created = await this.applyLimits(
            ctx,
            p,
            held,
            row,
            handle,
            fence,
            signal,
            want,
            installed,
          );
          if (created)
            return { ...created, fsResets, info: { fresh: true, restarted: true }, fence };
        }
        return { handle, createdAt, fsResets, info: { fresh: false, restarted: false }, fence };
      }
      if (handle && row.status === "suspended") {
        // the retirement gate may have resumed it already, to cancel revoked starts exactly (B-22)
        const r = gate.resumed
          ? "resumed"
          : await this.lifecycleStep("resume", id, p, signal, () => p.impl.resume(handle, signal));
        if (r === "resumed") {
          const incarnation = { provider: p.plugin, generation: String(createdAt) };
          // the new limits first: the row says running only once the instance runs with them
          // (and again when the instance's installed network allows more than the record: #766)
          const must = this.mustApply(row, p, want);
          const installed =
            !must && (await this.installedNetworkWider(id, p, row, handle, signal, want));
          if (must || installed) {
            let created: Instance | null;
            try {
              created = await this.applyLimits(
                ctx,
                p,
                held,
                row,
                handle,
                fence,
                signal,
                want,
                installed,
              );
            } catch (err) {
              // refused as stale: the provider changed nothing, and the instance (the same
              // incarnation after an in-place update) may already run a newer holder's work
              if (err instanceof SandboxLockLostError && err.reason === "generation") throw err;
              // the work a pause brought back is revoked exactly, never killed broadly; the row
              // still says suspended, so the next use resumes and revokes again
              await this.revokeIncarnation(
                id,
                incarnation,
                handle,
                p,
                AbortSignal.timeout(MAINTENANCE_CALL_TIMEOUT_MS),
                false,
              ).catch((e: unknown) =>
                this.log.warn("cannot revoke the operations left after a failed limits change", {
                  deviceId: id,
                  err: e,
                }),
              );
              throw err;
            }
            if (created) {
              return { ...created, fsResets, info: { fresh: true, restarted: true }, fence };
            }
          }
          // the work a pause brought back (every admitted, dispatching and started-or-unknown
          // operation of this generation) is revoked before the row says running; the revokes are
          // delivered before the downgrade. A failure fails the use closed: the instance is
          // suspended again (best effort, its failure only warned), the row still says
          // suspended, and the next use resumes and revokes again
          try {
            await runOutsideTransaction(() =>
              this.operationIntents.revokeIncarnation(id, incarnation),
            );
          } catch (err) {
            await this.bestEffort(id, "suspend the instance again after a failed revocation", (s) =>
              p.impl.suspend(handle, s),
            );
            throw err;
          }
          await this.fenced(held, id, fence, {
            status: "running",
            running_since: sql<Date>`now()`,
            suspended_at: null,
            sweep_failed_at: null,
          });
          gate.running = true;
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
      const created = await this.createSettled(ctx, p, held, row, fence, signal, want);
      // had_instance only ever becomes true: any earlier instance (even if a rebuild failed since)
      // makes this one a restart on the kept files
      return {
        ...created,
        fsResets,
        info: { fresh: true, restarted: row.had_instance && row.fs_status === "ready" },
        fence,
      };
    } catch (err) {
      // the gate resumed the instance for an exact cancel (B-22) and this use failed before its
      // row said running: suspended again (best effort), as the row still says
      const resumedHandle = row.handle;
      if (gate.resumed && !gate.running && resumedHandle)
        await this.bestEffort(id, "suspend the instance again after a failed use", (s) =>
          p.impl.suspend(resumedHandle, s),
        );
      throw err;
    }
  }

  /**
   * {@link create} from {@link ensure}, then, for a provider whose limits are fixed at its file
   * system (the new instance keeps the network its file system enforces, E2B), the installed
   * network check of {@link installedNetworkWider} on the new instance (issue #766): wider than
   * the record applies the desired limits again before the use. Any other provider's new instance
   * got the desired limits at `create`.
   */
  private async createSettled(
    ctx: SandboxUseContext,
    p: DeviceProviderEntry,
    held: SandboxLease,
    row: Row,
    fence: Fence,
    signal: AbortSignal,
    want: DeviceLimits,
  ): Promise<Instance> {
    const created = await this.lifecycleStep(
      row.had_instance ? "recreate" : "create",
      ctx.deviceId,
      p,
      signal,
      () => this.create(ctx, p, held, row, fence, signal, want),
    );
    if (p.impl.limitsApplyAt !== "fileSystem") return created;
    // the row as the create committed it (its new instance generation and record)
    const fresh = await this.readRow(ctx);
    if (!fresh) return created;
    if (!(await this.installedNetworkWider(ctx.deviceId, p, fresh, created.handle, signal, want)))
      return created;
    const again = await this.applyLimits(
      ctx,
      p,
      held,
      fresh,
      created.handle,
      fence,
      signal,
      want,
      true,
    );
    return again ?? created;
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
    p: DeviceProviderEntry,
    held: SandboxLease,
    row: Row,
    fence: Fence,
    signal: AbortSignal,
    want: DeviceLimits,
  ): Promise<Instance> {
    const id = ctx.deviceId;
    const name = deviceResourceName(id);
    // the roots the device's authority was last committed with; a device that never had an
    // instance has none yet (NULL): its first commit is no roots change (no consent reset, no
    // revoke)
    const committedRoots = row.permission_roots ?? (row.handle ? rootsOf(row.handle) : null);
    await this.fenced(held, id, fence, {
      org_id: ctx.orgId,
      provider: p.plugin,
      handle: null,
      permission_roots: committedRoots === null ? null : JSON.stringify(committedRoots),
      status: "creating",
      last_used_at: sql<Date>`now()`,
      running_since: null,
      suspended_at: null,
      destroyed_at: null,
      sweep_failed_at: null,
    });
    // the device's effective limits apply at creation (a changed network kind or host list is
    // applied on use, see applyLimits; resources reach only instances created afterwards)
    const wanted = want;
    // the record says what is in force: a provider whose limits are fixed at its file system
    // records them with the file system, any other with the instance (spec §7.1)
    const record = instanceLimitsJson(appliedOf(wanted));
    // the provider gets resources and the outer network only
    const limits = providerLimits(wanted);
    const atFileSystem = p.impl.limitsApplyAt === "fileSystem";
    const cfg = this.config.get().sandbox;
    let fs: FileSystemHandle | null =
      row.fs_status === "ready" && (row.provider === null || row.provider === p.plugin)
        ? row.fs_handle
        : null;
    if (fs === null) {
      try {
        fs = await p.impl.createFileSystem({ name, limits, signal });
      } catch (err) {
        throw providerRefusal(
          this.log,
          err,
          { deviceId: id, provider: p.plugin, op: "createFileSystem" },
          limits,
          signal,
        );
      }
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
        fence: { token: fence.gen },
      });
    } catch (err) {
      if (isStaleFenceError(err))
        throw await this.staleHolder(held, id, p.plugin, fence, "create", err);
      if (!isFileSystemGoneError(err)) {
        throw providerRefusal(
          this.log,
          err,
          { deviceId: id, provider: p.plugin, op: "create" },
          limits,
          signal,
        );
      }
      this.log.warn("device file system is gone at the provider; its files are lost", {
        deviceId: id,
        provider: p.plugin,
      });
      await this.fenced(held, id, fence, { fs_status: "lost", status: "none" });
      throw deviceFilesLost();
    }
    let createdAt: Date;
    try {
      // the new instance's device report first, still under the lease and outside any
      // transaction: its revision is part of the identity the support below is recorded with (a
      // failure keeps the stored report and never fails the create)
      await runOutsideTransaction(() =>
        this.reports.refresh(p, { deviceId: id, orgId: ctx.orgId, handle }, signal),
      );
      // B-15: the instance's permission support, read from it under the lease and recorded with
      // the handle commit (an unread report never fails the create: the instance stays unprobed
      // until a later use records it)
      const support = this.recordsSupport(p)
        ? await this.cloudSupport(id, p, handle, signal)
        : undefined;
      createdAt = await runOutsideTransaction(() =>
        this.instanceWrites.commitHandle(
          ctx.orgId,
          id,
          fence.gen,
          rootsOf(handle),
          {
            status: "running",
            handle: JSON.stringify(handle),
            had_instance: true,
            // created_at is the generation commitHandle allocates (never a reused millisecond)
            running_since: sql<Date>`now()`,
            last_used_at: sql<Date>`now()`,
            ...(!atFileSystem && { instance_limits: record }),
          },
          held.signal,
          support,
        ),
      );
      fence.gen++;
    } catch (e) {
      // Lease lost (or the device read failed) before the handle was recorded: destroy the new
      // instance (best effort) so it does not leak. A provider that reuses instances by name
      // (Ruling M10) may then hit the one the new holder just resumed or created; that heals:
      // its next provider call throws SandboxGoneError (or resume returns gone) and the use
      // rebuilds in place. The file system is never touched here.
      await p.impl
        .destroy(handle, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS), tokenOf(fence))
        .catch((err: unknown) =>
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
   * Under the exclusive lease, on the running instance `handle` of `row` whose mode or network
   * kind differs from `want` (auto mode spec §4.2): the provider's `update` when it has
   * one; `updated` records `want`. Otherwise (`recreate`, no `update`, or the instance found gone
   * by `update`) the instance is destroyed and created again on the kept files, which records
   * `want` and is returned (the caller reports a restart). A provider whose limits are fixed at
   * its file system is not recreated (that would not apply them): `want` is recorded as
   * `unapplied` and the instance keeps running as is until a file reset.
   *
   * An `update` that fails otherwise never records `want`: a provider whose limits apply at
   * instance create is recreated (warned); after an abort, or for a provider bound to its file
   * system, the instance is suspended ({@link quarantine}) and the error thrown, so the next use
   * resumes it and tries again.
   *
   * `installedWider`: the call narrows an instance whose installed network allows more than its
   * record (issue #766). A provider bound to its file system that cannot apply `want` then is
   * quarantined too, with the intent kept, instead of being recorded `unapplied` and used: the
   * instance would run wider than the record claims.
   */
  private async applyLimits(
    ctx: SandboxUseContext,
    p: DeviceProviderEntry,
    held: SandboxLease,
    row: Row,
    handle: SandboxHandle,
    fence: Fence,
    signal: AbortSignal,
    want: DeviceLimits,
    installedWider = false,
  ): Promise<Instance | null> {
    const id = ctx.deviceId;
    const target = appliedOf(want);
    const rec = readInstanceLimits(row.instance_limits);
    const was = rec.applied;
    const facts = { deviceId: id, provider: p.plugin, from: was, to: target };
    let gone = false;
    if (p.impl.update) {
      // the intent first (device update fencing design §7.2): should this holder stop hearing
      // from the provider (a lost lease, a crash), the next exclusive holder applies the desired
      // limits again with its higher token, even when the record of what succeeded matches them
      await this.fenced(held, id, fence, {
        instance_limits: instanceLimitsJson(was, rec.unapplied ?? undefined, target),
      });
      let answer: "updated" | "recreate" | undefined;
      try {
        answer = await p.impl.update(handle, providerLimits(want), signal, { token: fence.gen });
      } catch (err) {
        // a newer holder already changed the instance: this one is stale and must neither record
        // nor recreate (a recreate by a stale holder is what the fence exists to stop)
        if (isStaleFenceError(err))
          throw await this.staleHolder(held, id, p.plugin, fence, "update", err);
        if (isSandboxGoneError(err)) {
          gone = true;
        } else if (signal.aborted || p.impl.limitsApplyAt === "fileSystem") {
          // the instance may run with half-applied limits and cannot be recreated here: stop it,
          // so the next use resumes it and applies them again (also after a lost lease: stopping
          // a possibly half-widened instance fails closed, at worst it pauses a newer holder's
          // work, which auto-starts on its next call; the intent makes it apply again)
          await this.quarantine(held, id, handle, p, fence, {
            provider: p.plugin,
            generation: String(row.created_at.getTime()),
          });
          // a provider bound to its file system that refuses the new network (E2B)
          throw providerRefusal(
            this.log,
            err,
            { deviceId: id, provider: p.plugin, op: "update" },
            want,
            signal,
          );
        } else {
          // a new instance gets the limits at create: recreate rather than trust a failed update
          this.log.warn("sandbox limits update failed; recreating the instance", {
            ...facts,
            err,
          });
        }
      }
      // outside the try: a failed record write is a lost lease, never a reason to recreate (a
      // holder whose fence moved must not destroy the instance a newer holder is using)
      if (answer === "updated") {
        await this.fenced(held, id, fence, { instance_limits: instanceLimitsJson(target) });
        this.log.info("sandbox instance limits updated", facts);
        return null;
      }
    }
    if (p.impl.limitsApplyAt === "fileSystem" && !gone) {
      if (installedWider) {
        // the instance enforces more than the record and the provider could not narrow it: stop
        // it, keep the intent (the next use resumes it and tries again); a file reset applies it
        await this.quarantine(held, id, handle, p, fence, {
          provider: p.plugin,
          generation: String(row.created_at.getTime()),
        });
        throw new Error(
          "The device's sandbox enforces a wider network than its recorded limits and the provider could not narrow it; the sandbox is stopped and the next use tries again (resetting the device's files also applies the limits)",
        );
      }
      await this.fenced(held, id, fence, { instance_limits: instanceLimitsJson(was, target) });
      this.log.info("sandbox limits changed; they apply when the device's files are reset", facts);
      return null;
    }
    this.log.info("sandbox limits changed; recreating the instance on the kept files", facts);
    // still the holder (a fenced write), so a holder whose lease ended meanwhile never destroys
    // what a newer one uses; the destroy's token is then this holder's latest
    await this.fenced(held, id, fence, {});
    if (!gone) {
      try {
        await p.impl.destroy(handle, signal, { token: fence.gen });
      } catch (err) {
        if (isStaleFenceError(err))
          throw await this.staleHolder(held, id, p.plugin, fence, "destroy", err);
        // `create` replaces an instance of the same name anyway
        if (signal.aborted) throw err;
        this.log.warn("cannot destroy the sandbox instance before recreating it", {
          deviceId: id,
          err,
        });
      }
    }
    return await this.lifecycleStep("recreate", id, p, signal, () =>
      this.create(ctx, p, held, row, fence, signal, want),
    );
  }

  /**
   * One lifecycle step on the provider (resume, create, recreate), logged when it ends with its
   * duration and outcome: `ok`, `aborted` (the use's signal, e.g. a tool call's time limit) or
   * `failed` (the error itself is thrown on, and logged by whoever handles it).
   */
  private async lifecycleStep<T>(
    step: "resume" | "create" | "recreate",
    deviceId: string,
    p: DeviceProviderEntry,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const done = (outcome: "ok" | "aborted" | "failed", extra: Record<string, unknown> = {}) =>
      this.log.info(`sandbox ${step} ${outcome}`, {
        deviceId,
        provider: p.plugin,
        durationMs: Date.now() - started,
        ...extra,
      });
    try {
      const r = await fn();
      done("ok", typeof r === "string" ? { answer: r } : {});
      return r;
    } catch (err) {
      done(
        signal.aborted ? "aborted" : "failed",
        signal.aborted ? {} : { error: err instanceof Error ? err.name : typeof err },
      );
      throw err;
    }
  }

  /**
   * After a failed `update` that cannot be repaired by a recreate: best effort, with fresh short
   * signals (the use's own may be aborted), suspends the instance (or revokes its operations) and
   * records it suspended (fenced: a lost lease leaves the record to the new holder).
   */
  private async quarantine(
    held: SandboxLease,
    id: string,
    handle: SandboxHandle,
    p: DeviceProviderEntry,
    fence: Fence,
    incarnation: RevokedIncarnation,
  ): Promise<void> {
    const suspended = await this.bestEffort(id, "suspend after a failed limits update", (s) =>
      p.impl.suspend(handle, s),
    );
    if (!suspended) {
      // still running with half-applied limits: its leftover operations are revoked exactly (the
      // row is recorded suspended, so the next resume revokes again)
      await this.bestEffort(id, "revoke the operations after a failed limits update", (s) =>
        this.revokeIncarnation(id, incarnation, handle, p, s, false),
      );
    }
    try {
      await this.fenced(held, id, fence, {
        status: "suspended",
        suspended_at: sql<Date>`now()`,
        running_since: null,
      });
    } catch (err) {
      this.log.warn("cannot record the sandbox suspended after a failed limits update", {
        deviceId: id,
        err,
      });
    }
  }

  /**
   * A provider refused a lifecycle call with `StaleFenceError` (device update fencing design
   * §7.1). Normally another holder took the device and applied a higher token, so this holder's
   * lease is gone: a fenced no-op write fails and the lock-lost error its next write would raise
   * is returned. Should the write succeed, the provider holds a token ahead of the device record
   * (a restored database, a provider fault): the row's generation is raised past it (fenced), so
   * the next holder's token wins and the device heals at its next use instead of refusing forever;
   * this use still fails as lock-lost.
   */
  private async staleHolder(
    held: SandboxLease,
    id: string,
    provider: string,
    fence: Fence,
    op: "update" | "create" | "destroy",
    err: unknown,
  ): Promise<SandboxLockLostError> {
    const current = isStaleFenceError(err) ? err.current : undefined;
    const facts = { deviceId: id, provider, op, token: fence.gen, current };
    try {
      await this.fenced(held, id, fence, {});
    } catch {
      this.log.warn("a device provider refused a stale lifecycle call; the lease was lost", facts);
      return new SandboxLockLostError(id, "generation");
    }
    if (current !== undefined && Number.isSafeInteger(current) && current >= fence.gen) {
      // org-filter: fenced write on the device this holder leases (entered after the org check, or
      // a sweep's device); the fence generation guards it
      const raised = await runOutsideTransaction(() =>
        this.db
          .updateTable("device_instances")
          .set({ generation: current + 1 })
          .where("device_id", "=", id)
          .where("generation", "=", fence.gen)
          .executeTakeFirst(),
      );
      if (Number(raised.numUpdatedRows) === 1) fence.gen = current + 1;
    }
    this.log.warn(
      "a device provider holds a fence token ahead of the device record; generation raised so " +
        "the next use applies again",
      facts,
    );
    return new SandboxLockLostError(id, "generation");
  }

  /** Runs `call` with its own short signal; a failure is warned and returns false. */
  private async bestEffort(
    deviceId: string,
    what: string,
    call: (signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> {
    try {
      await call(AbortSignal.timeout(MAINTENANCE_CALL_TIMEOUT_MS));
      return true;
    } catch (err) {
      this.log.warn(`cannot ${what}`, { deviceId, err });
      return false;
    }
  }

  /**
   * Destroys an instance an earlier kernel recorded in `prev_*` (left by a provider replaced back
   * then) with that provider: still loaded and destroyed → false; otherwise warns and returns true
   * (the record must be kept).
   */
  private async retire(
    id: string,
    provider: string,
    handle: SandboxHandle,
    signal: AbortSignal,
    fence: Fence,
  ): Promise<boolean> {
    const old = this.providers.forDevice(provider)?.impl;
    if (old) {
      try {
        await old.destroy(
          handle,
          AbortSignal.any([signal, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)]),
          tokenOf(fence),
        );
        return false;
      } catch (err) {
        // the previous provider's instance carries a higher token: this holder is stale
        if (isStaleFenceError(err)) throw new SandboxLockLostError(id, "generation");
        this.log.warn("cannot destroy a sandbox instance recorded from a previous provider", {
          deviceId: id,
          provider,
          err,
        });
        return true;
      }
    }
    this.log.warn(
      "a sandbox instance recorded from a previous provider that is not loaded may leak",
      { deviceId: id, provider },
    );
    return true;
  }

  /**
   * Under the lease: destroys the row's instance with its own provider `p` (and an instance an
   * earlier kernel recorded in `prev_*`). An instance without a handle (a create that ended before
   * the handle was recorded) is destroyed by name. Returns the `prev_*` patch.
   */
  private async destroyInstance(
    row: Row,
    p: DeviceProviderEntry,
    signal: AbortSignal,
    held: SandboxLease,
    fence: Fence,
  ): Promise<Patch> {
    const id = row.device_id;
    assertOwnRow(row, p);
    let prev: Patch = {};
    try {
      if (row.handle) {
        await p.impl.destroy(row.handle, signal, tokenOf(fence));
      } else if (row.status === "creating") {
        // the provider may have built it already: only the name finds it
        await p.impl.destroyByName(deviceResourceName(id), signal, tokenOf(fence));
      }
    } catch (err) {
      if (isStaleFenceError(err))
        throw await this.staleHolder(held, id, p.plugin, fence, "destroy", err);
      throw err;
    }
    if (row.prev_handle && row.prev_provider) {
      if (!(await this.retire(id, row.prev_provider, row.prev_handle, signal, fence))) {
        prev = { prev_provider: null, prev_handle: null };
      }
    }
    return prev;
  }

  /**
   * Under the lease: destroys the row's file system with its own provider `p` (by name when no
   * handle was recorded: `createFileSystem` may have finished before the kernel stopped).
   */
  private async destroyFiles(row: Row, p: DeviceProviderEntry, signal: AbortSignal): Promise<void> {
    assertOwnRow(row, p);
    const id = row.device_id;
    if (row.fs_handle !== null) await p.impl.destroyFileSystem(row.fs_handle, signal);
    else await p.impl.destroyFileSystemByName(deviceResourceName(id), signal);
  }

  /**
   * Under the lease: `instance` destroys the instance and marks the row `destroyed` (the file
   * system stays); `device` also destroys the file system and deletes the row.
   */
  private async destroyRow(
    row: Row,
    p: DeviceProviderEntry,
    held: SandboxLease,
    mode: "instance" | "device",
  ): Promise<void> {
    const id = row.device_id;
    const fence = { gen: row.generation };
    // the fenced increment first, so the token the provider calls carry is this holder's own
    // (strictly higher than any earlier holder's, device update fencing design §3.2)
    await this.fenced(held, id, fence, {});
    const signal = opSignal(held);
    const prev = await this.destroyInstance(row, p, signal, held, fence);
    // the provider's destroy resolved: confirmed destruction of exactly this incarnation (8.5
    // evidence), the same for every provider
    if (row.handle && isKnownProvider(p.plugin))
      await this.retirement.recordDestruction(id, p.plugin, String(row.created_at.getTime()));
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
      .where("org_id", "=", row.org_id)
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

  /** The loaded provider of an instance row (its own `provider`); undefined when not loaded. */
  private rowProvider(row: Row): DeviceProviderEntry | undefined {
    return this.providers.forDevice(row.provider);
  }

  /** The device was deleted, or its org was: the instance and the files go. */
  private deviceGone(
    eb: ExpressionBuilder<KernelDatabase, "device_instances">,
  ): Expression<SqlBool> {
    // org-filter: a sweep condition fragment (a deleted device of any org, correlated to the
    // instance row), run only by candidates(), inside its asPlatform
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
