"use client";

import { FormPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useAgentForm } from "../../../../components/AgentForm";
import { RoleGate } from "../../../../components/RoleGate";
import { usePagePath } from "../../../../components/shell/path";
import { useSetup } from "../../../../components/shell/setup";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";

/**
 * `/agents/new`: create an agent (FormPage), then back to the list. Inside the setup layout
 * (web-order spec §3.8) the new agent may make the org ready, so the page lands on a new
 * conversation with that agent and the frame reads readiness again.
 */
export default function NewAgentPage() {
  return <RoleGate min="member">{(orgId) => <NewAgent orgId={orgId} />}</RoleGate>;
}

function NewAgent({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const router = useRouter();
  const setup = useSetup();
  // In the setup layout the new agent may make the org ready: go to a new conversation with it;
  // the frame re-reads readiness on that navigation and flips to the shell there.
  const done = (agent?: Agent) =>
    router.push(
      setup.active && agent !== undefined
        ? `/chat?agent=${encodeURIComponent(agent.id)}`
        : "/agents",
    );
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
