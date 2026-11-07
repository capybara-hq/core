"use client";

import { FormPage, type PageHeaderProps } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import {
  type AgentCreated,
  AgentFormLoading,
  useAgentForm,
} from "../../../../components/AgentForm";
import { type AgentFormData, useAgentFormData } from "../../../../components/agent/form-data";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useSetup } from "../../../../components/shell/setup";
import { useRouter } from "../../../../i18n/navigation";
import { useWorkspace } from "../../../../lib/query/workspace";
import { newConversationPath } from "../../../../lib/routes";

/**
 * `/agents/new`: create an agent (FormPage: avatar, name, model, visibility), then land on its page
 * at the prompt (`/agents/<id>?s=prompt`), where the starter `AGENTS.md` waits to be edited. When
 * the picked avatar upload failed after the create, it lands on Basics with that error. Inside the
 * setup layout (web-order spec §3.8) the new agent may make the org ready, so the page lands on a
 * new conversation with it instead. The form's reads come from the query cache (the layout
 * prefetched them on a first load).
 */
export default function NewAgentView() {
  const ws = useWorkspace({ min: "member", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <NewAgent orgId={ws.orgId} />;
}

function NewAgent({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const router = useRouter();
  const setup = useSetup();
  const state = useAgentFormData(orgId);
  const done = (created?: AgentCreated) => {
    if (created === undefined) router.push("/agents");
    // In the setup layout the new agent may make the org ready: go to a new conversation with it.
    else if (setup.active) router.push(newConversationPath(created.agent.id));
    else {
      const id = encodeURIComponent(created.agent.id);
      router.push(
        created.uploadFailed ? `/agents/${id}?s=basics&avatar=failed` : `/agents/${id}?s=prompt`,
      );
    }
  };
  const header = {
    path: [...scope, { label: "agents", href: "/agents" }, { label: "new" }],
    title: t("agents.form.title"),
  };
  if (state.kind === "error") return <ErrorFrame reset={state.retry} />;
  if (state.kind === "loading") {
    return (
      <FormPage
        create
        loading
        header={header}
        actionRow={{
          cancel: { label: t("common.cancel"), onSelect: () => done() },
          primary: { label: t("agents.form.submit"), onSelect: () => {} },
        }}
      >
        <AgentFormLoading />
      </FormPage>
    );
  }
  return <NewAgentForm orgId={orgId} data={state.data} header={header} done={done} />;
}

function NewAgentForm({
  orgId,
  data,
  header,
  done,
}: {
  orgId: string;
  data: AgentFormData;
  header: PageHeaderProps;
  done(created?: AgentCreated): void;
}) {
  const t = useTranslations();
  const form = useAgentForm(orgId, done, data);
  return (
    <FormPage
      create
      header={header}
      actionRow={{
        unsaved: form.unsaved,
        errors: form.errors,
        cancel: { label: t("common.cancel"), onSelect: () => done() },
        primary: {
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
