"use client";

import { Button, OnboardingPage, type Step, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRouter } from "../../i18n/navigation";
import type { Agent, ProviderModels } from "../../lib/agents";
import { usePagePath } from "../shell/path";
import { useSession } from "../shell/session";

/** Whether a conversation can start: a model to answer and an agent to talk to. */
export function setupReady(agents: Agent[], providers: ProviderModels[]): boolean {
  return agents.length > 0 && providers.some((p) => p.models.length > 0);
}

/**
 * The one setup checklist (spec §3.6), shared by the overview and the new-conversation page: the
 * organization (always done), a model (an enterprise admin sets it up; everyone else is told to
 * ask) and an agent, each with its action.
 */
export function useSetupSteps(agents: Agent[], providers: ProviderModels[]): Step[] {
  const t = useTranslations("chat.setup");
  const th = useTranslations("home.setup");
  const { me } = useSession();
  const orgName = me.memberships.find((m) => m.orgId === me.currentOrgId)?.name ?? "";
  const router = useRouter();
  const hasModel = providers.some((p) => p.models.length > 0);
  const hasAgent = agents.length > 0;
  const admin = me.account.isEnterpriseAdmin;
  return [
    { label: th("org"), description: orgName, done: true },
    {
      label: t("model.label"),
      description: admin ? t("model.description") : t("model.askAdmin"),
      done: hasModel,
      ...(hasModel
        ? {}
        : {
            action: admin ? (
              <Button variant="primary" onClick={() => router.push("/admin/extensions")}>
                {t("model.action")}
              </Button>
            ) : (
              <Text variant="small" tone="muted">
                {t("model.waiting")}
              </Text>
            ),
          }),
    },
    {
      label: t("agent.label"),
      description: t("agent.description"),
      done: hasAgent,
      ...(hasAgent
        ? {}
        : {
            action: (
              <Button
                variant={hasModel ? "primary" : "default"}
                onClick={() => router.push("/agents/new")}
              >
                {t("agent.action")}
              </Button>
            ),
          }),
    },
  ];
}

/**
 * The new-conversation page before anything is set up: what is missing (a model, an agent) as a
 * checklist with the way to fix each, instead of a composer full of placeholders.
 */
export function SetupGuide({
  agents,
  providers,
}: {
  agents: Agent[];
  providers: ProviderModels[];
}) {
  const scope = usePagePath("org");
  const t = useTranslations("chat.setup");
  const steps = useSetupSteps(agents, providers);
  return (
    <OnboardingPage
      header={{ path: scope, title: t("title"), description: t("description") }}
      steps={steps}
    />
  );
}
