import type { QueryClient } from "@tanstack/react-query";
import { listMembers } from "../members";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org's members. */
export const membersQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).members(),
    fn: () => listMembers(orgId),
    freshness: "orgConfig",
  });

/**
 * The members read of every org in the cache. A person's name and avatar show in every org they
 * belong to, so a profile save refreshes each cached org's list, not only the current one's.
 */
export function cachedMembersKeys(qc: QueryClient): (readonly unknown[])[] {
  return qc
    .getQueryCache()
    .findAll({ predicate: ({ queryKey }) => isMembersKey(queryKey) })
    .map((q) => q.queryKey);
}

/** Whether a key is `keys.org(<its org id>).members()`, compared by the builder's own key. */
function isMembersKey(key: readonly unknown[]): boolean {
  const orgId = key[1];
  if (typeof orgId !== "string") return false;
  const members = keys.org(orgId).members();
  return members.length === key.length && members.every((part, i) => key[i] === part);
}
