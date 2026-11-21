"use client";

import { ConversationList, ListPage, useToast } from "@capybara-hq/design";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  conversationRow,
  useConversationAgents,
  useConversationRowActions,
} from "../../../components/conversation-rows";
import { useCursorPages } from "../../../components/cursor-pages";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { usePathname } from "../../../i18n/navigation";
import type { Conversation } from "../../../lib/conversations";
import { retryOnMountOf } from "../../../lib/query/client";
import { type ConversationListSearch, conversationListQuery } from "../../../lib/query/shell";
import { useWorkspace } from "../../../lib/query/workspace";
import { HOME_PATH } from "../../../lib/routes";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

/** Typing in the search asks the kernel once the input settles. */
const QUERY_SETTLE_MS = 200;
/** The chip of every agent. */
const ALL = "all";

/**
 * `/conversations` (全部会话, maintainer decision 2026-11-22): my conversations by time, newest
 * first, sectioned 今天 / 昨天 / 本周 / 更早 (design spec §6.60), with a title search and a chip per
 * agent (the agents of the sidebar's groups). The first page comes from the query cache (the
 * drawer reads the same one); the next is read as the list's end comes near (no Load more row).
 * The primary starts a new conversation (the floating action button below 600); a row's long
 * press, right click or ⋯ offers rename, archive and delete.
 */
export default function ConversationsView() {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Conversations orgId={ws.orgId} />;
}

function Conversations({ orgId }: { orgId: string }) {
  const t = useTranslations("conversations");
  const scope = usePagePath("org");
  const pathname = usePathname();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [q, setQ] = useState("");
  const [settledQ, setSettledQ] = useState("");
  const [agent, setAgent] = useState(ALL);
  useEffect(() => {
    if (q === settledQ) return;
    const timer = setTimeout(() => setSettledQ(q), QUERY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [q, settledQ]);
  const search: ConversationListSearch = {
    ...(settledQ.trim() !== "" ? { q: settledQ } : {}),
    ...(agent !== ALL ? { agentId: agent } : {}),
  };
  const query = conversationListQuery(orgId, search);
  // A new search keeps the previous rows until its answer arrives (no skeleton flash).
  const read = useQuery({
    ...query,
    retryOnMount: retryOnMountOf(query.queryKey),
    placeholderData: keepPreviousData,
  });
  const pages = useCursorPages(
    read.data,
    (after) => conversationListQuery(orgId, search, after),
    (page) => ({ rows: page.conversations, next: page.next }),
  );
  const rows = dedupe(pages.rows);
  const { byId, agents } = useConversationAgents(
    orgId,
    rows.map((c) => c.agentId),
  );
  const actions = useConversationRowActions(orgId, pathname, (e) => toast.error(errorMessage(e)));
  if (read.error?.status === 404) return <NotFound />;
  const loading = read.data === undefined && read.error === null;
  if (read.data === undefined && read.error !== null) {
    return <ErrorFrame reset={() => void read.refetch()} />;
  }
  // The total is known once the last page is in; before that the loaded rows and a "+".
  const count = loading ? undefined : pages.next === null ? rows.length : `${rows.length}+`;
  const header = {
    path: [...scope, { label: "conversations" }],
    title: t("title"),
    ...(count !== undefined ? { count } : {}),
    actions: [
      { label: t("new"), variant: "primary" as const, icon: "plus" as const, href: HOME_PATH },
    ],
    search: { label: t("search"), value: q, onChange: setQ },
  };
  const chips =
    agents.length > 1 || agent !== ALL
      ? {
          label: t("byAgent"),
          value: agent,
          options: [
            { value: ALL, label: t("all") },
            ...agents.map((a) => ({ value: a.id, label: a.name, avatar: a.avatar })),
          ],
          onChange: setAgent,
        }
      : undefined;
  const filtered = settledQ.trim() !== "" || agent !== ALL;
  const empty = !loading && rows.length === 0;
  return (
    <ListPage
      header={header}
      listLabel={t("list")}
      loading={loading ? { keep: true } : false}
      {...(chips ? { scope: chips } : {})}
      {...(empty && {
        empty: filtered
          ? { text: t("noMatch") }
          : {
              text: t("empty"),
              action: { label: t("new"), variant: "primary" as const, href: HOME_PATH },
            },
      })}
    >
      <ConversationList
        label={t("list")}
        items={rows.map((c) => conversationRow(c, byId))}
        sections
        state={loading ? "loading" : "ready"}
        actions={actions}
        end={{
          // the previous search's rows stand in while a new one loads: no page past them
          more: pages.next !== null && !read.isPlaceholderData,
          loading: pages.loadingMore,
          error: pages.error,
          onMore: pages.loadMore,
        }}
      />
    </ListPage>
  );
}

/** Pages read by cursor can repeat a row that moved between two reads: the first one stays. */
function dedupe(rows: Conversation[]): Conversation[] {
  const seen = new Set<string>();
  return rows.filter((c) => !seen.has(c.id) && seen.add(c.id));
}
