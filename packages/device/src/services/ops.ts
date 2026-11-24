import {
  DEVICE_SERVICE_MAX_MESSAGE,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  type SandboxLimits,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { ENV_NAME_RE } from "../exec/shared.js";
import {
  FILES_DIGEST_RE,
  type LocalServiceSpec,
  ServiceFilesNeededError,
  ServiceSpecError,
  type ServiceSupervisor,
} from "./supervisor.js";

/** How long before the envelope's deadline a `service.request` stops waiting, to answer in time. */
export const DEADLINE_MARGIN_MS = 250;

/** The longest a `service.request` may wait for the service's answer. */
export const MAX_SERVICE_REQUEST_TIMEOUT_MS = 600_000;

/**
 * The service request bodies the device-local provider sends on the dial-in relay (browser use
 * plan Task 10/11), beside the device protocol's `{ op, args }` operations:
 *
 * - `{ op: "service.ensure", spec: { name, entry, args, files, env? }, network?, ifRunning? }`
 *   answers the `DeviceServiceStatus`; `files` values are standard base64; `network` is the
 *   device's network as the provider holds it (its limits), absent = no network; a running service
 *   started with another network is restarted with this one; `ifRunning: true` reads only
 *   `spec.name` (device-local sends `{ name }`; `entry` and `args` may then be left out), starts nothing when
 *   the service is stopped (it answers the stopped status) and restarts a running one whose
 *   network changed from the spec it was launched with and its stored code. `files` may be left
 *   out when `filesDigest` (the provider's opaque name for the files, {@link FILES_DIGEST_RE}) is
 *   given: a start then uses the files already in the service's code directory
 *   (`<device dir>/svc-files/<name>`) when they were written under the same digest, and otherwise
 *   answers `files_needed` (send again with the files). A start with neither files nor a digest
 *   answers `files_needed` too.
 * - `{ op: "service.stop", name }` answers null.
 * - `{ op: "service.status", name }` answers the `DeviceServiceStatus`.
 * - `{ op: "service.request", name, body, timeoutMs }` answers `{ body }` (base64 both ways).
 */
export type ServiceOpBody =
  | {
      op: "service.ensure";
      spec: LocalServiceSpec;
      network?: SandboxLimits["network"];
      ifRunning?: boolean;
      filesDigest?: string;
    }
  | { op: "service.stop"; name: string }
  | { op: "service.status"; name: string }
  | { op: "service.request"; name: string; body: Uint8Array; timeoutMs: number };

/** The answer body of a service op (the `res` envelope's body). */
export type ServiceOpAnswer =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: {
        kind: "invalid" | "unsupported" | "denied" | "files_needed" | "error";
        message: string;
      };
    };

/** Whether a relay body is a service op (`op` starting with `service.`), not a device operation. */
export function isServiceOpBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { op?: unknown }).op === "string" &&
    (body as { op: string }).op.startsWith("service.")
  );
}

// One flat character class with the padding at the end, plus a length check: a repeated group
// (`(?:[…]{4})*`) overflows the regex stack on the megabytes of a service's files.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function invalid(message: string): never {
  throw new ServiceSpecError(message);
}

function record(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) invalid(`${what} must be an object`);
  return v as Record<string, unknown>;
}

function keys(o: Record<string, unknown>, allowed: string[], what: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) invalid(`${what} has unknown key ${k}`);
}

function str(v: unknown, what: string, max = 4096): string {
  if (typeof v !== "string" || v.length > max) invalid(`${what} must be a string`);
  return v;
}

function base64(v: unknown, what: string): Uint8Array {
  const s = str(v, what, Number.MAX_SAFE_INTEGER);
  if (s.length % 4 !== 0 || !BASE64_RE.test(s)) invalid(`${what} must be standard padded base64`);
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** Strictly parses a service op body; throws {@link ServiceSpecError}. */
export function parseServiceOpBody(body: unknown): ServiceOpBody {
  const o = record(body, "A service request");
  const op = o.op;
  if (op === "service.ensure") {
    keys(o, ["op", "spec", "network", "ifRunning", "filesDigest"], "service.ensure");
    if (
      o.filesDigest !== undefined &&
      (typeof o.filesDigest !== "string" || !FILES_DIGEST_RE.test(o.filesDigest))
    )
      invalid("service.ensure filesDigest must be 1 to 128 characters of A-Z a-z 0-9 : _ -");
    if (o.ifRunning !== undefined && typeof o.ifRunning !== "boolean")
      invalid("service.ensure ifRunning must be a boolean");
    const s = record(o.spec, "service.ensure spec");
    keys(s, ["name", "runtime", "entry", "args", "files", "env"], "service.ensure spec");
    if (s.runtime !== undefined && s.runtime !== "node")
      invalid('service.ensure spec runtime must be "node"');
    // ifRunning reads only the name: device-local sends `{ name }` there, the kernel's fuller
    // `{ name, entry: "", args: [], files: {} }` passes too
    const nameOnly = o.ifRunning === true;
    const entry = nameOnly && s.entry === undefined ? "" : s.entry;
    const args = nameOnly && s.args === undefined ? [] : s.args;
    if (!Array.isArray(args) || args.length > 256) invalid("spec.args must be a string array");
    let files: Record<string, Uint8Array> | undefined;
    if (s.files !== undefined) {
      files = {};
      for (const [k, v] of Object.entries(record(s.files, "spec.files")))
        files[k] = base64(v, `spec.files[${k}]`);
    }
    let env: Record<string, string> | undefined;
    if (s.env !== undefined) {
      env = {};
      for (const [k, v] of Object.entries(record(s.env, "spec.env"))) {
        if (!ENV_NAME_RE.test(k)) invalid(`spec.env has an invalid variable name ${k}`);
        env[k] = str(v, `spec.env.${k}`, 65536);
      }
    }
    let network: SandboxLimits["network"] | undefined;
    if (o.network !== undefined) {
      const n = record(o.network, "network");
      keys(n, ["kind", "hosts"], "network");
      if (n.kind !== "open-public" && n.kind !== "allowlist")
        invalid('network.kind must be "open-public" or "allowlist"');
      if (!Array.isArray(n.hosts) || n.hosts.length > 1000)
        invalid("network.hosts must be an array");
      const hosts = n.hosts.map((h) => str(h, "network.hosts entry", 253));
      for (const h of hosts)
        if (validateAllowHost(h).length > 0) invalid(`network.hosts has an invalid host ${h}`);
      network = { kind: n.kind, hosts };
    }
    return {
      op,
      spec: {
        name: str(s.name, "spec.name", 64),
        entry: str(entry, "spec.entry", 512),
        args: args.map((a, i) => str(a, `spec.args[${i}]`, 65536)),
        ...(files && { files }),
        ...(env && { env }),
      },
      ...(network && { network }),
      ...(o.ifRunning === true && { ifRunning: true }),
      ...(typeof o.filesDigest === "string" && { filesDigest: o.filesDigest }),
    };
  }
  if (op === "service.stop" || op === "service.status") {
    keys(o, ["op", "name"], op);
    return { op, name: str(o.name, `${op} name`, 64) };
  }
  if (op === "service.request") {
    keys(o, ["op", "name", "body", "timeoutMs"], op);
    const timeoutMs = o.timeoutMs;
    if (
      typeof timeoutMs !== "number" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_SERVICE_REQUEST_TIMEOUT_MS
    )
      invalid(
        `service.request timeoutMs must be an integer from 1 to ${MAX_SERVICE_REQUEST_TIMEOUT_MS}`,
      );
    const decoded = base64(o.body, "service.request body");
    if (decoded.byteLength > DEVICE_SERVICE_MAX_MESSAGE)
      invalid(`service.request body exceeds ${DEVICE_SERVICE_MAX_MESSAGE} bytes`);
    return { op, name: str(o.name, "service.request name", 64), body: decoded, timeoutMs };
  }
  return invalid(`Unknown service operation ${String(op)}`);
}

/**
 * Serves one service op body: parses it strictly, then asks the supervisor. Never throws: a
 * malformed body answers `invalid`, a host without services `unsupported`, any other failure
 * `error`, each with an actionable message.
 */
export async function serveServiceOp(
  services: ServiceSupervisor | undefined,
  body: unknown,
  signal: AbortSignal,
  /** The request envelope's deadline: a `service.request` wait ends before it, with an answer. */
  opts: { deadlineMs?: number } = {},
): Promise<ServiceOpAnswer> {
  try {
    const parsed = parseServiceOpBody(body);
    if (!services)
      return {
        ok: false,
        error: { kind: "unsupported", message: "This device program serves no device services" },
      };
    switch (parsed.op) {
      case "service.ensure":
        return {
          ok: true,
          result: await services.ensure(parsed.spec, parsed.network, signal, {
            ...(parsed.ifRunning && { ifRunning: true }),
            ...(parsed.filesDigest !== undefined && { filesDigest: parsed.filesDigest }),
          }),
        };
      case "service.stop":
        await services.stop(parsed.name, signal);
        return { ok: true, result: null };
      case "service.status":
        return { ok: true, result: services.status(parsed.name) };
      case "service.request": {
        const timeoutMs =
          opts.deadlineMs === undefined
            ? parsed.timeoutMs
            : Math.max(1, Math.min(parsed.timeoutMs, opts.deadlineMs - DEADLINE_MARGIN_MS));
        const reply = await services.request(parsed.name, parsed.body, {
          timeoutMs,
          signal,
        });
        return { ok: true, result: { body: Buffer.from(reply).toString("base64") } };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        kind:
          error instanceof ServiceFilesNeededError
            ? "files_needed"
            : error instanceof ServiceSpecError
              ? "invalid"
              : isSandboxPermissionUnsupportedError(error)
                ? "unsupported"
                : isSandboxScopeDeniedError(error)
                  ? "denied"
                  : "error",
        message,
      },
    };
  }
}
