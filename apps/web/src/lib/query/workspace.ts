"use client";

import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useRouter } from "../../i18n/navigation";
import { setupReady } from "../agents";
import { myRole, roleAtLeast } from "../members";
import type { Workspace } from "../server/session";
import type { Me } from "../session";
import { isSignedOut } from "../signed-out";
import { meQuery, readinessQuery } from "./shell";

/**
 * A view's workspace gate, decided from the cache (web query cache spec §3.2): pages run no gate of
 * their own on the server (only the `(app)` layout sends a document request home while the org is
 * not ready), and client navigations don't re-render the layout. `/me` and the org's readiness are
 * read through the cache (prefetched by the layout, and `mine` never goes stale), so on a
 * navigation inside the app it answers on the first render. No current org is
 * `noOrg`; while the org is not ready, a page that is no setup route (no `setup`) goes to `/`
 * (`pending` until then); below `min` (default `guest`) it is `noAccess`. `pending` while `/me` or
 * readiness has no answer yet. A readiness failure other than a signed-out session throws, to the
 * route's error boundary.
 */
export function useWorkspace(
  opts: { min?: "guest" | "member" | "admin"; setup?: "home" | "step" } = {},
): Workspace | { kind: "pending" } {
  const router = useRouter();
  const me = useQuery(meQuery()).data;
  const orgId = me?.memberships.find((m) => m.orgId === me.currentOrgId)?.orgId ?? null;
  // A query of no org is disabled; the key's org id is then never read.
  const readiness = useQuery({ ...readinessQuery(orgId ?? ""), enabled: orgId !== null });
  const notReady = readiness.data !== undefined && !setupReady(readiness.data);
  const goHome = notReady && opts.setup === undefined;
  useEffect(() => {
    if (goHome) router.replace("/");
  }, [goHome, router]);
  if (me === undefined) return { kind: "pending" };
  if (orgId === null) return { kind: "noOrg" };
  if (readiness.data === undefined) {
    if (readiness.error && !isSignedOut(readiness.error)) throw readiness.error;
    return { kind: "pending" };
  }
  if (goHome) return { kind: "pending" };
  const role = myRole(me);
  const min = opts.min ?? "guest";
  if (role === undefined || !roleAtLeast(role, min)) {
    return { kind: "noAccess", need: min === "admin" ? "admin" : "member" };
  }
  return { kind: "ok", me, orgId, role };
}

/**
 * The admin console's gate from the cache: enterprise admins only (the server's `admin()`).
 * `pending` while `/me` has no answer.
 */
export function useAdmin():
  | { kind: "ok"; me: Me }
  | { kind: "noAccess"; need: "enterprise" }
  | { kind: "pending" } {
  const me = useQuery(meQuery()).data;
  if (me === undefined) return { kind: "pending" };
  return me.account.isEnterpriseAdmin
    ? { kind: "ok", me }
    : { kind: "noAccess", need: "enterprise" };
}

/**
 * Ends the cache's session (an org switch or a sign-out): cancels every read in flight, then drops
 * the whole cache, so a read of the old org or account that answers late can neither land in the
 * cache nor paint (web query cache spec §6). `then` (the navigation) runs in the same task as the
 * clear, with nothing awaited between them, so no render can show the empty cache under the old
 * page.
 */
export async function resetSession(qc: QueryClient, then: () => void): Promise<void> {
  await qc.cancelQueries();
  qc.clear();
  then();
}

/** Set (in the browser) once a sign-out started; the page then navigates away for good. */
let signingOut = false;

/**
 * Marks a sign-out in progress: until the navigation to sign-in, a read answering 401 `auth.*` is
 * expected, and the session guard leaves it to the sign-out instead of sending the page to sign-in
 * with a return path.
 */
export function markSigningOut(): void {
  if (typeof window !== "undefined") signingOut = true;
}

/** Whether a sign-out is in progress ({@link markSigningOut}). */
export const isSigningOut = (): boolean => signingOut;
