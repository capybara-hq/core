import { getReadiness } from "../agents";
import { ApiClientError } from "../api";
import {
  type ConversationSearch,
  listConversationGroups,
  listConversations,
} from "../conversations";
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

/**
 * The key of a sidebar view: `"default"` for the unfiltered live list (what the layout reads), else
 * the archived flag, the trimmed query and the state.
 */
export function groupsViewKey(s: ConversationSearch = {}): string {
  const archived = s.archived === true;
  const q = (s.q ?? "").trim();
  const state = s.state ?? "all";
  return !archived && q === "" && state === "all"
    ? "default"
    : JSON.stringify([archived, q, state]);
}

/** The sidebar's conversation groups (first page) of one view, `search` as the kernel takes it. */
export const conversationGroupsQuery = (orgId: string, search: ConversationSearch = {}) =>
  defineQuery({
    key: keys.org(orgId).conversationGroups(groupsViewKey(search)),
    fn: () => listConversationGroups(orgId, search),
    freshness: "live",
  });

/** A group's next rows (the sidebar's More), after its last shown row. */
export const moreConversationsQuery = (
  orgId: string,
  opts: { agentId: string; after?: string } & ConversationSearch,
) =>
  defineQuery({
    key: keys.org(orgId).conversationGroupsMore("rows", JSON.stringify(opts)),
    fn: () => listConversations(orgId, opts),
    freshness: "live",
  });

/** The groups past the shown ones (the sidebar's More groups). */
export const moreGroupsQuery = (orgId: string, opts: { after: string } & ConversationSearch) =>
  defineQuery({
    key: keys.org(orgId).conversationGroupsMore("groups", JSON.stringify(opts)),
    fn: () => listConversationGroups(orgId, opts),
    freshness: "live",
  });

/** The inbox entry's count. */
export const inboxCountQuery = (orgId: string) =>
  defineQuery<PendingCount>({
    key: keys.org(orgId).inboxCount(),
    fn: () => listInbox(orgId).then((r) => ({ count: r.items.length, more: r.truncated === true })),
    freshness: "live",
  });

/** The extension pages (slot `org.page`) of the sidebar's More menu. */
export const extensionPagesQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).extensionPages(),
    fn: () =>
      listUiContributions(orgId).then(({ items }) => items.filter((c) => c.slot === "org.page")),
    freshness: "orgConfig",
  });
