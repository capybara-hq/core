import { createHash } from "node:crypto";

/**
 * The first workspace document of a sign-in (client extensions spec §7.3, `sign-in=new`): the
 * proxy (`src/proxy.ts`) compares the session of the request with the one the browser last
 * rendered a workspace document for, kept in {@link SIGN_IN_SEEN_COOKIE}. A UI hint only (a plugin
 * may play a greeting once per sign-in without a flash of the page first), never an access check.
 * Pure of Next, so it is tested without a server.
 */

/** The cookie holding {@link signInMarker} of the session a workspace document last rendered for. */
export const SIGN_IN_SEEN_COOKIE = "cap_seen";

/** How long the browser keeps the marker: the refresh token's own lifetime (30 days). */
const SEEN_MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * The marker of the session an access token (a JWT the kernel signs) belongs to: the sha256 of
 * its `sid` claim, read without verifying (the kernel verifies the token itself), so the cookie
 * never holds the session id. `null` for a token that does not decode or carries no `sid`.
 */
export function signInMarker(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      sid?: unknown;
    };
    if (typeof payload.sid !== "string" || payload.sid === "") return null;
    return createHash("sha256").update(payload.sid).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

/**
 * Whether a request loads a document (a navigation or a reload), not one of Next's RSC fetches or
 * prefetches, which a client navigation makes without rendering the layouts again.
 */
export function isDocumentRequest(headers: Headers): boolean {
  if (headers.get("rsc") !== null || headers.get("next-router-prefetch") !== null) return false;
  const dest = headers.get("sec-fetch-dest");
  return dest === null || dest === "document";
}

/** The `Set-Cookie` recording that a workspace document rendered for the session `marker`. */
export function signInSeenCookie(marker: string, https: boolean): string {
  const secure = https ? "; Secure" : "";
  return `${SIGN_IN_SEEN_COOKIE}=${marker}; Path=/; Max-Age=${SEEN_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`;
}
