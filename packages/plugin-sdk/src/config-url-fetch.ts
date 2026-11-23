import type { ExtensionNet } from "./net.js";

function trimSlashes(u: string): string {
  return u.replace(/\/+$/, "");
}

/**
 * The `fetch` a plugin gives its vendor SDK for a URL taken from config that an org may override.
 *
 * `opts.url` is the URL in use (from the effective config of the org the call is made for) and
 * `opts.platform` is the platform's own value(s) of that field, read from `ctx.config` at call
 * time. When `url` equals a platform value (trailing slashes ignored) it is the platform's own
 * endpoint and the global `fetch` is returned; any other URL was set by an org, so the returned
 * function goes through `net.fetch` (the kernel's guarded client) with `opts.orgId`.
 *
 * Read `platform` from `ctx.config` each time you build the fetch: after the platform changes
 * its value, an org's old copy no longer equals it and is guarded. Pass the result as the vendor
 * SDK's `fetch` option.
 */
export function configUrlFetch(
  net: Pick<ExtensionNet, "fetch">,
  opts: {
    url: string;
    platform?: string | readonly string[] | undefined;
    orgId?: string | undefined;
  },
): typeof fetch {
  const platform =
    opts.platform === undefined
      ? []
      : typeof opts.platform === "string"
        ? [opts.platform]
        : opts.platform;
  const url = trimSlashes(opts.url);
  // An empty URL ("", "/") never counts as the platform's.
  if (url !== "" && platform.some((p) => trimSlashes(p) === url)) return fetch;
  const netOpts = opts.orgId === undefined ? {} : { orgId: opts.orgId };
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof input === "string") return net.fetch(input, init, netOpts);
    if (input instanceof URL) return net.fetch(input.href, init, netOpts);
    // A Request carries its method, headers, body and signal: forward them under any explicit init.
    const hasBody = input.method !== "GET" && input.method !== "HEAD";
    const fromRequest: RequestInit = {
      method: input.method,
      headers: input.headers,
      signal: input.signal,
      ...(hasBody ? { body: await input.clone().arrayBuffer() } : {}),
    };
    return net.fetch(input.url, { ...fromRequest, ...init }, netOpts);
  }) as typeof fetch;
}
