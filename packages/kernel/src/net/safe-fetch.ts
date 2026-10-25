import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  isLoopbackHost,
  type LookupFn,
  NetDeniedError,
  type NetPolicy,
  normalizeHost,
  resolvePublic,
} from "./public-address.js";

/**
 * `fetch` for URLs that come from a marketplace or an admin (spec §5.1):
 * - https only; plain http only for a loopback host under `allowInsecureLoopback` (testing);
 * - the host is resolved once by {@link resolvePublic} and the connection goes to the checked
 *   addresses: a per-request undici `Agent` whose `connect.lookup` answers only those addresses,
 *   so there is no second DNS lookup (no rebinding), while the Host header and TLS SNI keep the
 *   original hostname;
 * - redirects are never followed: a 3xx (other than 304) is {@link NetDeniedError} `net.redirect`;
 * - with `maxBytes`, a declared or streamed body over the limit is {@link NetBodyTooLargeError}.
 */

/** The response body is larger than `maxBytes`. */
export class NetBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`the response is larger than ${maxBytes} bytes`);
    this.name = "NetBodyTooLargeError";
  }
}

type PinnedLookup = (
  hostname: string,
  options: { all?: boolean },
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

/** A `net.connect` lookup that answers only the checked addresses, whatever the hostname. */
function pinnedLookup(ips: string[]): PinnedLookup {
  const all: LookupAddress[] = ips.map((address) => ({
    address,
    family: isIP(address) === 6 ? 6 : 4,
  }));
  return (_hostname, options, callback) => {
    if (options.all) callback(null, all);
    else callback(null, all[0]?.address ?? "", all[0]?.family ?? 4);
  };
}

/**
 * An undici dispatcher whose connections go only to `ips` (already checked), whatever the URL's
 * hostname; the hostname still names the Host header and TLS SNI. One agent per download.
 */
export function pinnedAgent(ips: string[]): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(ips) } as never });
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function capBody(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) controller.error(new NetBodyTooLargeError(maxBytes));
        else controller.enqueue(chunk);
      },
    }),
  );
}

export async function safeFetch(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  policy: NetPolicy,
  opts: { lookup?: LookupFn; maxBytes?: number } = {},
): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new NetDeniedError("net.insecure_url", "", "The URL is not valid.");
  }
  const host = normalizeHost(target.hostname);
  const insecureOk =
    policy.allowInsecureLoopback && target.protocol === "http:" && isLoopbackHost(host);
  if (target.protocol !== "https:" && !insecureOk) {
    throw new NetDeniedError("net.insecure_url", host, `The URL must use https (${host}).`);
  }
  // getaddrinfo cannot be cancelled: stop waiting for it when the caller gives up
  init.signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(init.signal.reason);
    init.signal.addEventListener("abort", onAbort, { once: true });
  });
  let ips: string[];
  try {
    ips = await Promise.race([resolvePublic(host, policy, opts.lookup), aborted]);
  } finally {
    init.signal.removeEventListener("abort", onAbort);
  }
  const agent = pinnedAgent(ips);
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(target, {
      ...(init as object),
      redirect: "manual",
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1]);
  } catch (e) {
    await agent.destroy().catch(() => {});
    throw e;
  }
  // close() waits for the in-flight request (the body still being read) before it closes
  void agent.close().catch(() => {});
  if (res.status >= 300 && res.status < 400 && res.status !== 304) {
    await res.body?.cancel().catch(() => {});
    throw new NetDeniedError(
      "net.redirect",
      host,
      `${host} responded with a redirect (${res.status}); redirects are not followed.`,
    );
  }
  const max = opts.maxBytes;
  if (max !== undefined) {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel().catch(() => {});
      throw new NetBodyTooLargeError(max);
    }
  }
  const raw = res.body as ReadableStream<Uint8Array> | null;
  const body =
    raw === null || NULL_BODY_STATUS.has(res.status)
      ? null
      : max === undefined
        ? raw
        : capBody(raw, max);
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: new Headers([...res.headers]),
  });
}
