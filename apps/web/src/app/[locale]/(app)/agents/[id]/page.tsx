"use client";

import { FormPage, Skeleton } from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useAgentForm } from "../../../../../components/AgentForm";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { navLevelOf } from "../../../../../components/shell/nav";
import { useSession } from "../../../../../components/shell/session";
import { useRouter } from "../../../../../i18n/navigation";
import { type Agent, getAgent } from "../../../../../lib/agents";
import { ApiClientError } from "../../../../../lib/api";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/agents/[id]`：修改 agent（FormPage）：与新建同一套分组，按当前定义预填；技能分组里另有
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
  const t = useTranslations();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const { state } = useLoad(() => getAgent(orgId, id).then((r) => r.agent), [orgId, id]);
  const back = () => router.push("/agents");
  if (state.kind === "ready") {
    return <EditAgent key={state.data.updatedAt} orgId={orgId} agent={state.data} />;
  }
  return (
    <FormPage
      header={{
        breadcrumb: [{ label: t("agents.title"), href: "/agents" }],
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

function EditAgent({ orgId, agent }: { orgId: string; agent: Agent }) {
  const t = useTranslations();
  const router = useRouter();
  const { me } = useSession();
  const done = () => router.push("/agents");
  const form = useAgentForm(orgId, done, agent);
  const level = navLevelOf(me);
  const canViewRuns =
    level === "admin" || (level === "member" && agent.ownerAccountId === me.account.id);
  return (
    <FormPage
      header={{
        breadcrumb: [{ label: t("agents.title"), href: "/agents" }],
        title: agent.definition.name || t("agents.form.editTitle"),
        ...(canViewRuns && {
          actions: [
            {
              label: t("agents.runHistory"),
              variant: "default",
              href: `/trajectories?agentId=${encodeURIComponent(agent.id)}`,
            },
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
    </FormPage>
  );
}
