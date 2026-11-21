"use client";

import { useTranslations } from "next-intl";
import { useCallback, useContext } from "react";
import { useSession } from "../../components/shell/session";
import { PeopleContext, type PeopleMap, type PersonRef } from "../people";
import type { Waiter } from "../timeline";

/**
 * Who a wait is for, when it is not the viewer: a role ("admin", worded) for an approval escalated
 * by role, or a person from the log's `people` (the events response names every account, so a
 * guest sees them too); `person: null` is an account that has left (drawn as "Former member").
 */
export type WaitTarget =
  | { kind: "role"; words: string }
  | { kind: "person"; person: PersonRef | null };

/**
 * Who a wait is for (`SubagentLive.whoWaits`, the approval card): undefined for the viewer (the
 * viewer's own wait reads "waiting for you"), else a {@link WaitTarget}.
 */
export function useWaitTarget(people: PeopleMap): (w: Waiter) => WaitTarget | undefined {
  const t = useTranslations("chat.waitingFor");
  const me = useSession().me.account.id;
  return useCallback(
    (w: Waiter): WaitTarget | undefined =>
      w.kind === "role"
        ? { kind: "role", words: t(`role.${w.role}`) }
        : w.accountId === me
          ? undefined
          : { kind: "person", person: people[w.accountId] ?? null },
    [t, me, people],
  );
}

/**
 * {@link useWaitTarget} as words, for the text-only waiting word of a tool row and the group
 * header: the role, the person's name, or "Former member" for one who left.
 */
export function useWhoWaits(people: PeopleMap): (w: Waiter) => string | undefined {
  const target = useWaitTarget(people);
  const tp = useTranslations("people");
  return useCallback(
    (w: Waiter) => {
      const to = target(w);
      if (to === undefined) return undefined;
      if (to.kind === "role") return to.words;
      return to.person?.name ?? tp("departed");
    },
    [target, tp],
  );
}

/** {@link useWaitTarget} for a component inside a thread: the people come from its context. */
export function useThreadWaitTarget(): (w: Waiter) => WaitTarget | undefined {
  return useWaitTarget(useContext(PeopleContext));
}
