"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import { useSession } from "../../components/shell/session";
import type { ConversationEvent } from "../conversations";
import type { Waiter } from "../timeline";
import { retryOnMountOf } from "./client";
import { membersQuery } from "./members";

/** Accounts other than the viewer that the log says have to act on a wait. */
function othersIn(events: readonly ConversationEvent[], me: string): boolean {
  for (const e of events) {
    if (e.type === "run_started" && e.payload.triggerAccountId !== undefined) {
      if (e.payload.triggerAccountId !== me) return true;
    } else if (e.type === "approval_requested" || e.type === "subagent_waiting") {
      const id = e.payload.requestedFor;
      if (id !== undefined && id !== null && id !== me) return true;
    }
  }
  return false;
}

/**
 * Words who a wait is for (`SubagentLive.whoWaits`, the approval card): undefined for the viewer
 * ("等待你批准"), a member's display name, a role ("管理员") for an approval escalated by role, or
 * "其他成员" when the name cannot be read (a guest cannot list members). The member list is read
 * only when the log names someone other than the viewer, so a person's own conversation reads
 * nothing more.
 */
export function useWhoWaits(
  orgId: string,
  events: readonly ConversationEvent[],
): (w: Waiter) => string | undefined {
  const me = useSession().me.account.id;
  const needed = useMemo(() => othersIn(events, me), [events, me]);
  return useWaiterWords(orgId, needed);
}

/** {@link useWhoWaits} for a caller that knows itself whether someone else is named (`needed`). */
export function useWaiterWords(orgId: string, needed: boolean): (w: Waiter) => string | undefined {
  const t = useTranslations("chat.waitingFor");
  const me = useSession().me.account.id;
  const q = membersQuery(orgId);
  const { data } = useQuery({ ...q, enabled: needed, retryOnMount: retryOnMountOf(q.queryKey) });
  const names = useMemo(
    () => new Map((data?.members ?? []).map((m) => [m.account.id, m.account.displayName])),
    [data],
  );
  return useCallback(
    (w: Waiter) =>
      w.kind === "role"
        ? t(`role.${w.role}`)
        : w.accountId === me
          ? undefined
          : (names.get(w.accountId) ?? t("someone")),
    [t, me, names],
  );
}
