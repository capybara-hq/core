"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "../../i18n/navigation";
import { replaceBrowser } from "../../lib/browser";
import { useAppMutation } from "../../lib/query/mutation";
import { resetSession } from "../../lib/query/workspace";
import { type Me, setCurrentOrg } from "../../lib/session";
import { broadcastSession } from "../../lib/session-sync";

/**
 * `?org=<orgId>` on any app route (push plan decision 8: a push's `path` carries the org it is
 * about). At the first render of the frame the parameter is read once and dropped from the URL:
 * for an org the person belongs to (and is not already in) the current org is switched
 * (`PUT /api/v1/me/current-org`) and the document is replaced by the same path without the
 * parameter, loaded in the new org; for any other value (not a member, the current org already)
 * only the parameter is dropped, so a stale or foreign link never switches anything.
 */
export function useOrgParam(me: Me): void {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const { mutateAsync: putCurrentOrg } = useAppMutation({
    fn: setCurrentOrg,
    invalidates: () => [],
  });
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const params = new URLSearchParams(window.location.search);
    const org = params.get("org");
    if (org === null) return;
    handled.current = true;
    params.delete("org");
    const rest = params.toString();
    // leading slashes collapse to one: `//host` would be a protocol-relative redirect
    const path = `/${pathname.replace(/^\/+/, "")}`;
    const clean = `${path}${rest === "" ? "" : `?${rest}`}${window.location.hash}`;
    if (org === me.currentOrgId || !me.memberships.some((m) => m.orgId === org)) {
      router.replace(clean);
      return;
    }
    void (async () => {
      try {
        await putCurrentOrg(org);
      } catch {
        // the switch failed (a signed-out session is the session guard's to handle): stay here
        router.replace(clean);
        return;
      }
      broadcastSession("org-switched");
      await resetSession(qc, () => replaceBrowser(clean));
    })();
  }, [me, pathname, putCurrentOrg, qc, router]);
}
