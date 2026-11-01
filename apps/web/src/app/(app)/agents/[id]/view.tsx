"use client";

import { FormPage, FormSection, KeyValue, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { AgentChannels } from "../../../../components/AgentChannels";
import { type AgentFormData, useAgentForm } from "../../../../components/AgentForm";
import { ReassignOwnerDialog } from "../../../../components/ReassignOwnerDialog";
import { navLevelOf } from "../../../../components/shell/nav";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";
import type { ChannelConnection } from "../../../../lib/channels";
import { canUpdateOrg } from "../../../../lib/org-settings";

/**
 * What the server read: the agent, and for a viewer who may change it the form's lists and the
 * agent's channel connections (`null`: they could not be read); `form: null` is the read-only view.
 */
export interface AgentPageData {
  agent: Agent;
  edit: { form: AgentFormData; channels: ChannelConnection[] | null } | null;
}

/**
 * `/agents/[id]`：修改 agent（FormPage）：与新建同一套分组，按当前定义预填；技能分组里另有
 * agent 自己写的技能（只读，负责人可删）。保存后回到列表。组织管理员与负责人在页头有「运行记录」入口
 * （轨迹查看器，按该 agent 筛选；能否查看最终由内核判定）。Viewers who may not change the agent get
 * it read-only (R3). Read on the server (`page.tsx`); a new owner re-renders it there.
 */
export default function AgentView({ orgId, initial }: { orgId: string; initial: AgentPageData }) {
  const { agent, edit } = initial;
  if (edit === null) return <ViewAgent agent={agent} />;
  return (
    <EditAgent
      key={agent.updatedAt}
      orgId={orgId}
      agent={agent}
      form={edit.form}
      channels={edit.channels}
    />
  );
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
              v: `${def.model.provider} / ${def.model.model}`,
            },
            { k: t("agents.form.visibilityLabel"), v: t(`agents.scope.${agent.visibility}`) },
          ]}
        />
      </FormSection>
    </FormPage>
  );
}

function EditAgent({
  orgId,
  agent,
  form: data,
  channels,
}: {
  orgId: string;
  agent: Agent;
  form: AgentFormData;
  channels: ChannelConnection[] | null;
}) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const router = useRouter();
  const { me } = useSession();
  const [reassigning, setReassigning] = useState(false);
  const [, startTransition] = useTransition();
  const admin = canUpdateOrg(me);
  const done = () => router.push("/agents");
  const form = useAgentForm(orgId, done, data, agent);
  const level = navLevelOf(me);
  const canViewRuns =
    level === "admin" || (level === "member" && agent.ownerAccountId === me.account.id);
  return (
    <FormPage
      header={{
        path: [
          ...scope,
          { label: "agents", href: "/agents" },
          { label: agent.definition.name || t("agents.form.editTitle") },
        ],
        title: agent.definition.name || t("agents.form.editTitle"),
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
          onDone={() => startTransition(() => router.refresh())}
        />
      ) : null}
    </FormPage>
  );
}
