import { getReadiness } from "../agents";
import { ApiClientError } from "../api";
import { listConversationGroups } from "../conversations";
import { listInbox } from "../inbox";
import { getMe, type Me } from "../session";
import { listUiContributions } from "../ui";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The pending count the sidebar's inbox entry shows. */
export interface PendingCount {
  count: number;
  more: boolean;
}

/** The signed-in account, its memberships and its current org. */
export const meQuery = () =>
  defineQuery({ key: keys.account("self").me(), fn: getMe, freshness: "mine" });

/**
 * `/me` on a public page (sign-in, invitation): `null` for a visitor without a valid session (a
 * 401 `auth.*`); any other failure throws.
 */
export const maybeMeQuery = () =>
  defineQuery<Me | null>({
    key: keys.account("self").maybeMe(),
    fn: () =>
      getMe().catch((e: unknown) => {
        if (e instanceof ApiClientError && e.status === 401 && e.code.startsWith("auth.")) {
          return null;
        }
        throw e;
      }),
    freshness: "mine",
  });

/** Whether the org has a model and an agent (the setup frame). */
export const readinessQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).readiness(),
    fn: () => getReadiness(orgId),
    freshness: "orgConfig",
  });

/** The sidebar's conversation groups; `"default"` is the unfiltered live list the layout reads. */
export const conversationGroupsQuery = (orgId: string, view = "default") =>
  defineQuery({
    key: keys.org(orgId).conversationGroups(view),
    fn: () => listConversationGroups(orgId),
    freshness: "live",
  });

/** The inbox entry's count. */
export const inboxCountQuery = (orgId: string) =>
  defineQuery<PendingCount>({
    key: keys.org(orgId).inboxCount(),
    fn: () => listInbox(orgId).then((r) => ({ count: r.items.length, more: r.truncated === true })),
    freshness: "live",
  });

/** The extension pages (`place: "page"`) of the sidebar's More menu. */
export const extensionPagesQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).extensionPages(),
    fn: () =>
      listUiContributions(orgId).then(({ items }) => items.filter((c) => c.place === "page")),
    freshness: "orgConfig",
  });
