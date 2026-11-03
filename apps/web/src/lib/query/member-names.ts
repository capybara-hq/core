"use client";

import { useQuery } from "@tanstack/react-query";
import { retryOnMountOf } from "./client";
import { membersQuery } from "./members";

/** The members' display names by account id, as a page that shows who started a run reads them. */
export type MemberNames =
  | { kind: "ready"; people: Record<string, string> }
  | { kind: "loading" }
  | { kind: "error"; retry(): void };

/**
 * The org's member names (account id → display name). Names are cosmetic: when the kernel refuses
 * the list (403 / 404) the ids show (`ready` with no names); any other failure is `error` (the
 * page's error state, with a retry). A failure the layout already read is not read again on mount.
 */
export function useMemberNames(orgId: string): MemberNames {
  const q = membersQuery(orgId);
  const members = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  if (members.data !== undefined) {
    return {
      kind: "ready",
      people: Object.fromEntries(
        members.data.members.map((m) => [m.account.id, m.account.displayName]),
      ),
    };
  }
  const refused = members.error?.status === 403 || members.error?.status === 404;
  if (refused) return { kind: "ready", people: {} };
  if (members.error) return { kind: "error", retry: () => void members.refetch() };
  return { kind: "loading" };
}
