"use client";

import { FormSection, KeyValue } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { modelLabel } from "../../lib/extension-label";
import { AgentSectionFrame, useAgentPage } from "./frame";

/**
 * The Model section for someone who may not change the agent (B3): the model and the fallback,
 * read-only. Without the providers list (they read only the agent) the provider id stands in.
 */
export function ModelReadOnly() {
  const t = useTranslations("agents");
  const { agent } = useAgentPage();
  const d = agent.definition;
  return (
    <AgentSectionFrame>
      <FormSection id="model" title={t("page.sections.model")}>
        <KeyValue
          rows={[
            {
              k: t("form.modelLabel"),
              v: modelLabel({ name: d.model.provider }, d.model.model, "en"),
            },
            {
              k: t("form.fallbackLabel"),
              v: !d.fallback
                ? t("form.fallbackNone")
                : modelLabel({ name: d.fallback.provider }, d.fallback.model, "en"),
            },
          ]}
        />
      </FormSection>
    </AgentSectionFrame>
  );
}
