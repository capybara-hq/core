"use client";

import { createContext, useCallback, useContext } from "react";
import { useSession } from "../components/shell/session";

/** A person as the web draws one: the id (to tell the viewer), the name and the avatar route. */
export type PersonRef = { id: string; name: string; avatarUrl: string | null };

/** Accounts by id, as a response's `people` sidecar names them; an absent id has left. */
export type PeopleMap = Readonly<Record<string, PersonRef>>;

/**
 * The people of the conversation being drawn (its events response's `people`), provided by the
 * thread so the cards inside it name who decided, answered or waits without a read of their own.
 */
export const PeopleContext = createContext<PeopleMap>({});

/**
 * Looks an account id up in `people` (the thread's, by default): the person, or `null` for one who
 * left. The viewer is always known, from the session.
 */
export function usePersonLookup(people?: PeopleMap): (id: string) => PersonRef | null {
  const fromThread = useContext(PeopleContext);
  const { me } = useSession();
  const map = people ?? fromThread;
  return useCallback(
    (id) =>
      map[id] ??
      (id === me.account.id
        ? { id, name: me.account.displayName, avatarUrl: me.account.avatarUrl }
        : null),
    [map, me.account.id, me.account.displayName, me.account.avatarUrl],
  );
}
