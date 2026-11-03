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
