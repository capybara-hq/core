"use client";

import {
  Button,
  Card,
  formatRelative,
  Grid,
  ItemList,
  type ItemListRow,
  KeyValue,
  OverviewPage,
  Skeleton,
  Stack,
  TextLink,
  untitledLabel,
  useNow,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../components/ErrorFrame";
import { NoAccess } from "../../components/NoAccess";
import { navLevelOf } from "../../components/shell/nav";
import { usePagePath } from "../../components/shell/path";
import { useSession } from "../../components/shell/session";
import { useRouter } from "../../i18n/navigation";
import { type Agent, type ProviderModels, setupReady } from "../../lib/agents";
import type { ApiClientError } from "../../lib/api";
import { decideApproval } from "../../lib/approvals";
import { requestSubject } from "../../lib/catalog";
import type { Conversation } from "../../lib/conversations";
import type { InboxItem } from "../../lib/inbox";
import { agentsQuery } from "../../lib/query/agents";
import { retryOnMountOf } from "../../lib/query/client";
import { connectorsQuery, modelsQuery } from "../../lib/query/conversation";
import { inboxQuery } from "../../lib/query/inbox";
import { keys } from "../../lib/query/keys";
import { membersQuery } from "../../lib/query/members";
import { useAppMutation } from "../../lib/query/mutation";
import { usePageQuery } from "../../lib/query/page-query";
import { conversationGroupsQuery, readinessQuery } from "../../lib/query/shell";
import { skillsQuery } from "../../lib/query/skills";
import { useWorkspace } from "../../lib/query/workspace";
import { useErrorMessage } from "../../lib/use-error-message";
import NotFound from "./not-found";

export type OverviewData = {
  agents: Agent[];
  providers: ProviderModels[];
  /**
   * `undefined` while it is read; `null` when the kernel could not read it (a section: the panel
   * draws its own error).
   */
  inbox: InboxItem[] | null | undefined;
  /** As `inbox`. */
  recent: (Conversation & { agentName: string })[] | null | undefined;
  /** Agent ids by latest activity (the groups' order). */
  recentAgents: string[];
  counts: { skills?: number; connectors?: number; members?: number };
};

/** How many conversations the overview offers to pick up. */
const RECENT = 5;

/**
 * `/`: the overview, from the query cache (the layout prefetched it on a first load). What waits on
 * me (the inbox, approvals approvable in place), the conversations to pick up, the organization at
 * a glance and the agents I use most. Until the org is ready the frame draws the setup home here,
 * and the view draws nothing. A decision invalidates the inbox and the conversations.
 */
export default function HomeView() {
  const ws = useWorkspace({ setup: "home" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Home orgId={ws.orgId} />;
}

function Home({ orgId }: { orgId: string }) {
  const readiness = useQuery(readinessQuery(orgId)).data;
  if (readiness === undefined || !setupReady(readiness)) return null;
  return <Overview orgId={orgId} />;
}

/** `null` when the role may not read it (403 / 404), `undefined` while it is read. */
const optionalOf = <T,>(q: UseQueryResult<T, ApiClientError>): T | null | undefined =>
  q.data !== undefined
    ? q.data
    : q.error !== null && (q.error.status === 403 || q.error.status === 404)
      ? null
      : undefined;

function Overview({ orgId }: { orgId: string }) {
  const t = useTranslations("home");
  const { me } = useSession();
  const home = usePagePath("home");
  const agents = usePageQuery(agentsQuery(orgId));
  const models = usePageQuery(modelsQuery(orgId));
  const inboxQ = inboxQuery(orgId);
  const inbox = useQuery({ ...inboxQ, retryOnMount: retryOnMountOf(inboxQ.queryKey) });
  const groupsQ = conversationGroupsQuery(orgId);
  const groups = useQuery({ ...groupsQ, retryOnMount: retryOnMountOf(groupsQ.queryKey) });
  const skillsQ = skillsQuery(orgId);
  const skills = useQuery({ ...skillsQ, retryOnMount: retryOnMountOf(skillsQ.queryKey) });
  const connectorsQ = connectorsQuery(orgId);
  const connectors = useQuery({
    ...connectorsQ,
    retryOnMount: retryOnMountOf(connectorsQ.queryKey),
  });
  const membersQ = membersQuery(orgId);
  const members = useQuery({ ...membersQ, retryOnMount: retryOnMountOf(membersQ.queryKey) });
  const membership = me.memberships.find((m) => m.orgId === orgId);
  const tRoles = useTranslations("members.roles");
  const role = membership ? tRoles(membership.role as "owner") : "";
  const orgName = membership?.name ?? "";
  // The counts this role may not read are left out; any other failure fails the page.
  const optional = [skills, connectors, members] as UseQueryResult<unknown, ApiClientError>[];
  const fatal = optional.find(
    (q) => q.data === undefined && q.error !== null && optionalOf(q) === undefined,
  );
  if (agents.kind === "notFound" || models.kind === "notFound") return <NotFound />;
  if (agents.kind === "error") return <ErrorFrame reset={agents.retry} />;
  if (models.kind === "error") return <ErrorFrame reset={models.retry} />;
  if (fatal) return <ErrorFrame reset={() => void fatal.refetch()} />;
  if (
    agents.kind === "loading" ||
    models.kind === "loading" ||
    optional.some((q) => optionalOf(q) === undefined)
  ) {
    return (
      <OverviewPage
        header={{
          path: home,
          title: t("title"),
          description: t("dailyDescription", { org: orgName, role }),
          actions: overviewActions(
            { newAgent: t("newAgent"), newConversation: t("newConversation") },
            navLevelOf(me) !== "guest",
          ),
        }}
        // The loaded cards with their real titles and links, their bodies placeholders
        loading={{ stats: 0, keep: true }}
      >
        <OverviewCardsLoading orgName={orgName} member={navLevelOf(me) !== "guest"} />
      </OverviewPage>
    );
  }
  // The conversations to pick up: the newest rows of the sidebar's groups.
  const recent = groups.data?.groups
    .flatMap((g) => g.conversations.map((c) => ({ ...c, agentName: g.agent.name })))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, RECENT);
  const skillsN = optionalOf(skills);
  const connectorsN = optionalOf(connectors);
  const membersN = optionalOf(members);
  const data: OverviewData = {
    agents: agents.data.agents,
    providers: models.data.providers,
    inbox: inbox.data !== undefined ? inbox.data.items : inbox.error !== null ? null : undefined,
    recent: recent !== undefined ? recent : groups.error !== null ? null : undefined,
    recentAgents: groups.data?.groups.map((g) => g.agent.id) ?? [],
    counts: {
      ...(skillsN ? { skills: skillsN.skills.length } : {}),
      ...(connectorsN ? { connectors: connectorsN.connectors.length } : {}),
      ...(membersN ? { members: membersN.members.length } : {}),
    },
  };
  // Org settings open from member up (guests get the no-access page there, R4)
  const member = navLevelOf(me) !== "guest";
  const orgCard = (
    <Card
      title={orgName}
      {...(member
        ? { actions: <TextLink href="/settings/organization">{t("orgSettings")}</TextLink> }
        : {})}
    >
      <KeyValue
        columns={2}
        rows={[
          { k: t("agents"), v: String(data.agents.length) },
          ...(data.counts.skills !== undefined
            ? [{ k: t("skills"), v: String(data.counts.skills) }]
            : []),
          ...(data.counts.connectors !== undefined
            ? [{ k: t("connectors"), v: String(data.counts.connectors) }]
            : []),
          ...(data.counts.members !== undefined
            ? [{ k: t("members"), v: String(data.counts.members) }]
            : []),
          {
            k: t("models"),
            v: String(data.providers.reduce((n, p) => n + p.models.length, 0)),
          },
          { k: t("role"), v: role },
        ]}
      />
    </Card>
  );

  return (
    <DailyOverview orgId={orgId} data={data} orgName={orgName} role={role} orgCard={orgCard} />
  );
}

/**
 * The overview's cards while the reads are on the way: the same grid and cards as DailyOverview,
 * with their static titles and links real (the org's name comes with the session) and placeholder
 * rows for the bodies (the org card's facts are two columns of three rows).
 */
function OverviewCardsLoading({ orgName, member }: { orgName: string; member: boolean }) {
  const t = useTranslations("home");
  return (
    <Grid columns="main-side">
      <Stack gap={16}>
        <Card
          title={t("inbox.title")}
          actions={<TextLink href="/inbox">{t("inbox.open")}</TextLink>}
        >
          <Skeleton rows={3} />
        </Card>
        <Card title={t("recent.title")}>
          <Skeleton rows={3} />
        </Card>
      </Stack>
      <Stack gap={16}>
        <Card
          title={orgName}
          {...(member
            ? { actions: <TextLink href="/settings/organization">{t("orgSettings")}</TextLink> }
            : {})}
        >
          <Skeleton rows={3} />
        </Card>
        <Card
          title={t("agentsCard.title")}
          actions={<TextLink href="/agents">{t("agentsCard.all")}</TextLink>}
        >
          <Skeleton rows={3} />
        </Card>
      </Stack>
    </Grid>
  );
}

/** The header's actions: 新建 Agent for members up (`agents.create`, R1), a new conversation. */
function overviewActions(labels: { newAgent: string; newConversation: string }, member: boolean) {
  return [
    ...(member
      ? [{ label: labels.newAgent, variant: "default" as const, href: "/agents/new" }]
      : []),
    { label: labels.newConversation, variant: "primary" as const, href: "/chat" },
  ];
}

/** Day to day: what waits on me, the conversations to pick up, the org, my agents. */
function DailyOverview({
  orgId,
  data,
  orgName,
  role,
  orgCard,
}: {
  orgId: string;
  data: OverviewData;
  orgName: string;
  role: string;
  orgCard: React.ReactNode;
}) {
  const home = usePagePath("home");
  const t = useTranslations("home");
  const locale = useLocale();
  // the server's clock and zone while hydrating, so the ages and dates match its render
  const now = useNow();
  const timeZone = useTimeZone();
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const [approving, setApproving] = useState<string>();
  // An approval decided here changes the inbox (and its count) and the conversation's state.
  const decide = useAppMutation({
    fn: (id: string) => decideApproval(orgId, id, { decision: "approve", scope: "once" }),
    invalidates: (id) => [
      keys.org(orgId).inbox(),
      keys.org(orgId).inboxCount(),
      keys.org(orgId).conversationGroupsAll(),
      keys.org(orgId).approval(id),
    ],
  });
  const inbox = data.inbox ?? [];

  async function approve(id: string) {
    setApproving(id);
    try {
      await decide.mutateAsync(id);
      toast.success(t("inbox.approved"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setApproving(undefined);
    }
  }

  const waiting = new Set(
    inbox.flatMap((i) => (i.type === "tool_approval" ? [i.approval.conversationId] : [])),
  );
  const inboxRows: ItemListRow[] = inbox.slice(0, 5).map((item): ItemListRow => {
    const when = formatRelative(item.createdAt, locale, now);
    if (item.type === "tool_approval") {
      const a = item.approval;
      return {
        id: item.id,
        tag: { label: t("inbox.toolApproval"), tone: "accent" },
        title: t("inbox.toolApprovalTitle", { agent: a.agent.name, tool: a.toolName }),
        meta: when,
        href: a.conversationPath,
        actions: (
          <>
            <Button density="dense" onClick={() => router.push(a.conversationPath)}>
              {t("inbox.view")}
            </Button>
            <Button
              density="dense"
              variant="primary"
              loading={approving === a.id}
              onClick={() => void approve(a.id)}
            >
              {t("inbox.approveOnce")}
            </Button>
          </>
        ),
      };
    }
    if (item.type === "skill_change") {
      const c = item.skillChange;
      return {
        id: item.id,
        tag: { label: t("inbox.skillChange") },
        title: t(c.skillId === null ? "inbox.skillNew" : "inbox.skillUpdate", {
          agent: c.agent.name,
          skill: c.name,
        }),
        meta: when,
        href: "/inbox",
      };
    }
    if (item.type === "skill_renamed") {
      const r = item.notice.skillRenamed;
      return {
        id: item.id,
        tag: { label: t("inbox.skillRenamed") },
        title: t("inbox.skillRenamedTitle", { from: r.from, to: r.to }),
        meta: when,
        href: "/inbox",
      };
    }
    return {
      id: item.id,
      tag: { label: t("inbox.catalogRequest") },
      title: t("inbox.catalogRequestTitle", {
        item:
          requestSubject(item.request).displayName?.[locale === "zh" ? "zh" : "en"] ??
          requestSubject(item.request).name,
      }),
      meta: when,
      href: "/inbox",
    };
  });

  const recentRows: ItemListRow[] = (data.recent ?? []).map((c) => ({
    id: c.id,
    title: c.title ?? untitledLabel(new Date(c.createdAt), locale === "zh" ? "zh" : "en", timeZone),
    meta: `${c.agentName} · ${formatRelative(c.updatedAt, locale, now)}`,
    href: `/chat/${encodeURIComponent(c.id)}`,
    ...(waiting.has(c.id)
      ? { status: { label: t("recent.waiting"), tone: "accent" as const } }
      : {}),
  }));

  const order = new Map(data.recentAgents.map((id, i) => [id, i]));
  const agentRows: ItemListRow[] = [...data.agents]
    .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
    .slice(0, 3)
    .map((a) => ({
      id: a.id,
      title: a.definition.name,
      meta: a.definition.model ? a.definition.model.model : "",
      href: `/agents/${encodeURIComponent(a.id)}`,
      actions: (
        <Button
          density="dense"
          onClick={() => router.push(`/chat?agent=${encodeURIComponent(a.id)}`)}
        >
          {t("agentsCard.chat")}
        </Button>
      ),
    }));

  const pending = inbox.length;
  return (
    <OverviewPage
      header={{
        path: home,
        title: t("title"),
        description:
          pending > 0
            ? t("dailyDescriptionPending", { org: orgName, role, count: pending })
            : t("dailyDescription", { org: orgName, role }),
        actions: overviewActions(
          { newAgent: t("newAgent"), newConversation: t("newConversation") },
          navLevelOf(me) !== "guest",
        ),
      }}
    >
      <Grid columns="main-side">
        <Stack gap={16}>
          <Card
            title={pending > 0 ? t("inbox.titleCount", { count: pending }) : t("inbox.title")}
            actions={<TextLink href="/inbox">{t("inbox.open")}</TextLink>}
          >
            {data.inbox === undefined ? (
              <Skeleton rows={3} />
            ) : (
              <ItemList
                label={t("inbox.title")}
                rows={inboxRows}
                empty={data.inbox === null ? t("inbox.unavailable") : t("inbox.empty")}
              />
            )}
          </Card>
          <Card title={t("recent.title")}>
            {data.recent === undefined ? (
              <Skeleton rows={3} />
            ) : (
              <ItemList
                label={t("recent.title")}
                rows={recentRows}
                empty={data.recent === null ? t("recent.unavailable") : t("recent.empty")}
              />
            )}
          </Card>
        </Stack>
        <Stack gap={16}>
          {orgCard}
          <Card
            title={t("agentsCard.title")}
            actions={<TextLink href="/agents">{t("agentsCard.all")}</TextLink>}
          >
            <ItemList label={t("agentsCard.title")} rows={agentRows} />
          </Card>
        </Stack>
      </Grid>
    </OverviewPage>
  );
}
