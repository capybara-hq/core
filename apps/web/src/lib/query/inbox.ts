import { listInbox } from "../inbox";
import { getSkillChange } from "../skills";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** My inbox (`{ items, truncated }`, as the kernel answers): what waits on me. */
export const inboxQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).inbox(),
    fn: () => listInbox(orgId),
    freshness: "live",
  });

/** One skill change's detail: its files and the skill's current version (the diff's two sides). */
export const skillChangeQuery = (orgId: string, changeId: string) =>
  defineQuery({
    key: keys.org(orgId).skillChange(changeId),
    fn: () => getSkillChange(orgId, changeId).then((r) => r.skillChange),
    freshness: "live",
  });

/** What deciding an inbox item changes: the inbox and the sidebar's count of it. */
export const inboxChangeKeys = (orgId: string): (readonly unknown[])[] => [
  keys.org(orgId).inbox(),
  keys.org(orgId).inboxCount(),
];
