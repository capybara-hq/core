"use client";

import { useMemo } from "react";
import { apiFetch } from "./api";
import { safeReturnTo } from "./auth-sources";
import { parseConnectResult } from "./connect";
import { parseLinkError } from "./identities";
import { useOpenExternalCapability } from "./shell";

/**
 * A shell's browser handoff (spec 2026-11-28-shell-external-authorization-design.md): in a native
 * shell, connector OAuth and login linking finish in the system browser. The start routes answer
 * a single-use `handoffUrl` instead of the provider's address; the web opens it through
 * `openExternal@1` and waits in the external authorization dialog.
 */

/** The request body's `handoff` part: the shell's own scheme, when it names one. */
export interface HandoffRequest {
  returnScheme?: string;
}

/** The browser handoff a shell offers, or undefined in a browser. */
export interface BrowserHandoff {
  /** The shell's own URL scheme (the done page links back through `<scheme>://open?url=`). */
  returnScheme?: string;
  /** Opens a URL in the system browser. Call it only from event-driven code (a click's work). */
  openExternal(url: string): Promise<void>;
}

/** The body part a start sends with a handoff. */
export const handoffRequest = (h: BrowserHandoff): HandoffRequest =>
  h.returnScheme === undefined ? {} : { returnScheme: h.returnScheme };

/**
 * The browser handoff of the shell the page runs in: defined exactly while the shell offers
 * `openExternal@1` (detected only through `window.capybaraShell`). Keeps its reference while the
 * capability object does.
 */
export function useBrowserHandoff(): BrowserHandoff | undefined {
  const cap = useOpenExternalCapability();
  return useMemo(() => {
    if (cap === undefined || typeof cap.open !== "function") return undefined;
    const scheme = typeof cap.returnScheme === "string" ? cap.returnScheme : undefined;
    return {
      ...(scheme === undefined ? {} : { returnScheme: scheme }),
      openExternal: (url: string) => cap.open(url),
    };
  }, [cap]);
}

/** Only http(s) addresses are opened or navigated to (never `javascript:` and the like). */
export function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === "https:" || p === "http:";
  } catch {
    return false;
  }
}

/** A site path (one leading `/`, same origin), as the kernel's `isSafeReturnPath` reads it. */
const isSitePath = (p: string): boolean => safeReturnTo(p) === p;

/** Where the handoff page may send the browser: an http(s) address or a site path, nothing else. */
export const isHandoffLocation = (u: string): boolean => isHttpUrl(u) || isSitePath(u);

/**
 * Redeems a handoff ticket in this signed-in browser (`POST /api/v1/auth/handoffs/redeem`, session
 * and CSRF header): the kernel starts the ticket's flow here and answers where to go next.
 */
export const redeemHandoff = (ticket: string) =>
  apiFetch<{ location: string }>("/api/v1/auth/handoffs/redeem", {
    method: "POST",
    body: JSON.stringify({ ticket }),
  });

/** The result a handoff flow's callback appended to the done page's address. */
export type HandoffResult = { kind: "ok" } | { kind: "error"; code: string };

/** What the done page (`/handoff/done`) was given: what was authorized, where to return, how. */
export type HandoffDone = (
  | { kind: "connector"; orgId: string; connectorId: string }
  | { kind: "identity-link"; plugin: string }
) & {
  /** The site path the shell started from; absent when missing or not a safe site path. */
  returnTo?: string;
  /** The scheme the shell named (still to be checked against the platform's `appSchemes`). */
  scheme?: string;
  result: HandoffResult;
};

/**
 * Reads the done page's query (the kernel's `handoffDonePath` plus the callback's result): a
 * connector's `connected` / `oauth_error` through {@link parseConnectResult} (neither reads as an
 * unknown error), a link's `error` through {@link parseLinkError} (absent = linked). Null when the
 * query names no known kind or misses its ids.
 */
export function parseHandoffDone(search: string): HandoffDone | null {
  const q = new URLSearchParams(search);
  const one = (k: string) => {
    const v = q.get(k);
    return v === null || v === "" ? undefined : v;
  };
  const rawReturn = one("returnTo");
  const scheme = one("scheme");
  const common = {
    ...(rawReturn !== undefined && isSitePath(rawReturn) ? { returnTo: rawReturn } : {}),
    ...(scheme === undefined ? {} : { scheme }),
  };
  const kind = one("kind");
  if (kind === "connector") {
    const orgId = one("org");
    const connectorId = one("connector");
    if (orgId === undefined || connectorId === undefined) return null;
    const r = parseConnectResult(search).result;
    const result: HandoffResult =
      r === null
        ? { kind: "error", code: "unknown" }
        : r.kind === "connected"
          ? { kind: "ok" }
          : { kind: "error", code: r.code };
    return { kind, orgId, connectorId, ...common, result };
  }
  if (kind === "identity-link") {
    const plugin = one("plugin");
    if (plugin === undefined) return null;
    const code = parseLinkError(one("error"));
    const result: HandoffResult = code === null ? { kind: "ok" } : { kind: "error", code };
    return { kind, plugin, ...common, result };
  }
  return null;
}

/**
 * The result parameters the app's page reads, as the normal (non-handoff) return would carry
 * them: `connected=<id>` / `oauth_error=<code>` for a connector, `error=<code>` for a failed link.
 */
export function handoffResultParams(done: HandoffDone): URLSearchParams {
  const p = new URLSearchParams();
  if (done.kind === "connector") {
    if (done.result.kind === "ok") p.set("connected", done.connectorId);
    else p.set("oauth_error", done.result.code);
  } else if (done.result.kind === "error") {
    p.set("error", done.result.code);
  }
  return p;
}

/**
 * The link back into the native app: `<scheme>://open?url=<origin + returnTo + result params>`,
 * only for a scheme the platform lists (`appSchemes`, derived from `auth.appRedirectUris`), so a
 * crafted done address cannot point it anywhere else. Null otherwise.
 */
export function appDeepLink(
  scheme: string | undefined,
  appSchemes: readonly string[],
  origin: string,
  returnTo: string,
  resultParams: URLSearchParams,
): string | null {
  if (scheme === undefined || !appSchemes.includes(scheme)) return null;
  const params = resultParams.toString();
  const sep = params === "" ? "" : returnTo.includes("?") ? "&" : "?";
  return `${scheme}://open?url=${encodeURIComponent(`${origin}${returnTo}${sep}${params}`)}`;
}
