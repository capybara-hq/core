import {
  DEVICE_SERVICE_MAX_MESSAGE,
  isSandboxPermissionUnsupportedError,
  type SandboxLimits,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { ENV_NAME_RE } from "../exec/shared.js";
import { type LocalServiceSpec, ServiceSpecError, type ServiceSupervisor } from "./supervisor.js";

/** The longest a `service.request` may wait for the service's answer. */
export const MAX_SERVICE_REQUEST_TIMEOUT_MS = 600_000;

/**
 * The service request bodies the device-local provider sends on the dial-in relay (browser use
 * plan Task 10/11), beside the device protocol's `{ op, args }` operations:
 *
 * - `{ op: "service.ensure", spec: { name, entry, args, files, env? }, network? }` answers the
 *   `DeviceServiceStatus`; `files` values are standard base64; `network` is the device's network
 *   as the provider holds it (its limits), absent = no network.
 * - `{ op: "service.stop", name }` answers null.
 * - `{ op: "service.status", name }` answers the `DeviceServiceStatus`.
 * - `{ op: "service.request", name, body, timeoutMs }` answers `{ body }` (base64 both ways).
 */
export type ServiceOpBody =
  | { op: "service.ensure"; spec: LocalServiceSpec; network?: SandboxLimits["network"] }
  | { op: "service.stop"; name: string }
  | { op: "service.status"; name: string }
  | { op: "service.request"; name: string; body: Uint8Array; timeoutMs: number };

/** The answer body of a service op (the `res` envelope's body). */
export type ServiceOpAnswer =
  | { ok: true; result: unknown }
  | { ok: false; error: { kind: "invalid" | "unsupported" | "error"; message: string } };

/** Whether a relay body is a service op (`op` starting with `service.`), not a device operation. */
export function isServiceOpBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { op?: unknown }).op === "string" &&
    (body as { op: string }).op.startsWith("service.")
  );
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

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
  if (!BASE64_RE.test(s)) invalid(`${what} must be standard padded base64`);
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** Strictly parses a service op body; throws {@link ServiceSpecError}. */
export function parseServiceOpBody(body: unknown): ServiceOpBody {
  const o = record(body, "A service request");
  const op = o.op;
  if (op === "service.ensure") {
    keys(o, ["op", "spec", "network"], "service.ensure");
    const s = record(o.spec, "service.ensure spec");
    keys(s, ["name", "runtime", "entry", "args", "files", "env"], "service.ensure spec");
    if (s.runtime !== undefined && s.runtime !== "node")
      invalid('service.ensure spec runtime must be "node"');
    if (!Array.isArray(s.args) || s.args.length > 256) invalid("spec.args must be a string array");
    const files: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(record(s.files, "spec.files")))
      files[k] = base64(v, `spec.files[${k}]`);
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
        entry: str(s.entry, "spec.entry", 512),
        args: s.args.map((a, i) => str(a, `spec.args[${i}]`, 65536)),
        files,
        ...(env && { env }),
      },
      ...(network && { network }),
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
        return { ok: true, result: await services.ensure(parsed.spec, parsed.network, signal) };
      case "service.stop":
        await services.stop(parsed.name, signal);
        return { ok: true, result: null };
      case "service.status":
        return { ok: true, result: services.status(parsed.name) };
      case "service.request": {
        const reply = await services.request(parsed.name, parsed.body, {
          timeoutMs: parsed.timeoutMs,
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
          error instanceof ServiceSpecError
            ? "invalid"
            : isSandboxPermissionUnsupportedError(error)
              ? "unsupported"
              : "error",
        message,
      },
    };
  }
}
