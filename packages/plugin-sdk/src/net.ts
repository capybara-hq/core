/**
 * Guarded outbound HTTP for URLs a person supplied (`ctx.net`).
 *
 * Rule: a request whose host comes from a person or from config an org admin or member can set (a
 * connector endpoint, an org-overridable base URL) goes through `ctx.net.fetch`, never the global
 * `fetch`; a fixed vendor host, or a URL only the super admin can set, may keep `fetch`.
 */

/** Why `ctx.net.fetch` refused a request (the codes of the kernel's guarded client). */
export type NetDeniedCode =
  | "net.insecure_url"
  | "net.private_address"
  | "net.dns_failed"
  | "net.redirect"
  | "net.proxy_refused";

/**
 * The request was refused by the kernel's network rules; `message` is English and names `host`.
 * Detect it with {@link isNetDeniedError} (by `name`), never `instanceof`, which fails across
 * package copies. Map it to the plugin's own actionable error (a connector's `ToolError` of kind
 * `invalid_input`, a provider's `ModelError` of kind `invalid_request`).
 */
export class NetDeniedError extends Error {
  override readonly name = "NetDeniedError" as const;

  constructor(
    readonly code: NetDeniedCode,
    readonly host: string,
    message: string,
  ) {
    super(message);
  }
}

/** True for a {@link NetDeniedError} from any copy of the SDK or the kernel (checked by `name`). */
export function isNetDeniedError(e: unknown): e is NetDeniedError {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  return o.name === "NetDeniedError" && typeof o.code === "string" && typeof o.host === "string";
}

/** `ctx.net`: the kernel's guarded HTTP client, no permission needed. */
export interface ExtensionNet {
  /**
   * The global `fetch` signature with the kernel's network rules applied: https only; private,
   * loopback and link-local addresses refused (link-local always), the address checked when the
   * connection is made (no DNS-rebinding window); the deployment's egress proxy honoured. Redirects
   * are never followed: with `redirect: "manual"` a 3xx response is returned as is, otherwise a 3xx
   * rejects with `net.redirect`. Bodies stream; no size cap. `init.signal` is combined with
   * `ctx.signal`.
   *
   * `opts.orgId` is the org the request is made for (e.g. `ConnectorOpenArgs.orgId`): only then may
   * the target be one of the internal endpoints a super admin allowed for that org. Without it only
   * public addresses are reachable. A refusal rejects with {@link NetDeniedError}.
   */
  fetch(url: string, init?: RequestInit, opts?: { orgId?: string }): Promise<Response>;
}
