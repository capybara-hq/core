import { listToolGrants } from "../approvals";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** My standing tool grants in the org (`{ grants }`, as the kernel answers). */
export const toolGrantsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).toolGrants(),
    fn: () => listToolGrants(orgId),
    freshness: "mine",
  });

