import {
  DEVICE_SERVICE_ID_RE,
  DeviceAccessError,
  type DeviceServiceSpec,
  type DeviceServiceStatus,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { type DeviceServiceMethods, SandboxService } from "./sandbox.service.js";
import type { SandboxUseContext } from "./use-context.js";

/** The budget of the `ifRunning` ensure after a refresh applied new limits (a service restart). */
export const POST_APPLY_ENSURE_TIMEOUT_MS = 30_000;

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
 */
@Injectable()
export class DeviceServices {
  constructor(@Inject(SandboxService) private readonly sandbox: SandboxService) {}

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
      (h, p, sig) =>
        opts.ifRunning === true
          ? (p.ensureService as NonNullable<typeof p.ensureService>)(
              h,
              nameOnlySpec(spec.name),
              sig,
              {
                ifRunning: true,
              },
            )
          : (p.ensureService as NonNullable<typeof p.ensureService>)(h, spec, sig),
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
    const found = await this.ifRunningEnsure(use, name, signal);
    if (found === null || found.state !== "running") return found;
    if ((await this.sandbox.applyLimitsIfRunning(use, signal)) !== "applied") return found;
    // its own budget, never what the wait left of the caller's: a provider restarts the service
    // on the new network here (device-local), so a spent caller signal must not skip it
    return this.ifRunningEnsure(use, name, AbortSignal.timeout(POST_APPLY_ENSURE_TIMEOUT_MS));
  }

  /** An `ifRunning` ensure on the instance recorded now; null without a running instance. */
  private async ifRunningEnsure(
    use: SandboxUseContext,
    name: string,
    signal: AbortSignal,
  ): Promise<DeviceServiceStatus | null> {
    const current = await this.sandbox.currentInstance(use.deviceId);
    if (!current) return null;
    const r = await this.sandbox.ifRunning(
      use.deviceId,
      { createdAt: current.createdAt },
      async (p, h, sig) => {
        requireServices(p);
        return (p.ensureService as NonNullable<typeof p.ensureService>)(
          h,
          nameOnlySpec(name),
          sig,
          { ifRunning: true },
        );
      },
      signal,
    );
    return r.kind === "ran" ? r.value : null;
  }

  /** One request to the service's socket; resolves its answer (throws when it is not running). */
  async request(
    use: SandboxUseContext,
    name: string,
    body: Uint8Array,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    assertServiceName(name);
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

/** Refuses a provider that lacks any of the methods a service needs (`openStream` is optional). */
function requireServices(p: DeviceServiceMethods): void {
  if (!p.ensureService || !p.stopService || !p.serviceRequest)
    throw new DeviceAccessError(
      "capability_missing",
      "This device's provider cannot run device services; choose a device on a provider that supports them.",
    );
}
