import { listInbox } from "../inbox";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** My inbox (`{ items, truncated }`, as the kernel answers): what waits on me. */
export const inboxQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).inbox(),
    fn: () => listInbox(orgId),
    freshness: "live",
  });
