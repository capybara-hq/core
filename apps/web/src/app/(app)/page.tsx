"use client";

import {
  Button,
  Card,
  Grid,
  ItemList,
  type ItemListRow,
  KeyValue,
  OverviewPage,
  Skeleton,
  Stack,
  Text,
  TextLink,
  untitledLabel,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { navLevelOf } from "../../components/shell/nav";
import { usePagePath } from "../../components/shell/path";
import { RequireSession, useSession } from "../../components/shell/session";
import { useRouter } from "../../i18n/navigation";
import { type Agent, listAgents, listModels, type ProviderModels } from "../../lib/agents";
import { decideApproval } from "../../lib/approvals";
import { listConnectors } from "../../lib/connectors";
import { type Conversation, listConversationGroups } from "../../lib/conversations";
import { type InboxItem, listInbox } from "../../lib/inbox";
import { listMembers } from "../../lib/members";
import { listSkills } from "../../lib/skills";
import { ago } from "../../lib/time";
import { useErrorMessage } from "../../lib/use-error-message";
import { useLoad } from "../../lib/use-load";

/**
 * `/`: the overview. With a current organization: what waits on me (the inbox, approvals approvable
 * in place), the conversations to pick up, the organization at a glance and the agents I use most.
 * Until a model and an agent exist the app frame draws the setup layout here instead (web-order
 * spec §3.8). Without a current organization the app frame shows the org chooser instead
 * (`OrgChooser`); creating another org is in the account menu. Signed-out visitors are sent to
 * login by (app).
 */
export default function HomePage() {
  return (
    <RequireSession>
      <Home />
    </RequireSession>
  );
}

function Home() {
  const { me } = useSession();
  // Without a current org the app frame shows the org chooser over the whole shell instead.
  if (me.currentOrgId === null) return null;
  return <Overview key={me.currentOrgId} orgId={me.currentOrgId} />;
}

type OverviewData = {
  agents: Agent[];
  providers: ProviderModels[];
  inbox: InboxItem[];
  recent: (Conversation & { agentName: string })[];
  /** Agent ids by latest activity (the groups' order). */
  recentAgents: string[];
  counts: { skills?: number; connectors?: number; members?: number };
};

/** One request that may be refused for this role (members, connectors): its value or undefined. */
const optional = <T,>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);

async function loadOverview(orgId: string): Promise<OverviewData> {
  const [agents, models, inbox, groups, skills, connectors, members] = await Promise.all([
    listAgents(orgId),
    listModels(orgId),
    listInbox(orgId),
    listConversationGroups(orgId, { perGroup: 5, limit: 10 }),
    optional(listSkills(orgId)),
    optional(listConnectors(orgId)),
    optional(listMembers(orgId)),
  ]);
  const recent = groups.groups
    .flatMap((g) => g.conversations.map((c) => ({ ...c, agentName: g.agent.name })))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 5);
  return {
    agents: agents.agents,
    providers: models.providers,
    inbox: inbox.items,
    recent,
    recentAgents: groups.groups.map((g) => g.agent.id),
    counts: {
      ...(skills ? { skills: skills.skills.length } : {}),
      ...(connectors ? { connectors: connectors.connectors.length } : {}),
      ...(members ? { members: members.members.length } : {}),
    },
  };
}

function Overview({ orgId }: { orgId: string }) {
  const home = usePagePath("home");
  const t = useTranslations("home");
  const { me } = useSession();
  const { state, reload } = useLoad(() => loadOverview(orgId), [orgId]);
  const membership = me.memberships.find((m) => m.orgId === orgId);
  const tRoles = useTranslations("members.roles");
  const role = membership ? tRoles(membership.role as "owner") : "";

  if (state.kind === "loading") {
    return (
      <OverviewPage header={{ path: home, title: t("greeting", { name: me.account.displayName }) }}>
        <Skeleton rows={6} />
      </OverviewPage>
    );
  }
  if (state.kind === "error") {
    return (
      <OverviewPage header={{ path: home, title: t("greeting", { name: me.account.displayName }) }}>
        <Card>
          <Stack gap={12}>
            <Text tone="muted">{t("loadFailed")}</Text>
            <Button onClick={reload}>{t("retry")}</Button>
          </Stack>
        </Card>
      </OverviewPage>
    );
  }
  const data = state.data;
  const orgName = membership?.name ?? "";
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
    <DailyOverview
      orgId={orgId}
      data={data}
      orgName={orgName}
      role={role}
      orgCard={orgCard}
      onChanged={reload}
    />
  );
}

/** Day to day: what waits on me, the conversations to pick up, the org, my agents. */
function DailyOverview({
  orgId,
  data,
  orgName,
  role,
  orgCard,
  onChanged,
}: {
  orgId: string;
  data: OverviewData;
  orgName: string;
  role: string;
  orgCard: React.ReactNode;
  onChanged(): void;
}) {
  const home = usePagePath("home");
  const t = useTranslations("home");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const [approving, setApproving] = useState<string>();

  async function approve(id: string) {
    setApproving(id);
    try {
      await decideApproval(orgId, id, { decision: "approve", scope: "once" });
      toast.success(t("inbox.approved"));
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setApproving(undefined);
    }
  }

  const waiting = new Set(
    data.inbox.flatMap((i) => (i.type === "tool_approval" ? [i.approval.conversationId] : [])),
  );
  const inboxRows: ItemListRow[] = data.inbox.slice(0, 5).map((item): ItemListRow => {
    const when = ago(item.createdAt, locale);
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
    return {
      id: item.id,
      tag: { label: t("inbox.catalogRequest") },
      title: t("inbox.catalogRequestTitle", {
        item:
          item.request.item.displayName?.[locale === "zh" ? "zh" : "en"] ?? item.request.item.name,
      }),
      meta: when,
      href: "/inbox",
    };
  });

  const recentRows: ItemListRow[] = data.recent.map((c) => ({
    id: c.id,
    title: c.title ?? untitledLabel(new Date(c.createdAt), locale === "zh" ? "zh" : "en"),
    meta: `${c.agentName} · ${ago(c.updatedAt, locale)}`,
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

  const pending = data.inbox.length;
  return (
    <OverviewPage
      header={{
        path: home,
        title: t("greeting", { name: me.account.displayName }),
        description:
          pending > 0
            ? t("dailyDescriptionPending", { org: orgName, role, count: pending })
            : t("dailyDescription", { org: orgName, role }),
        actions: [
          // agents.create: members up (R1)
          ...(navLevelOf(me) !== "guest"
            ? [{ label: t("newAgent"), variant: "default" as const, href: "/agents/new" }]
            : []),
          { label: t("newConversation"), variant: "primary" as const, href: "/chat" },
        ],
      }}
    >
      <Grid columns="main-side">
        <Stack gap={16}>
          <Card
            title={pending > 0 ? t("inbox.titleCount", { count: pending }) : t("inbox.title")}
            actions={<TextLink href="/inbox">{t("inbox.open")}</TextLink>}
          >
            <ItemList label={t("inbox.title")} rows={inboxRows} empty={t("inbox.empty")} />
          </Card>
          <Card title={t("recent.title")}>
            <ItemList label={t("recent.title")} rows={recentRows} empty={t("recent.empty")} />
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
