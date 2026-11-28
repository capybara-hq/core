import {
  DEVICE_SERVICE_ID_RE,
  DeviceAccessError,
  type DeviceServiceSpec,
  type DeviceServiceStatus,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { LockService } from "../infra/lock/lock.service.js";
import { LoopbackLivePorts } from "./loopback-live-ports.js";
import { PermissionFacts } from "./permission-facts.js";
import { type DeviceServiceMethods, SandboxService } from "./sandbox.service.js";
import type { SandboxUseContext } from "./use-context.js";

/** The budget of the `ifRunning` ensure after a refresh applied new limits (a service restart). */
export const POST_APPLY_ENSURE_TIMEOUT_MS = 30_000;

/** The lifetime of the loopback set lock without renewal (renewed while an ensure runs). */
export const LOOPBACK_SET_LOCK_TTL_MS = 30_000;
/** How long an ensure waits for another ensure of the same service to send its set. */
export const LOOPBACK_SET_LOCK_WAIT_MS = 60_000;

/**
 * Device services (browser use spec §5): one long-lived named process per device, started on an
 * extension's behalf in the device's own sandbox with its own state directory, reached by
 * request over its socket. Starting and requesting are uses of the device like any tool call
 * ({@link SandboxService.withDeviceServices}: a suspended instance is resumed); stopping never
 * starts or resumes one. A provider without the service methods is refused with
 * `DeviceAccessError("capability_missing")` before the device is touched. The command review of a
 * launch and the extension's permission are the caller's (`ctx.deviceAccess`). Every name here is
 * a service id (`<extension>.<name>`, `DEVICE_SERVICE_ID_RE`): the caller namespaces the
 * extension's service names, so the provider never sees a bare name two extensions could share.
 *
 * Every ensure sends the provider the service's live loopback port grants (browser loopback port
 * grants design §4: the whole sorted set), but only a non-empty set, and only while the device
 * sandbox admits loopback ports (`DeviceSandbox.loopbackPorts`: the provider's support reports
 * `network.loopbackPorts` and the ceilings allow running outside the sandbox). Otherwise
 * `loopbackPorts` is left out, which closes every loopback port: a provider without support never
 * sees the key, and a ceiling switched off narrows on the next ensure, before the refresh job
 * revokes the grants.
 * Reading the set and sending it are one step per (device, service) across replicas (a
 * `LockService` lock taken outside any transaction): an ensure that read an older set can never
 * reach the device after one that read a newer set.
 */
@Injectable()
export class DeviceServices {
  constructor(
    @Inject(SandboxService) private readonly sandbox: SandboxService,
    @Inject(LoopbackLivePorts) private readonly loopback: Pick<LoopbackLivePorts, "livePorts">,
    @Inject(LockService) private readonly locks: Pick<LockService, "run">,
    @Inject(PermissionFacts)
    private readonly facts: Pick<PermissionFacts, "deviceSandboxFacts">,
  ) {}

  /**
   * Runs `send` with the service's live loopback ports under the (device, service) set lock: the
   * set is read after the lock is taken and the send finishes before it is released, so the
   * sends reach the device in the order their sets were read. A lost lock aborts the send. The
   * opts carry `loopbackPorts` only for a non-empty set the device sandbox admits (see the class).
   */
  private withLoopbackSet<T>(
    orgId: string,
    deviceId: string,
    name: string,
    signal: AbortSignal,
    send: (loopback: { loopbackPorts?: number[] }, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.locks.run(
      `loopback-set-${deviceId}-${name}`,
      { ttlMs: LOOPBACK_SET_LOCK_TTL_MS, waitMs: LOOPBACK_SET_LOCK_WAIT_MS, signal },
      async (held) => {
        const ports = await this.loopback.livePorts(orgId, deviceId, name);
        const admitted =
          ports.length > 0 && (await this.facts.deviceSandboxFacts(orgId, deviceId)).box.loopbackPorts;
        return send(admitted ? { loopbackPorts: ports } : {}, AbortSignal.any([signal, held.lost]));
      },
    );
  }

  /**
   * Starts the service in the device, or finds it running (the provider keeps a running one).
   * With `ifRunning` it never starts one: a stopped service answers its `stopped` status, and the
   * provider gets only the name ({@link nameOnlySpec}), as with every ifRunning ensure. A spec
   * breaking {@link serviceSpecIssue} is refused before the device is touched.
   */
  async ensure(
    use: SandboxUseContext,
    spec: DeviceServiceSpec,
    signal: AbortSignal,
    opts: { ifRunning?: boolean } = {},
  ): Promise<DeviceServiceStatus> {
    assertServiceSpec(spec);
    return this.sandbox.withDeviceServices(
      use,
      requireServices,
      (h, p, sig) => {
        const ensure = p.ensureService as NonNullable<typeof p.ensureService>;
        // read under the use and the set lock, so a grant committed before it is in the set
        return this.withLoopbackSet(use.orgId, use.deviceId, spec.name, sig, (loopback, s) =>
          opts.ifRunning === true
            ? ensure(h, nameOnlySpec(spec.name), s, { ifRunning: true, ...loopback })
            : ensure(h, spec, s, loopback),
        );
      },
      signal,
    );
  }

  /**
   * Applies the device's current limits to the service when it runs (the device's allowlist
   * changed outside a tool call). An `ifRunning` ensure first: a stopped service needs nothing
   * now (the next use applies the limits), so it answers that status and the instance is left as
   * it is. A running one: the limits go to the running instance as a use's exclusive step applies
   * them ({@link SandboxService.applyLimitsIfRunning}: the provider's `update`, or a recreate on
   * the kept files, which ends the services with the old instance); once applied, a second
   * `ifRunning` ensure on the instance as it is recorded now, on its own budget
   * ({@link POST_APPLY_ENSURE_TIMEOUT_MS}, not `signal`: a provider that restarts a service on a
   * network change does it there). It never resumes or starts anything. The status, or null
   * without a running instance.
   */
  async refresh(
    use: SandboxUseContext,
    name: string,
    signal: AbortSignal,
  ): Promise<DeviceServiceStatus | null> {
    assertServiceName(name);
    const found = await this.ifRunningEnsure(use.orgId, use.deviceId, name, signal);
    if (found === null || found.state !== "running") return found;
    if ((await this.sandbox.applyLimitsIfRunning(use, signal)) !== "applied") return found;
    // its own budget, never what the wait left of the caller's: a provider restarts the service
    // on the new network here (device-local), so a spent caller signal must not skip it
    return this.ifRunningEnsure(
      use.orgId,
      use.deviceId,
      name,
      AbortSignal.timeout(POST_APPLY_ENSURE_TIMEOUT_MS),
    );
  }

  /**
   * Sends the service's live loopback port set to the running service (a grant, a revoke, an
   * expiry or a narrowing changed it): an `ifRunning` ensure only, no limits applied (the set is
   * the service's own, not the device's). A provider restarts the service when its set changed and
   * keeps it otherwise; a stopped service or instance needs nothing now (its next ensure sends the
   * set). The status, or null without a running instance.
   */
  async refreshLoopback(
    orgId: string,
    deviceId: string,
    name: string,
    signal: AbortSignal,
  ): Promise<DeviceServiceStatus | null> {
    assertServiceName(name);
    return this.ifRunningEnsure(orgId, deviceId, name, signal);
  }

  /**
   * An `ifRunning` ensure on the instance recorded now, with the service's live loopback ports;
   * null without a running instance.
   */
  private async ifRunningEnsure(
    orgId: string,
    deviceId: string,
    name: string,
    signal: AbortSignal,
  ): Promise<DeviceServiceStatus | null> {
    const current = await this.sandbox.currentInstance(deviceId);
    if (!current) return null;
    const r = await this.sandbox.ifRunning(
      deviceId,
      { createdAt: current.createdAt },
      async (p, h, sig) => {
        requireServices(p);
        const ensure = p.ensureService as NonNullable<typeof p.ensureService>;
        return this.withLoopbackSet(orgId, deviceId, name, sig, (loopback, s) =>
          ensure(h, nameOnlySpec(name), s, { ifRunning: true, ...loopback }),
        );
      },
      signal,
    );
    return r.kind === "ran" ? r.value : null;
  }

  /**
   * One request to the service's socket; resolves its answer (throws when it is not running).
   * A request is a use of the device: a suspended instance is resumed. With `ifRunning` it never
   * is: only the instance running now answers, under a shared lease that moves its last use
   * forward ({@link SandboxService.ifRunning}); a missing, suspended or replaced instance, or a
   * service the provider reports stopped, rejects with `DeviceAccessError("not_running")`.
   */
  async request(
    use: SandboxUseContext,
    name: string,
    body: Uint8Array,
    timeoutMs: number,
    signal: AbortSignal,
    opts: { ifRunning?: boolean } = {},
  ): Promise<Uint8Array> {
    assertServiceName(name);
    if (opts.ifRunning === true) return this.requestIfRunning(use, name, body, timeoutMs, signal);
    return this.sandbox.withDeviceServices(
      use,
      requireServices,
      (h, p, sig) =>
        (p.serviceRequest as NonNullable<typeof p.serviceRequest>)(h, name, body, {
          timeoutMs,
          signal: sig,
        }),
      signal,
    );
  }

  private async requestIfRunning(
    use: SandboxUseContext,
    name: string,
    body: Uint8Array,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const current = await this.sandbox.currentInstance(use.deviceId);
    if (!current) throw notRunning();
    const r = await this.sandbox.ifRunning(
      use.deviceId,
      { createdAt: current.createdAt },
      async (p, h, sig) => {
        requireServices(p);
        if (p.serviceStatus) {
          const st = await p.serviceStatus(h, name, sig);
          if (st !== null && st.state !== "running") throw notRunning();
        }
        return (p.serviceRequest as NonNullable<typeof p.serviceRequest>)(h, name, body, {
          timeoutMs,
          signal: sig,
        });
      },
      signal,
    );
    if (r.kind !== "ran") throw notRunning();
    return r.value;
  }

  /**
   * The service's state without starting or resuming anything (the provider's `serviceStatus`);
   * null when the device has no running instance (so no service runs) or the provider cannot
   * tell (it lacks `serviceStatus`).
   */
  async status(
    use: SandboxUseContext,
    name: string,
    signal: AbortSignal,
  ): Promise<DeviceServiceStatus | null> {
    assertServiceName(name);
    const current = await this.sandbox.currentInstance(use.deviceId);
    if (!current) return null;
    const r = await this.sandbox.ifRunning(
      use.deviceId,
      { createdAt: current.createdAt },
      async (p, h, sig) => {
        requireServices(p);
        return p.serviceStatus ? p.serviceStatus(h, name, sig) : null;
      },
      signal,
    );
    return r.kind === "ran" ? r.value : null;
  }

  /**
   * Stops the service when the device's instance runs; nothing to do otherwise (a suspended or
   * destroyed instance has no running service, and stopping never resumes it).
   */
  async stop(use: SandboxUseContext, name: string, signal: AbortSignal): Promise<void> {
    assertServiceName(name);
    const current = await this.sandbox.currentInstance(use.deviceId);
    if (!current) return;
    await this.sandbox.ifRunning(
      use.deviceId,
      { createdAt: current.createdAt },
      async (p, h, sig) => {
        requireServices(p);
        await (p.stopService as NonNullable<typeof p.stopService>)(h, name, sig);
      },
      signal,
    );
  }
}

/**
 * What every `ifRunning` ensure sends the provider: the service's name and nothing to run (the
 * provider reads only the name there; a restart for a network change runs the spec the service
 * was launched with, never a request's).
 */
export function nameOnlySpec(name: string): DeviceServiceSpec {
  return { name, runtime: "node", entry: "", args: [], files: {} };
}

/** Environment variables a service spec may not set: they change what runs, or are the provider's. */
const RESERVED_ENV =
  /^(NODE_.*|PATH|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_CONF|OPENSSL_ENGINES|LD_.*|DYLD_.*|CAPYBARA_.*|(HTTPS?|NO|ALL|FTP)_PROXY)$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why a service file path is refused, or null: relative, plain segments only. */
function servicePathIssue(path: string): string | null {
  if (path === "") return "is empty";
  if (path.includes("\0")) return "contains NUL";
  if (path.includes("\\")) return "contains a backslash";
  if (path.startsWith("/")) return "is absolute";
  for (const seg of path.split("/")) {
    if (seg === "") return "has an empty segment";
    if (seg === "." || seg === "..") return `has a "${seg}" segment`;
  }
  return null;
}

/**
 * Why a service spec is refused, or null (browser use spec §5): a valid service id; `entry` and every
 * `files` key relative inside the state directory (no absolute path, no `.` / `..` / empty
 * segment, no backslash, no NUL); `entry` one of the files; no env variable that changes what
 * runs or that the provider sets (`NODE_*`, `PATH`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
 * `OPENSSL_CONF`, `OPENSSL_ENGINES`, `LD_*`, `DYLD_*`, `CAPYBARA_*`, proxy variables), no NUL in
 * a value. So the reviewed command is the one that runs.
 */
export function serviceSpecIssue(spec: DeviceServiceSpec): string | null {
  if (typeof spec?.name !== "string" || !DEVICE_SERVICE_ID_RE.test(spec.name))
    return `the service id ${JSON.stringify(spec?.name)} must be <extension>.<name> (${DEVICE_SERVICE_ID_RE})`;
  if (typeof spec.entry !== "string") return "entry must be a string";
  const files = spec.files ?? {};
  for (const key of Object.keys(files)) {
    const why = servicePathIssue(key);
    if (why !== null) return `the file path ${JSON.stringify(key)} ${why}`;
  }
  const entryWhy = servicePathIssue(spec.entry);
  if (entryWhy !== null) return `the entry ${JSON.stringify(spec.entry)} ${entryWhy}`;
  if (!Object.hasOwn(files, spec.entry))
    return `the entry ${JSON.stringify(spec.entry)} is not one of the files`;
  if (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== "string" || a.includes("\0")))
    return "args must be strings without NUL";
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!ENV_NAME.test(k)) return `the env variable name ${JSON.stringify(k)} is not valid`;
    if (RESERVED_ENV.test(k))
      return `the env variable ${k} may not be set: it changes what runs, or the provider sets it`;
    if (typeof v !== "string" || v.includes("\0"))
      return `the env variable ${k} must be a string without NUL`;
  }
  return null;
}

/** Throws a TypeError naming what breaks {@link serviceSpecIssue}. */
export function assertServiceSpec(spec: DeviceServiceSpec): void {
  const why = serviceSpecIssue(spec);
  if (why !== null) throw new TypeError(`Invalid device service spec: ${why}.`);
}

function assertServiceName(name: string): void {
  if (!DEVICE_SERVICE_ID_RE.test(name))
    throw new Error(
      `Invalid device service id ${JSON.stringify(name)}: use <extension>.<name> (${DEVICE_SERVICE_ID_RE}).`,
    );
}

/** An `ifRunning` request found no running instance or service. */
function notRunning(): DeviceAccessError {
  return new DeviceAccessError(
    "not_running",
    "The device or its service is not running; nothing was resumed or started.",
  );
}

/** Refuses a provider that lacks any of the methods a service needs (`openStream` is optional). */
function requireServices(p: DeviceServiceMethods): void {
  if (!p.ensureService || !p.stopService || !p.serviceRequest)
    throw new DeviceAccessError(
      "capability_missing",
      "This device's provider cannot run device services; choose a device on a provider that supports them.",
    );
}
