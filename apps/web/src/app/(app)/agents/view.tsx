"use client";

import {
  type EmptyStateProps,
  ListPage,
  type PageHeaderProps,
  Segmented,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AgentCard, type AgentScope, inScope, matchesAgent } from "../../../components/AgentList";
import { matchesTemplate, TemplateCard } from "../../../components/AgentTemplateCards";
import { useComponentState, useComponentSwitch } from "../../../components/ComponentSwitch";
import { FormError } from "../../../components/form-error";
import { NoAccess } from "../../../components/NoAccess";
import { navLevelOf } from "../../../components/shell/nav";
import { usePagePath } from "../../../components/shell/path";
import type { AgentsTab } from "../../../lib/agents";
import { usableRows } from "../../../lib/components";
import { canUpdateOrg } from "../../../lib/org-settings";
import { agentsQuery, agentTemplatesQuery } from "../../../lib/query/agents";
import { retryOnMountOf } from "../../../lib/query/client";
import { orgComponentsQuery } from "../../../lib/query/components";
import { membersQuery } from "../../../lib/query/members";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import type { Me } from "../../../lib/session";
import NotFound from "../not-found";

/**
 * `/agents` (rulings P4-14 to P4-16): one page with the tabs 智能体 and 模板 (`?tab=templates`,
 * members up: guests cannot create agents, so they get the agents and no tabs), both lists as
 * cards. 智能体: the org's agents with the filter 全部 / 我的 / 组织共享 in the toolbar; 模板: the
 * templates the org can use and the platform ones offered to it, with the org admin's switch. One
 * search per tab (cleared on a switch). From the query cache (the layout prefetched both tabs'
 * lists on a first load, so a switch paints at once and the head counts both).
 */
export default function AgentsView({ tab = "agents" }: { tab?: AgentsTab }) {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Agents orgId={ws.orgId} me={ws.me} initialTab={tab} />;
}

/** The open tab, kept in the address (`?tab=templates`; 智能体 is the bare `/agents`). */
/** The page head both tabs share; each adds the path. */
type Head = Omit<PageHeaderProps, "path">;

function useAgentsTab(initial: AgentsTab): [AgentsTab, (t: AgentsTab) => void] {
  const [tab, setTab] = useState<AgentsTab>(initial);
  const select = (next: AgentsTab) => {
    setTab(next);
    // In an event handler, never during render (web-ssr-location).
    const url = new URL(window.location.href);
    if (next === "agents") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  };
  return [tab, select];
}

function Agents({ orgId, me, initialTab }: { orgId: string; me: Me; initialTab: AgentsTab }) {
  const t = useTranslations("agents");
  // agents.create is for members up: guests never see 新建 nor the templates (R1, P4-14)
  const member = navLevelOf(me) !== "guest";
  const [tab, setTab] = useAgentsTab(member ? initialTab : "agents");
  const [query, setQuery] = useState("");
  // Both counts for the head's tabs: the open tab's list is its page read, the other tab's the
  // same cache entry (prefetched for members up)
  const agentCount = useQuery(agentsQuery(orgId)).data?.agents.length;
  const templates = useQuery({ ...agentTemplatesQuery(orgId), enabled: member });
  const cq = orgComponentsQuery(orgId, { kind: "agent_template" });
  const offered = useQuery({
    ...cq,
    enabled: member,
    retryOnMount: retryOnMountOf(cq.queryKey),
  });
  const templateCount =
    templates.data === undefined
      ? undefined
      : usableRows(templates.data.templates, offered.data?.components).length;
  const switchTo = (next: AgentsTab) => {
    if (next === tab) return;
    setQuery("");
    setTab(next);
  };
  const newAgent = { label: t("new"), variant: "primary" as const, href: "/agents/new" };
  // The head without its path: each tab writes it (`web-ui-page-path` reads it there)
  const head: Head = {
    title: t("title"),
    ...(member ? { actions: [newAgent] } : {}),
    ...(member
      ? {
          tabs: [
            {
              id: "agents",
              label: t("pageTabs.agents"),
              // the open tab counts (a dash while it loads); the other once it is known
              ...(agentCount !== undefined || tab === "agents" ? { count: agentCount ?? 0 } : {}),
              onSelect: () => switchTo("agents"),
            },
            {
              id: "templates",
              label: t("pageTabs.templates"),
              ...(templateCount !== undefined || tab === "templates"
                ? { count: templateCount ?? 0 }
                : {}),
              onSelect: () => switchTo("templates"),
            },
          ],
          activeTab: tab,
        }
      : {}),
    search: {
      label: tab === "templates" ? t("templates.search") : t("search"),
      value: query,
      onChange: setQuery,
    },
  };
  return tab === "templates" ? (
    <TemplatesTab orgId={orgId} me={me} head={head} query={query} />
  ) : (
    <AgentsTabList
      orgId={orgId}
      me={me}
      head={head}
      query={query}
      newAgent={member ? newAgent : undefined}
    />
  );
}

/** A tab whose list could not be read: the head and its tabs stay, the list says so with 重试. */
function useTabError(): (retry: () => void) => EmptyStateProps {
  const t = useTranslations("errors.page");
  return (retry) => ({
    text: t("title"),
    hint: t("description"),
    action: { label: t("retry"), variant: "default", onSelect: retry },
  });
}

/**
 * 智能体: the agents as cards with the toolbar filter 全部 / 我的 / 组织共享 (a page-local view
 * choice, as the old head tabs were) and the search. The owner names come from the members list
 * (members up; a guest's cards show the visibility only).
 */
function AgentsTabList({
  orgId,
  me,
  head,
  query,
  newAgent,
}: {
  orgId: string;
  me: Me;
  head: Head;
  query: string;
  newAgent: { label: string; variant: "primary"; href: string } | undefined;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("agents");
  const tabError = useTabError();
  const list = usePageQuery(agentsQuery(orgId));
  const mq = membersQuery(orgId);
  const members = useQuery({
    ...mq,
    enabled: navLevelOf(me) !== "guest",
    retryOnMount: retryOnMountOf(mq.queryKey),
  });
  const [filter, setFilter] = useState<AgentScope>("all");
  if (list.kind === "notFound") return <NotFound />;
  const filters = (
    <Segmented
      label={t("filter")}
      value={filter}
      onChange={(v) => setFilter(v as AgentScope)}
      options={(["all", "mine", "shared"] as const).map((id) => ({
        value: id,
        label: t(`tabs.${id}`),
      }))}
    />
  );
  const header = { ...head, path: [...scope, { label: "agents" }] };
  const common = { variant: "cards" as const, listLabel: t("title"), filters };
  if (list.kind === "loading") {
    return <ListPage header={header} {...common} loading={{ rows: 6 }} />;
  }
  if (list.kind === "error") {
    return <ListPage header={header} {...common} empty={tabError(list.retry)} />;
  }
  const all = list.data.agents;
  const rows = all.filter((a) => inScope(a, filter, me.account.id) && matchesAgent(a, query));
  const nameOf = (accountId: string) =>
    members.data?.members.find((m) => m.account.id === accountId)?.account.displayName;
  return (
    <ListPage
      header={header}
      {...common}
      {...(rows.length === 0
        ? {
            empty:
              all.length === 0
                ? { text: t("empty"), ...(newAgent !== undefined ? { action: newAgent } : {}) }
                : { text: t("noMatch") },
          }
        : {})}
    >
      {rows.map((a) => (
        <AgentCard key={a.id} agent={a} me={me} ownerName={nameOf(a.ownerAccountId)} />
      ))}
    </ListPage>
  );
}

/**
 * 模板 (members up): the templates the org can use (its own and the platform ones on in it) and
 * the platform ones offered to it but off, by name, as cards (ruling P4-16). Org admins switch
 * platform templates (启用, 停用 with the preview of the agents using one) and edit, share or
 * delete the org's own; a switch failure is the head's callout. When the offered components
 * cannot be read, the off ones and their switches are missing until a retry (a warn callout).
 */
function TemplatesTab({
  orgId,
  me,
  head,
  query,
}: {
  orgId: string;
  me: Me;
  head: Head;
  query: string;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("agents.templates");
  const tc = useTranslations("orgComponents");
  const tabError = useTabError();
  const admin = canUpdateOrg(me);
  const list = usePageQuery(agentTemplatesQuery(orgId));
  const cq = orgComponentsQuery(orgId, { kind: "agent_template" });
  const offered = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) });
  const stateOf = useComponentState();
  const { actionsOf, dialog, error } = useComponentSwitch({ orgId, admin });
  if (list.kind === "notFound") return <NotFound />;
  const header = { ...head, path: [...scope, { label: "agents" }] };
  const common = {
    variant: "cards" as const,
    listLabel: t("listLabel"),
    ...(error !== undefined
      ? {
          callout: {
            tone: "fail" as const,
            children: <FormError message={error.message} extra={error.extra} />,
          },
        }
      : offered.data === undefined && offered.error !== null
        ? {
            callout: {
              tone: "warn" as const,
              children: tc("listUnavailable"),
              action: { label: tc("retry"), onSelect: () => void offered.refetch() },
            },
          }
        : {}),
  };
  if (list.kind === "loading") {
    return <ListPage header={header} {...common} loading={{ rows: 6 }} />;
  }
  if (list.kind === "error") {
    return <ListPage header={header} {...common} empty={tabError(list.retry)} />;
  }
  const all = usableRows(list.data.templates, offered.data?.components);
  const rows = all.filter((r) => matchesTemplate(r, query));
  return (
    <>
      <ListPage
        header={header}
        {...common}
        {...(rows.length === 0
          ? { empty: { text: all.length === 0 ? t("empty") : t("noMatch") } }
          : {})}
      >
        {rows.map((r) => {
          const c = r.kind === "platform" ? r.component : undefined;
          const id = r.kind === "own" ? r.item.id : (r.item?.id ?? c?.id ?? "");
          return (
            <TemplateCard
              key={id}
              orgId={orgId}
              row={r}
              admin={admin}
              switchActions={c !== undefined ? actionsOf(c) : []}
              stateOf={stateOf}
            />
          );
        })}
      </ListPage>
      {dialog}
    </>
  );
}
