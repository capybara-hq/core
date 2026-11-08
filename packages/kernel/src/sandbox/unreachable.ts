import { isFileSystemGoneError, isSandboxGoneError } from "@capybara-hq/plugin-sdk";

/**
 * How a provider call failed to reach the provider: `connect` when no connection was made (the
 * request never reached the provider, so it did nothing), `dropped` when an open connection broke
 * (the provider may have acted before it broke).
 */
export type ProviderConnectionFailure = "connect" | "dropped";

/** Codes of a connection that was never made (node `net` / `dns`, undici). */
const CONNECT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
]);
/** Codes of a connection that broke after it was made. */
const DROPPED_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);
/** System calls that open a connection: any error code they fail with means no connection. */
const CONNECT_SYSCALLS: ReadonlySet<string> = new Set(["connect", "getaddrinfo"]);
const MAX_DEPTH = 5;

/**
 * Whether `e` is a network-level failure to reach the provider, and which kind. Providers may
 * wrap the socket error (`fetch failed` with a `cause`, an `AggregateError` of one error per
 * address, an SDK error with a `cause`), so the cause chain and `errors` are searched. The
 * provider's own verdicts (`SandboxGoneError`, `FileSystemGoneError`) are never connection
 * failures.
 */
export function providerConnectionFailure(
  e: unknown,
  depth = 0,
): ProviderConnectionFailure | undefined {
  if (depth > MAX_DEPTH || typeof e !== "object" || e === null) return undefined;
  if (isSandboxGoneError(e) || isFileSystemGoneError(e)) return undefined;
  const { code, syscall, message, cause, errors } = e as {
    code?: unknown;
    syscall?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (typeof code === "string") {
    if (CONNECT_CODES.has(code)) return "connect";
    if (typeof syscall === "string" && CONNECT_SYSCALLS.has(syscall)) return "connect";
    if (DROPPED_CODES.has(code)) return "dropped";
  }
  if (typeof message === "string" && /socket hang up/i.test(message)) return "dropped";
  let found: ProviderConnectionFailure | undefined;
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      const f = providerConnectionFailure(inner, depth + 1);
      if (f === "dropped") return f;
      found ??= f;
    }
  }
  return found ?? providerConnectionFailure(cause, depth + 1);
}

/**
 * A sandbox provider call that could not reach the provider (the socket proxy, the Docker daemon,
 * the E2B API is down or misaddressed). An ordinary error to the sandbox lifecycle (never "gone":
 * a network blip must not rebuild the instance); the tools turn it into an actionable tool error.
 * `cause` is the provider's error, unchanged.
 */
export class SandboxProviderUnreachableError extends Error {
  constructor(
    readonly failure: ProviderConnectionFailure,
    cause: unknown,
  ) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(
      `sandbox provider ${failure === "connect" ? "unreachable" : "connection dropped"}: ${why}`,
      { cause },
    );
    this.name = "SandboxProviderUnreachableError";
  }
}

function converted(e: unknown): unknown {
  if (e instanceof SandboxProviderUnreachableError) return e;
  const failure = providerConnectionFailure(e);
  return failure === undefined ? e : new SandboxProviderUnreachableError(failure, e);
}

/**
 * `impl` with every method's network-level failure rethrown as
 * {@link SandboxProviderUnreachableError} (other errors and results unchanged): the one place a
 * provider's connection failure is told apart from the kernel's own (database, Redis) failures.
 */
export function guardProviderConnection<P extends object>(impl: P): P {
  return new Proxy(impl, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        let r: unknown;
        try {
          r = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          throw converted(e);
        }
        if (r instanceof Promise) {
          return r.catch((e: unknown) => {
            throw converted(e);
          });
        }
        return r;
      };
    },
  });
}
