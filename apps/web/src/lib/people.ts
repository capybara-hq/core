"use client";

import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext } from "react";
import { useSession } from "../components/shell/session";

/**
 * A person as the web draws one: the id (to tell the viewer), the name and the avatar route.
 * `initialFrom`: the person's own name when `name` is a replacement word (the viewer as "You").
 */
export type PersonRef = {
  id: string;
  name: string;
  avatarUrl: string | null;
  initialFrom?: string;
};

/** Accounts by id, as a response's `people` sidecar names them; an absent id has left. */
export type PeopleMap = Readonly<Record<string, PersonRef>>;

/**
 * The people of the conversation being drawn (its events response's `people`), provided by the
 * thread so the cards inside it name who decided, answered or waits without a read of their own.
 */
export const PeopleContext = createContext<PeopleMap>({});

/**
 * Looks an account id up in `people` (the thread's, by default): the person, or `null` for one who
 * left. The viewer comes from the session first, so a profile save shows at once (the log's
 * `people` keep what the read saw).
 */
export function usePersonLookup(people?: PeopleMap): (id: string) => PersonRef | null {
  const fromThread = useContext(PeopleContext);
  const { me } = useSession();
  const map = people ?? fromThread;
  return useCallback(
    (id) =>
      id === me.account.id
        ? { id, name: me.account.displayName, avatarUrl: me.account.avatarUrl }
        : (map[id] ?? null),
    [map, me.account.id, me.account.displayName, me.account.avatarUrl],
  );
}

/**
 * The viewer as every person surface draws them (one rule): the label `label` (default "You" /
 * 你) beside their own avatar from the session, the initial from their real display name.
 */
export function useViewerPerson(label?: string): PersonRef {
  const { me } = useSession();
  const t = useTranslations("people");
  return {
    id: me.account.id,
    name: label ?? t("you"),
    avatarUrl: me.account.avatarUrl,
    initialFrom: me.account.displayName,
  };
}
