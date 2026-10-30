"use client";

import { Button, OnboardingPage, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRouter } from "../../i18n/navigation";
import type { Agent, ProviderModels } from "../../lib/agents";
import { useSession } from "../shell/session";

/** Whether a conversation can start: a model to answer and an agent to talk to. */
export function setupReady(agents: Agent[], providers: ProviderModels[]): boolean {
  return agents.length > 0 && providers.some((p) => p.models.length > 0);
}

/**
 * The new-conversation page before anything is set up: what is missing (a model, an agent) as a
 * checklist with the way to fix each, instead of a composer full of placeholders. Configuring a
 * model is an enterprise admin's job; everyone else is told to ask one.
 */
export function SetupGuide({
  agents,
  providers,
}: {
  agents: Agent[];
  providers: ProviderModels[];
}) {
  const t = useTranslations("chat.setup");
  const { me } = useSession();
  const router = useRouter();
  const hasModel = providers.some((p) => p.models.length > 0);
  const hasAgent = agents.length > 0;
  const admin = me.account.isEnterpriseAdmin;
  return (
    <OnboardingPage
      header={{ title: t("title"), description: t("description") }}
      steps={[
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
        {
          label: t("chat.label"),
          description: t("chat.description"),
          done: false,
        },
      ]}
    />
  );
}
