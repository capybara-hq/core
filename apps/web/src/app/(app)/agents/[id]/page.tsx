"use client";

import { FormPage, FormSection, KeyValue, Skeleton, Text } from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AgentChannels } from "../../../../components/AgentChannels";
import { useAgentForm } from "../../../../components/AgentForm";
import { FormError } from "../../../../components/form-error";
import { OrgGate } from "../../../../components/OrgGate";
import { ReassignOwnerDialog } from "../../../../components/ReassignOwnerDialog";
import { navLevelOf } from "../../../../components/shell/nav";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import { useRouter } from "../../../../i18n/navigation";
import { type Agent, getAgent } from "../../../../lib/agents";
import { ApiClientError } from "../../../../lib/api";
import { canUpdateOrg } from "../../../../lib/org-settings";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/agents/[id]`：修改 agent（FormPage）：与新建同一套分组，按当前定义预填；技能分组里另有
 * agent 自己写的技能（只读，负责人可删）。保存后回到列表。组织管理员与负责人在页头有「运行记录」入口
 * （轨迹查看器，按该 agent 筛选；能否查看最终由内核判定）。
 */
export default function EditAgentPage() {
  const { id } = useParams<{ id: string }>();
  return <OrgGate>{(orgId) => <AgentInOrg orgId={orgId} id={id} />}</OrgGate>;
}

/** agent 属于打开它时的组织：切换组织后不再以新组织 + 旧 agent id 渲染。 */
function AgentInOrg({ orgId, id }: { orgId: string; id: string }) {
  const [openedIn] = useState(orgId);
  if (orgId !== openedIn) return null;
  return <LoadAgent orgId={orgId} id={id} />;
}

function LoadAgent({ orgId, id }: { orgId: string; id: string }) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const { state, reload } = useLoad(() => getAgent(orgId, id).then((r) => r.agent), [orgId, id]);
  const back = () => router.push("/agents");
  if (state.kind === "ready") {
    // The kernel lets the owner (members up) or an org admin change the agent; others read it (R3)
    const canEdit =
      navLevelOf(me) !== "guest" &&
      (state.data.ownerAccountId === me.account.id || canUpdateOrg(me));
    if (!canEdit) return <ViewAgent agent={state.data} />;
    return (
      <EditAgent key={state.data.updatedAt} orgId={orgId} agent={state.data} onChanged={reload} />
    );
  }
  return (
    <FormPage
      header={{
        path: [
          ...scope,
          { label: "agents", href: "/agents" },
          { label: t("agents.form.editTitle") },
        ],
        title: t("agents.form.editTitle"),
      }}
      actionRow={{
        cancel: { label: t("common.cancel"), onSelect: back },
        primary: { label: t("agents.form.submit"), onSelect: () => {}, disabled: true },
      }}
    >
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : (
        <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />
      )}
    </FormPage>
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
  onChanged,
}: {
  orgId: string;
  agent: Agent;
  onChanged(): void;
}) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const router = useRouter();
  const { me } = useSession();
  const [reassigning, setReassigning] = useState(false);
  const admin = canUpdateOrg(me);
  const done = () => router.push("/agents");
  const form = useAgentForm(orgId, done, agent);
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
      <AgentChannels orgId={orgId} agentId={agent.id} />
      {reassigning ? (
        <ReassignOwnerDialog
          orgId={orgId}
          agentId={agent.id}
          ownerAccountId={agent.ownerAccountId}
          needsReassignment={agent.needsReassignment === true}
          onClose={() => setReassigning(false)}
          onDone={onChanged}
        />
      ) : null}
    </FormPage>
  );
}
