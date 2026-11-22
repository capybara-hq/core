"use client";

import { useSyncExternalStore } from "react";
import { type BrandRef, brandCookieOf } from "./brand-cookie";

const noSubscribe = () => () => {};

/** The last cookies read and their decoding: a snapshot must keep its identity while unchanged. */
let last: { raw: string | null; ref: BrandRef | null } = { raw: null, ref: null };

/** The page's cookies; null where cookies throw. */
function rawCookies(): string | null {
  try {
    return document.cookie;
  } catch {
    // an opaque origin (a sandboxed frame) throws on document.cookie: the built-in theme
    return null;
  }
}

function brandFromDocument(): BrandRef | null {
  const raw = rawCookies();
  if (raw !== last.raw) last = { raw, ref: brandCookieOf(raw, location.protocol === "https:") };
  return last.ref;
}

/**
 * The client side of `outsideTheme()` (theme brand coverage spec §5) for the pages that render in
 * the browser only (the root error pages): the brand cookie of the page's mode (`__Host-cb-brand`
 * over https, `cb-brand` over http, `brandCookieOf`) when valid, else null (the built-in
 * theme). The server snapshot is null, so the hydrated render matches the server's, then the
 * cookie's theme applies.
 */
export function useBrandCookie(): BrandRef | null {
  return useSyncExternalStore(noSubscribe, brandFromDocument, () => null);
}
