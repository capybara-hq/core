"use client";

import { FormPage, type PageHeaderProps } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import {
  type AgentFormData,
  AgentFormLoading,
  useAgentForm,
  useAgentFormData,
} from "../../../../components/AgentForm";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useSetup } from "../../../../components/shell/setup";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";
import { useWorkspace } from "../../../../lib/query/workspace";

/**
 * `/agents/new`: create an agent (FormPage), then back to the list. Inside the setup layout
 * (web-order spec §3.8) the new agent may make the org ready, so the page lands on a new
 * conversation with that agent (the save invalidates readiness). The form's lists come from the
 * query cache (the layout prefetched them on a first load).
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
  // In the setup layout the new agent may make the org ready: go to a new conversation with it.
  const done = (agent?: Agent) =>
    router.push(
      setup.active && agent !== undefined
        ? `/chat?agent=${encodeURIComponent(agent.id)}`
        : "/agents",
    );
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
  done(agent?: Agent): void;
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
        ...(form.saved ? {} : { cancel: { label: t("common.cancel"), onSelect: () => done() } }),
        primary: form.saved
          ? { label: t("agents.form.continue"), onSelect: () => done(form.savedAgent) }
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
