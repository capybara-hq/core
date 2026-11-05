import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { ApiClientError, type ApiTransport } from "../api";
import { SESSION_STATE_HEADER } from "../headers";
import { kernelUrl } from "../kernel-proxy";
import { trustedPeer } from "../peer";

export { SESSION_STATE_HEADER };

/** How long a server read waits for the kernel. */
const SERVER_READ_TIMEOUT_MS = 10_000;

/** Request headers passed on to the kernel as they are. */
const FORWARDED = ["cookie", "accept-language", "x-request-id"] as const;

/** A kernel answer read once and replayed to every caller of the same path in one request. */
interface Answer {
  status: number;
  contentType: string | null;
  body: string;
}

/**
 * One GET per path per request (`React.cache`): a layout and a page that both read `/me` make one
 * call. The body is read here, since a Response body can be read only once.
 */
const cachedGet = cache(async (path: string): Promise<Answer> => {
  const incoming = await headers();
  if (incoming.get(SESSION_STATE_HEADER) === "unavailable") {
    throw new ApiClientError(0, "upstream_unavailable", "The kernel is unavailable");
  }
  const out = new Headers();
  for (const name of FORWARDED) {
    const value = incoming.get(name);
    if (value !== null) out.set(name, value);
  }
  const peer = trustedPeer(incoming);
  if (peer !== undefined) out.set("x-forwarded-for", peer);
  let res: Response;
  try {
    res = await fetch(`${kernelUrl()}${path}`, {
      method: "GET",
      headers: out,
      cache: "no-store",
      signal: AbortSignal.timeout(SERVER_READ_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ApiClientError(0, "network", e instanceof Error ? e.message : String(e));
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: await res.text(),
  };
});

/** Statuses whose Response may not carry a body. */
const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * The server side of `apiFetch`: reads only (anything but GET throws: the server never mutates),
 * never cached across requests, deduplicated within one.
 */
export const serverTransport: ApiTransport = async (path, init) => {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    throw new Error(`serverTransport: only GET is allowed on the server, got ${method} ${path}`);
  }
  const answer = await cachedGet(path);
  const h = new Headers();
  if (answer.contentType !== null) h.set("content-type", answer.contentType);
  return new Response(NULL_BODY.has(answer.status) ? null : answer.body, {
    status: answer.status,
    headers: h,
  });
};
