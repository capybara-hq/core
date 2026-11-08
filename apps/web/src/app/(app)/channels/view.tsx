"use client";

import { ListPage, ObjectCard } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { channelPluginLabel } from "../../../lib/channels";
import { labelLocale } from "../../../lib/extension-label";
import { agentsQuery } from "../../../lib/query/agents";
import { channelsQuery } from "../../../lib/query/channels";
import { retryOnMountOf } from "../../../lib/query/client";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import NotFound from "../not-found";

/**
 * `/channels`: the org's channel connections as cards (admins; maintainer decision 2026-11-08,
 * design spec §6.34): each card draws its plugin's icon (the initial without one), the connection
 * name as the link to its detail, the platform's display name (while it fails, the last error, and
 * the platform leads the meta), the bound agent and the unbound-person mode, and the running state. From the query cache
 * (the layout prefetched it on a first load): the connections, and the agents' names by id (a
 * section, display only: a connection shows its agent id when the name is unknown).
 */
export default function ChannelsView() {
  const ws = useWorkspace({ min: "admin", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Channels orgId={ws.orgId} />;
}

function Channels({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("channels");
  const lang = labelLocale(useLocale());
  const [tab, setTab] = useState<"all" | "error">("all");
  const list = usePageQuery(channelsQuery(orgId));
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data;
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const all = list.kind === "ready" ? list.data.channels : [];
  const agentNames: Record<string, string> = Object.fromEntries(
    (agents?.agents ?? []).map((a) => [a.id, a.definition.name]),
  );
  const failing = all.filter((c) => c.status === "error");
  // A tab only when it holds something different from "all".
  const active = tab === "error" && failing.length > 0 ? "error" : "all";
  const rows = active === "error" ? failing : all;
  const header = {
    path: [...scope, { label: "channels" }],
    title: t("title"),
    actions: [{ label: t("new"), variant: "primary" as const, href: "/channels/new" }],
    ...(failing.length > 0
      ? {
          tabs: [
            { id: "all", label: t("tabs.all"), count: all.length, onSelect: () => setTab("all") },
            {
              id: "error",
              label: t("tabs.error"),
              count: failing.length,
              onSelect: () => setTab("error"),
            },
          ],
          activeTab: active,
        }
      : {}),
  };
  const empty =
    all.length === 0
      ? {
          text: t("empty"),
          action: { label: t("new"), variant: "primary" as const, href: "/channels/new" },
        }
      : undefined;
  if (list.kind === "loading") return <ListPage header={header} variant="cards" loading />;
  return (
    <ListPage header={header} variant="cards" listLabel={t("title")} {...(empty ? { empty } : {})}>
      {rows.map((c) => (
        <ObjectCard
          key={c.id}
          avatar={{ image: c.pluginIcon ?? null }}
          title={c.name}
          href={`/channels/${c.id}`}
          // While it fails the last error is the description and the platform leads the meta
          {...(c.status === "error" && c.lastError !== null
            ? {
                description: c.lastError,
                meta: [
                  channelPluginLabel(c, lang),
                  agentNames[c.agentId] ?? c.agentId,
                  t(`policy.${c.unboundPolicy}`),
                ],
              }
            : {
                description: channelPluginLabel(c, lang),
                meta: [agentNames[c.agentId] ?? c.agentId, t(`policy.${c.unboundPolicy}`)],
              })}
          state={
            c.status === "active"
              ? { label: t("status.active"), tone: "ok" }
              : c.status === "error"
                ? { label: t("status.error"), tone: "fail" }
                : { label: t("status.disabled"), tone: "muted" }
          }
        />
      ))}
    </ListPage>
  );
}
