"use client";

import { FormPage, FormSection, KeyValue, type PageHeaderProps, Text } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AgentChannels } from "../../../../components/AgentChannels";
import {
  type AgentFormData,
  AgentFormLoading,
  useAgentForm,
  useAgentFormData,
} from "../../../../components/AgentForm";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { ReassignOwnerDialog } from "../../../../components/ReassignOwnerDialog";
import { navLevelOf } from "../../../../components/shell/nav";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";
import type { ChannelConnection } from "../../../../lib/channels";
import { modelLabel } from "../../../../lib/extension-label";
import { canEditAgent, canUpdateOrg } from "../../../../lib/org-settings";
import { agentQuery } from "../../../../lib/query/agents";
import { channelsQuery } from "../../../../lib/query/channels";
import { retryOnMountOf } from "../../../../lib/query/client";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import type { Me } from "../../../../lib/session";
import NotFound from "../../not-found";

/**
 * `/agents/[id]`：修改 agent（FormPage）：与新建同一套分组，按当前定义预填；技能分组里另有
 * agent 自己写的技能（只读，负责人可删）。保存后回到列表。组织管理员与负责人在页头有「运行记录」入口
 * （轨迹查看器，按该 agent 筛选；能否查看最终由内核判定）。Viewers who may not change the agent get
 * it read-only (R3). From the query cache (the layout prefetched it on a first load); an agent the
 * kernel does not find is the not-found state. Keyed by the agent: the form keeps what was typed
 * when the agent is read again (a new owner updates it in place).
 */
export default function AgentView({ agentId }: { agentId: string }) {
  const ws = useWorkspace({ setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <AgentPage key={agentId} orgId={ws.orgId} me={ws.me} agentId={agentId} />;
}

function AgentPage({ orgId, me, agentId }: { orgId: string; me: Me; agentId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const router = useRouter();
  const agent = usePageQuery(agentQuery(orgId, agentId));
  if (agent.kind === "notFound") return <NotFound />;
  if (agent.kind === "error") return <ErrorFrame reset={agent.retry} />;
  if (agent.kind === "loading") {
    return (
      <FormPage
        loading
        header={{ path: [...scope, { label: "agents", href: "/agents" }], title: "" }}
        actionRow={{
          cancel: { label: t("common.cancel"), onSelect: () => router.push("/agents") },
          primary: { label: t("agents.form.submit"), onSelect: () => {} },
        }}
      >
        <AgentFormLoading />
      </FormPage>
    );
  }
  if (!canEditAgent(me, agent.data)) return <ViewAgent agent={agent.data} />;
  return <EditAgent orgId={orgId} agent={agent.data} />;
}

/** The agent read-only, for viewers who may use it but not change it (R3): one line says why. */
function ViewAgent({ agent }: { agent: Agent }) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const router = useRouter();
  const def = agent.definition;
  return (
    <FormPage
      header={{
        path: [...scope, { label: "agents", href: "/agents" }, { label: def.name }],
        title: def.name,
      }}
      actionRow={{
        cancel: { label: t("common.back"), onSelect: () => router.push("/agents") },
        primary: {
          label: t("agents.chat"),
          onSelect: () => router.push(`/chat?agent=${encodeURIComponent(agent.id)}`),
        },
      }}
    >
      <FormSection id="basic" title={t("agents.form.basicSection")}>
        <Text tone="muted">{t("agents.readOnly")}</Text>
        <KeyValue
          rows={[
            { k: t("agents.form.nameLabel"), v: def.name },
            {
              k: t("agents.form.modelLabel"),
              // Read-only view without a providers list: the provider id stands in.
              v: modelLabel({ name: def.model.provider }, def.model.model, "en"),
            },
            { k: t("agents.form.visibilityLabel"), v: t(`agents.scope.${agent.visibility}`) },
          ]}
        />
      </FormSection>
    </FormPage>
  );
}

/**
 * The edit form: its reads (the form's lists, the agent's channel connections as a section whose
 * failure is its own state) from the cache; the form's skeleton until the form's lists are here.
 */
function EditAgent({ orgId, agent }: { orgId: string; agent: Agent }) {
  const t = useTranslations();
  const router = useRouter();
  const state = useAgentFormData(orgId, agent.id);
  const channelsQ = channelsQuery(orgId);
  const channels = useQuery({ ...channelsQ, retryOnMount: retryOnMountOf(channelsQ.queryKey) });
  const header = useEditHeader(agent);
  if (state.kind === "error") return <ErrorFrame reset={state.retry} />;
  if (state.kind === "loading" || (channels.data === undefined && channels.error === null)) {
    return (
      <FormPage
        loading
        header={{ path: header.path, title: header.title }}
        actionRow={{
          cancel: { label: t("common.cancel"), onSelect: () => router.push("/agents") },
          primary: { label: t("agents.form.submit"), onSelect: () => {} },
        }}
      >
        <AgentFormLoading channels />
      </FormPage>
    );
  }
  return (
    <EditForm
      orgId={orgId}
      agent={agent}
      data={state.data}
      header={header}
      channels={channels.data?.channels.filter((c) => c.agentId === agent.id) ?? null}
    />
  );
}

/** The edit page's header without its actions (the loading state draws it too). */
function useEditHeader(agent: Agent): PageHeaderProps {
  const scope = usePagePath("org");
  const t = useTranslations();
  const title = agent.definition.name || t("agents.form.editTitle");
  return { path: [...scope, { label: "agents", href: "/agents" }, { label: title }], title };
}

function EditForm({
  orgId,
  agent,
  data,
  header: base,
  channels,
}: {
  orgId: string;
  agent: Agent;
  data: AgentFormData;
  header: PageHeaderProps;
  channels: ChannelConnection[] | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { me } = useSession();
  const [reassigning, setReassigning] = useState(false);
  const admin = canUpdateOrg(me);
  const done = () => router.push("/agents");
  const form = useAgentForm(orgId, done, data, agent);
  const level = navLevelOf(me);
  const canViewRuns =
    level === "admin" || (level === "member" && agent.ownerAccountId === me.account.id);
  return (
    <FormPage
      header={{
        path: base.path,
        title: base.title,
        ...((canViewRuns || admin) && {
          actions: [
            ...(canViewRuns
              ? [
                  {
                    label: t("agents.runHistory"),
                    variant: "default" as const,
                    href: `/trajectories?agentId=${encodeURIComponent(agent.id)}`,
                  },
                ]
              : []),
            // agents.manage: org admins only
            ...(admin
              ? [
                  {
                    label: t("agents.reassign.action"),
                    variant: "default" as const,
                    onSelect: () => setReassigning(true),
                  },
                ]
              : []),
          ],
        }),
      }}
      actionRow={{
        unsaved: form.unsaved,
        errors: form.errors,
        ...(form.saved ? {} : { cancel: { label: t("common.cancel"), onSelect: done } }),
        primary: form.saved
          ? { label: t("agents.form.continue"), onSelect: done }
          : {
              label: t("agents.form.submit"),
              onSelect: form.submit,
              loading: form.pending,
              disabled: !form.canSubmit,
            },
      }}
    >
      {form.sections}
      <AgentChannels agentId={agent.id} channels={channels} />
      {reassigning ? (
        <ReassignOwnerDialog
          orgId={orgId}
          agentId={agent.id}
          ownerAccountId={agent.ownerAccountId}
          needsReassignment={agent.needsReassignment === true}
          onClose={() => setReassigning(false)}
        />
      ) : null}
    </FormPage>
  );
}
