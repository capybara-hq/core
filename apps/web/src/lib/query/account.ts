import { listToolGrants } from "../approvals";
import { listIdentities } from "../identities";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** My standing tool grants in the org (`{ grants }`, as the kernel answers). */
export const toolGrantsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).toolGrants(),
    fn: () => listToolGrants(orgId),
    freshness: "mine",
  });

/** The account's linked external identities (`{ identities }`, as the kernel answers). */
export const identitiesQuery = (accountId: string) =>
  defineQuery({
    key: keys.account(accountId).identities(),
    fn: () => listIdentities(),
    freshness: "mine",
  });
