"use client";

import { FormPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useAgentForm } from "../../../../components/AgentForm";
import { OrgGate } from "../../../../components/OrgGate";
import { usePagePath } from "../../../../components/shell/path";
import { useSetup } from "../../../../components/shell/setup";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";

/**
 * `/agents/new`: create an agent (FormPage), then back to the list. Inside the setup layout
 * (web-order spec §3.8) the new agent may make the org ready: readiness is read again and the
 * page lands on a new conversation with that agent, in the shell.
 */
export default function NewAgentPage() {
  return <OrgGate>{(orgId) => <NewAgent orgId={orgId} />}</OrgGate>;
}

function NewAgent({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const router = useRouter();
  const setup = useSetup();
  const done = (agent?: Agent) => {
    if (setup.active && agent !== undefined) {
      void setup.recheck().then(() => router.push(`/chat?agent=${encodeURIComponent(agent.id)}`));
    } else router.push("/agents");
  };
  const form = useAgentForm(orgId, done);
  return (
    <FormPage
      header={{
        path: [...scope, { label: "agents", href: "/agents" }, { label: "new" }],
        title: t("agents.form.title"),
      }}
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
