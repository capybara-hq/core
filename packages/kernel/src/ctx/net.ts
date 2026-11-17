import {
  type ExtensionNet,
  type Logger,
  NetDeniedError as SdkNetDeniedError,
} from "@capybara-hq/plugin-sdk";
import type { Agent } from "undici";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { type LookupFn, NetDeniedError, type NetPolicy } from "../net/public-address.js";
import { safeFetch } from "../net/safe-fetch.js";
import type { OrgNetworkAllowances } from "../orgs/network-allowances.service.js";

/**
 * `ctx.net` (plugin safe fetch spec): the kernel's guarded client (`safeFetch`) for URLs a person
 * supplied. Per call:
 * - the policy is built fresh: `net.allowInsecureLoopback` (tests), the org's allowances read from
 *   PG when `opts.orgId` is given (no cache: a removal applies to the next request on every
 *   replica; another org's allowances never apply), public addresses only without an org, and the
 *   deployment's egress proxy (`net.httpsProxy` / `net.noProxy`: a proxied https request is
 *   resolved by the proxy, which then owns SSRF protection; IP-literal targets are still checked);
 * - loopback, link-local and cloud metadata addresses are refused whatever the allowances
 *   (loopback allowed only under `net.allowInsecureLoopback`);
 * - redirects are never followed: `redirect: "manual"` returns the 3xx response, otherwise a 3xx
 *   rejects with `net.redirect`;
 * - no body size cap (bodies stream); `init.signal` is combined with `ctx.signal`;
 * - a refusal rejects with the SDK's `NetDeniedError` and is logged at `warn` with the plugin, org,
 *   host and code (never the URL's path, query or headers).
 */

/** The kernel services `ctx.net` reads per call (built once by the extension host). */
export type ExtensionNetServices = {
  config: Pick<KernelConfigService, "get">;
  allowances: Pick<OrgNetworkAllowances, "policyFor">;
  /** Tests only: `safeFetch`'s DNS and dispatcher seams. */
  seams?: {
    lookup?: LookupFn;
    dispatcherFor?: (ips: string[]) => Agent;
    proxyDispatcherFor?: (proxyUrl: string) => Agent;
  };
};

/** What a refused private address tells the reader of an org-bound request. */
export const ORG_PRIVATE_HINT =
  "ask a super admin to allow this internal endpoint for the organization";

/** What a refused private address tells the reader of a request made outside an organization. */
export const NO_ORG_PRIVATE_HINT =
  "a request made outside an organization reaches public addresses only";

export function createExtensionNet(
  deps: ExtensionNetServices & {
    log: Pick<Logger, "warn">;
    plugin: string;
    /** `ctx.signal`: aborts every request of the instance. */
    signal: AbortSignal;
  },
): ExtensionNet {
  return {
    async fetch(url, init, opts) {
      const orgId = opts?.orgId;
      const net = deps.config.get().net;
      const exemptions = orgId
        ? await deps.allowances.policyFor(orgId)
        : { allowPrivateHosts: [], trustedOrigins: [] };
      const policy: NetPolicy = {
        allowInsecureLoopback: net.allowInsecureLoopback,
        allowPrivateHosts: exemptions.allowPrivateHosts,
        trustedOrigins: exemptions.trustedOrigins,
        ...(net.httpsProxy !== undefined && {
          proxy: { url: net.httpsProxy, noProxy: net.noProxy },
        }),
        extension: { privateHint: orgId ? ORG_PRIVATE_HINT : NO_ORG_PRIVATE_HINT },
      };
      const signal = init?.signal ? AbortSignal.any([deps.signal, init.signal]) : deps.signal;
      try {
        return await safeFetch(url, { ...init, signal }, policy, {
          redirects: init?.redirect === "manual" ? "return" : "refuse",
          ...deps.seams,
        });
      } catch (e) {
        if (!(e instanceof NetDeniedError)) throw e;
        deps.log.warn("ctx.net.fetch refused a request", {
          plugin: deps.plugin,
          orgId: orgId ?? null,
          host: e.host,
          code: e.code,
        });
        throw new SdkNetDeniedError(e.code, e.host, e.message, e.status);
      }
    },
  };
}
