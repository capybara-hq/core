"use client";

import { useTranslations } from "next-intl";
import { useCallback, useContext } from "react";
import { useSession } from "../../components/shell/session";
import { PeopleContext, type PeopleMap } from "../people";
import type { Waiter } from "../timeline";

/**
 * Words who a wait is for (`SubagentLive.whoWaits`, the approval card): undefined for the viewer
 * (the viewer's own wait reads "waiting for you"), a person's display name from the log's `people` (the events response names every
 * account, so a guest sees names too), a role ("admin") for an approval escalated by role, or
 * "another member" for an account that has left.
 */
export function useWhoWaits(people: PeopleMap): (w: Waiter) => string | undefined {
  const t = useTranslations("chat.waitingFor");
  const me = useSession().me.account.id;
  return useCallback(
    (w: Waiter) =>
      w.kind === "role"
        ? t(`role.${w.role}`)
        : w.accountId === me
          ? undefined
          : (people[w.accountId]?.name ?? t("someone")),
    [t, me, people],
  );
}

/** {@link useWhoWaits} for a component inside a thread: the people come from its context. */
export function useThreadWaiterWords(): (w: Waiter) => string | undefined {
  return useWhoWaits(useContext(PeopleContext));
}
