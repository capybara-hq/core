"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { usePathname, useRouter } from "../i18n/navigation";
import { loginPathFor } from "../lib/auth-sources";
import { resetSession } from "../lib/query/workspace";
import { isSignedOut } from "../lib/signed-out";

/**
 * The client's answer to an expired session (web query cache spec §3.2): client navigations don't
 * run the server's gates, so a read that finds the session gone (a 401 `auth.*`, after `apiFetch`'s
 * refresh retry) clears the cache and signs in again, back to the current page. The page below is
 * not drawn from that error on until the path changes, so no error state flashes first.
 */
export function SessionGuard({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  // The path whose session ended; the children stay hidden while the document is still there.
  const [endedAt, setEndedAt] = useState<string | null>(null);
  if (endedAt !== null && endedAt !== pathname) setEndedAt(null);
  useEffect(() => {
    let ended = false;
    return qc.getQueryCache().subscribe((event) => {
      if (ended || event.type !== "updated" || event.action.type !== "error") return;
      if (!isSignedOut(event.action.error)) return;
      ended = true;
      setEndedAt(pathname);
      const back = `${pathname}${window.location.search}`;
      void resetSession(qc, () => router.replace(loginPathFor(back)));
    });
  }, [qc, router, pathname]);
  return endedAt === pathname ? null : children;
}
