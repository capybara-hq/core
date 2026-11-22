"use client";

import { useSyncExternalStore } from "react";
import { BRAND_COOKIE, type BrandRef, decodeBrandCookie } from "./brand-cookie";
import { cookieOf } from "./cookies";

const noSubscribe = () => () => {};

/** The last cookie value read and its decoding: a snapshot must keep its identity while unchanged. */
let last: { raw: string | undefined; ref: BrandRef | null } = { raw: undefined, ref: null };

/** The cookie's value, read as the server reads it (`cookieOf`); undefined where cookies throw. */
function rawCookie(): string | undefined {
  try {
    return cookieOf(document.cookie, BRAND_COOKIE);
  } catch {
    // an opaque origin (a sandboxed frame) throws on document.cookie: the built-in theme
    return undefined;
  }
}

function brandFromDocument(): BrandRef | null {
  const raw = rawCookie();
  if (raw !== last.raw) last = { raw, ref: decodeBrandCookie(raw) };
  return last.ref;
}

/**
 * The client side of `outsideTheme()` (theme brand coverage spec §5) for the pages that render in
 * the browser only (the root error pages): the brand cookie when valid, else null (the built-in
 * theme). The server snapshot is null, so the hydrated render matches the server's, then the
 * cookie's theme applies.
 */
export function useBrandCookie(): BrandRef | null {
  return useSyncExternalStore(noSubscribe, brandFromDocument, () => null);
}
