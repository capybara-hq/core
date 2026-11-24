import { randomUUID } from "node:crypto";
import {
  type ExecResult,
  type SandboxLimits,
  type SandboxOperationScope,
  SandboxPermissionUnsupportedError,
} from "@capybara-hq/plugin-sdk";
import {
  checkRoots,
  type DeviceOwnerCeiling,
  type LocalOperationGrant,
} from "../exec/operation-types.js";
import type { MacWorkerHandle, MacWorkerRequest } from "../exec/operation-worker.js";
import { shellQuote } from "../exec/shared.js";
import { effectiveEgress, type SandboxEgress } from "../policy.js";
import type { ServiceLaunch, ServiceLauncher, ServiceProcess } from "./supervisor.js";

/**
 * The longest time limit a worker timer holds (Node's 32-bit timer): a service runs at most this
 * long (24.8 days) before the in-sandbox limit ends it, like any command's limit.
 */
export const SERVICE_TIME_LIMIT_MS = 2_147_483_647;

/** The service output kept for a failed start's error message. */
const OUTPUT_TAIL = 4096;

export interface MacServiceLauncherOptions {
  deviceId: string;
  /** This connection's state directory (where the worker stages its private source). */
  stateDir: string;
  pythonPath: string;
  /** The bound generation's attested runtime hash; undefined while unbound. */
  runtimeHash: () => string | undefined;
  readOwnerCeiling: () => Promise<DeviceOwnerCeiling>;
  startWorker: (request: MacWorkerRequest, signal: AbortSignal) => Promise<MacWorkerHandle>;
}

/**
 * The macOS service launcher (browser use spec §5): a service is one restricted exec of the
 * operation worker, from the sealed runtime the binding attested, so it runs under exactly the
 * sandbox operations run under and gets the same proxy environment. Its grant is fixed here, never
 * by a kernel scope: writes only in its state directory and `<workspace>/downloads`; reads of
 * those, its read-only code directory, the workspace and the Node runtime's directory (all
 * checked against the owner's denies); the owner's denied read roots kept denied; the unix socket
 * in its state directory; and the device's network (the provider's limits) intersected with the
 * owner's ceiling as for an operation, no network when the provider sent none. It has no time
 * limit of its own beyond {@link SERVICE_TIME_LIMIT_MS} and is stopped by cancelling the worker,
 * which also ends it when this program ends (the worker stops on disconnect). The launch records
 * the ceiling revision its grant was built under, so an owner reconcile stops it once the
 * ceiling changes (`ServiceSupervisor.reconcile`).
 */
export function macServiceLauncher(o: MacServiceLauncherOptions): ServiceLauncher {
  /** The device's network intersected with the owner's ceiling now; undefined = none. */
  const egressOf = (
    ceiling: DeviceOwnerCeiling,
    network: SandboxLimits["network"] | undefined,
  ): SandboxEgress | undefined =>
    network
      ? effectiveEgress(
          {
            ownerCeiling: { network: ceiling.network },
            allowedDomains: [...ceiling.allowedDomains],
          },
          network,
        )
      : undefined;
  return {
    // the key of the effective egress, so a narrowed (or widened) owner ceiling restarts the
    // service at the next ensure, as a changed device network does
    async networkKey(network) {
      const egress = egressOf(await o.readOwnerCeiling(), network);
      if (!egress) return "none";
      if (egress.kind === "open-public") return "open-public";
      return `allowlist:${[...new Set(egress.hosts.map((h) => h.toLowerCase()))].sort().join(",")}`;
    },
    async ceilingRevision() {
      return (await o.readOwnerCeiling()).revision;
    },
    async launch(req: ServiceLaunch, signal: AbortSignal): Promise<ServiceProcess> {
      signal.throwIfAborted();
      const runtimeHash = o.runtimeHash();
      if (!runtimeHash)
        throw new SandboxPermissionUnsupportedError(
          "The instance is not bound yet; the deployment binds it before starting services",
        );
      const ceiling = await o.readOwnerCeiling();
      // the service's roots are the device's own (its state directory, the workspace downloads,
      // the Node runtime's directory), outside any project reach by design, so they are held to
      // the owner's denies as preparation roots are: none may be or pass through a link into a
      // denied path or another connection, or sit in a system socket directory
      checkRoots(req.readRoots, req.writeRoots, ceiling, true);
      const egress = egressOf(ceiling, req.network);
      const open = egress?.kind === "open-public";
      const hosts = egress?.kind === "allowlist" ? egress.hosts : [];
      const grant: LocalOperationGrant = {
        full: false,
        ...(open && { openNetwork: true }),
        readRoots: req.readRoots,
        writeRoots: req.writeRoots,
        hosts,
        deniedReadRoots: [...ceiling.restrictedDeniedReadRoots],
        revision: ceiling.revision,
      };
      const operationId = `service-${req.name}-${randomUUID()}`;
      // a service belongs to no conversation: the worker reads only the device id of this scope
      // (its temporary directory parent is not used, the service has its own)
      const scope: SandboxOperationScope = {
        operationId,
        admitBeforeMs: Date.now() + 60_000,
        deviceId: o.deviceId,
        rootConversationId: "device-service",
        profileRevision: 0,
        ceilingRevision: ceiling.revision,
        profile: "request-approval",
        actor: { accountId: "device-service", conversationId: "device-service" },
        tag: operationId,
        filesystem: { kind: "scoped", projectRoot: null, writeRoots: req.writeRoots },
        network: open
          ? { kind: "open-public" }
          : hosts.length > 0
            ? { kind: "allowlist", hosts }
            : { kind: "none" },
      };
      let tail = "";
      const request: MacWorkerRequest = {
        kind: "exec",
        scope,
        grant,
        stateDir: o.stateDir,
        pythonPath: o.pythonPath,
        runtimeHash,
        service: { tmpDir: req.tmpDir, unixSockets: req.unixSockets },
        beforeLaunch: async () => signal.throwIfAborted(),
        onLaunch: async () => {},
        onOutput: (bytes) => {
          tail = (tail + bytes.toString("utf8")).slice(-OUTPUT_TAIL);
        },
        args: {
          command: req.argv.map(shellQuote).join(" "),
          cwd: req.cwd,
          env: req.env,
          timeoutMs: SERVICE_TIME_LIMIT_MS,
          maxOutputBytes: 65536,
        },
      };
      // the start's signal bounds the launch only; the service outlives it
      const ctl = new AbortController();
      const onAbort = () => ctl.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const worker = await o.startWorker(request, ctl.signal);
        await worker.ready;
        const exited = worker.completion.then(
          (r) => ({ code: (r as ExecResult).exitCode }),
          () => ({ code: null }),
        );
        return {
          ceilingRevision: ceiling.revision,
          exited,
          async stop(graceMs) {
            await worker.cancel("Device service stopped", graceMs).catch(() => ctl.abort());
            await exited;
          },
          output: () => tail,
        };
      } catch (error) {
        ctl.abort();
        throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
