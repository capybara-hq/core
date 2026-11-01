"use client";

import {
  Button,
  Card,
  Grid,
  ItemList,
  type ItemListRow,
  KeyValue,
  OverviewPage,
  Stack,
  TextLink,
  untitledLabel,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { navLevelOf } from "../../components/shell/nav";
import { usePagePath } from "../../components/shell/path";
import { useSession } from "../../components/shell/session";
import { useRouter } from "../../i18n/navigation";
import type { Agent, ProviderModels } from "../../lib/agents";
import { decideApproval } from "../../lib/approvals";
import type { Conversation } from "../../lib/conversations";
import type { InboxItem } from "../../lib/inbox";
import { ago } from "../../lib/time";
import { useErrorMessage } from "../../lib/use-error-message";

export type OverviewData = {
  agents: Agent[];
  providers: ProviderModels[];
  inbox: InboxItem[];
  recent: (Conversation & { agentName: string })[];
  /** Agent ids by latest activity (the groups' order). */
  recentAgents: string[];
  counts: { skills?: number; connectors?: number; members?: number };
};

/**
 * `/`: the overview, from the server's read (`page.tsx`). What waits on me (the inbox, approvals
 * approvable in place), the conversations to pick up, the organization at a glance and the agents
 * I use most. A decision re-renders the page on the server (`router.refresh()`).
 */
export default function HomeView({ orgId, initial }: { orgId: string; initial: OverviewData }) {
  return <Overview orgId={orgId} data={initial} />;
}

function Overview({ orgId, data }: { orgId: string; data: OverviewData }) {
  const t = useTranslations("home");
  const { me } = useSession();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const membership = me.memberships.find((m) => m.orgId === orgId);
  const tRoles = useTranslations("members.roles");
  const role = membership ? tRoles(membership.role as "owner") : "";
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
      onChanged={() => startTransition(() => router.refresh())}
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
  // Approvals decided here: hidden at once, before the server's new overview arrives.
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const inbox = data.inbox.filter(
    (i) => !(i.type === "tool_approval" && decided.has(i.approval.id)),
  );

  async function approve(id: string) {
    setApproving(id);
    try {
      await decideApproval(orgId, id, { decision: "approve", scope: "once" });
      toast.success(t("inbox.approved"));
      setDecided((s) => new Set(s).add(id));
      onChanged();
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

  const pending = inbox.length;
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
