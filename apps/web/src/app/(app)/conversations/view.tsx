"use client";

import {
  formatDateTime,
  ListPage,
  ObjectRow,
  type PageHeaderProps,
  untitledLabel,
  useDesignLocale,
  useTimeZone,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useCursorPages } from "../../../components/cursor-pages";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { avatarValue } from "../../../lib/agents";
import type {
  Conversation,
  ConversationGroup,
  ConversationGroupsPage,
} from "../../../lib/conversations";
import { usePageQuery } from "../../../lib/query/page-query";
import {
  conversationGroupsQuery,
  moreConversationsQuery,
  moreGroupsQuery,
} from "../../../lib/query/shell";
import { useWorkspace } from "../../../lib/query/workspace";
import { HOME_PATH } from "../../../lib/routes";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

/**
 * `/conversations`: my conversations grouped by agent (ListPage `objects`, the compact class's Conversations
 * tab). The first page of the groups comes from the query cache (the layout prefetched it on a
 * first load, and the sidebar reads the same query); later groups are read through the cache by
 * cursor (Load more) and a group's older rows by its own More row. The primary action starts a new
 * conversation.
 */
export default function ConversationsView() {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Conversations orgId={ws.orgId} />;
}

/** The rows a group's More row read past its first rows, and where it stands. */
type Extra = { rows: Conversation[]; done: boolean; loading: boolean };

function Conversations({ orgId }: { orgId: string }) {
  const t = useTranslations("conversations");
  const scope = usePagePath("org");
  const read = usePageQuery(conversationGroupsQuery(orgId));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  const header = {
    path: [...scope, { label: "conversations" }],
    title: t("title"),
    description: t("description"),
    actions: [
      { label: t("new"), variant: "primary" as const, icon: "plus" as const, href: HOME_PATH },
    ],
  };
  if (read.kind === "loading") {
    return <ListPage header={header} variant="objects" listLabel={t("list")} loading />;
  }
  return <Groups orgId={orgId} first={read.data} header={header} />;
}

function Groups({
  orgId,
  first,
  header,
}: {
  orgId: string;
  first: ConversationGroupsPage;
  header: PageHeaderProps;
}) {
  const t = useTranslations("conversations");
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const locale = useDesignLocale();
  const timeZone = useTimeZone();
  const pages = useCursorPages(
    first,
    (after) => moreGroupsQuery(orgId, { after }),
    (page) => ({ rows: page.groups, next: page.next }),
  );
  // Groups merged by agent id: the cursor can bring one back (the sidebar's rule).
  const seen = new Set<string>();
  const groups = pages.rows.filter((g) => !seen.has(g.agent.id) && seen.add(g.agent.id));
  const [extra, setExtra] = useState<Record<string, Extra>>({});
  // a failed "more" read is shown on that group's row only (keyed by agent id)
  const [moreError, setMoreError] = useState<Record<string, string>>({});
  const loadRows = async (g: ConversationGroup, rows: Conversation[]) => {
    const key = g.agent.id;
    const last = rows.at(-1);
    setExtra((e) => ({ ...e, [key]: { rows: e[key]?.rows ?? [], done: false, loading: true } }));
    try {
      const page = await qc.fetchQuery(
        moreConversationsQuery(orgId, { agentId: key, ...(last ? { after: last.id } : {}) }),
      );
      setMoreError(({ [key]: _, ...rest }) => rest);
      setExtra((e) => ({
        ...e,
        [key]: {
          rows: [...(e[key]?.rows ?? []), ...page.conversations],
          done: page.next === null,
          loading: false,
        },
      }));
    } catch (e) {
      setMoreError((m) => ({ ...m, [key]: errorMessage(e) }));
      setExtra((x) => ({ ...x, [key]: { rows: x[key]?.rows ?? [], done: false, loading: false } }));
    }
  };
  const empty = groups.length === 0;
  return (
    <ListPage
      header={header}
      variant="objects"
      listLabel={t("list")}
      {...(empty && {
        empty: {
          text: t("empty"),
          action: { label: t("new"), variant: "primary" as const, href: HOME_PATH },
        },
      })}
    >
      {groups.flatMap((g) => {
        const more = extra[g.agent.id];
        const rows = [...g.conversations, ...(more?.rows ?? [])];
        const avatar = g.agent.profile ? avatarValue(g.agent, orgId) : null;
        const items = rows.map((c) => (
          <ObjectRow
            key={c.id}
            mark={{ avatar, text: g.agent.name }}
            name={c.title ?? untitledLabel(new Date(c.createdAt), locale, timeZone)}
            href={`/chat/${encodeURIComponent(c.id)}`}
            meta={g.agent.name}
            trailing={formatDateTime(c.updatedAt, "compact", timeZone)}
            {...(c.activity === "running"
              ? { state: { label: t("running"), tone: "ok" as const } }
              : c.activity === "waiting"
                ? { state: { label: t("waiting"), tone: "warn" as const } }
                : {})}
          />
        ));
        return g.more && more?.done !== true
          ? [
              ...items,
              <ObjectRow
                key={`${g.agent.id}-more`}
                mark={{ icon: "more-horizontal" }}
                name={t("moreOf", { agent: g.agent.name })}
                action={{
                  label: t("loadMore"),
                  loading: more?.loading === true,
                  onSelect: () => void loadRows(g, rows),
                }}
                {...(moreError[g.agent.id] !== undefined
                  ? { description: moreError[g.agent.id] }
                  : {})}
              />,
            ]
          : items;
      })}
      {pages.next === null
        ? null
        : [
            <ObjectRow
              key="more-groups"
              mark={{ icon: "more-horizontal" }}
              name={t("loadMore")}
              action={{
                label: t("loadMore"),
                loading: pages.loadingMore,
                onSelect: pages.loadMore,
              }}
              {...(pages.error !== null ? { description: pages.error } : {})}
            />,
          ]}
    </ListPage>
  );
}
