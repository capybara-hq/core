"use client";

import { FormSection, SettingsPage, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { usePurposeDrafts } from "../../../../components/PurposeEditor";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import type { ProviderModels } from "../../../../lib/agents";
import { EVAL_PURPOSE, type PurposeView, putOrgPurpose } from "../../../../lib/models";
import { useServerState } from "../../../../lib/use-server-state";

/**
 * `/settings/models`：模型用途（组织管理员，SettingsPage）。每个用途显示企业管理员设的部署默认，
 * 组织可以覆盖（选模型与参数）或恢复默认；`eval` 没有生效的映射时提示评测不能开评委（评测向导链到这里）。
 */
export interface ModelsData {
  purposes: PurposeView[];
  providers: ProviderModels[];
}

/** Read on the server (`page.tsx`): the org's purposes and the models they can map to. */
export default function OrgModels({ orgId, initial }: { orgId: string; initial: ModelsData }) {
  const scope = usePagePath("org");
  const t = useTranslations("models");
  const nav = useOrgSettingsNav();
  const [data, set] = useServerState(initial);
  const evalView = data.purposes.find((p) => p.purpose === EVAL_PURPOSE);
  // A functional update: the ActionRow saves several purposes at once
  const replace = (v: PurposeView) =>
    set((d) => ({ ...d, purposes: d.purposes.map((p) => (p.purpose === v.purpose ? v : p)) }));
  const { editor, actionRow } = usePurposeDrafts({
    purposes: data.purposes,
    providers: data.providers,
    scope: "org",
    save: (purpose, target) => putOrgPurpose(orgId, purpose, target).then((r) => r.purpose),
    onSaved: replace,
  });
  const body = (
    <FormSection id="purposes" title={t("org.title")} description={t("org.description")}>
      {evalView !== undefined && evalView.effective === null ? (
        <Text tone="warn">{t("evalUnmapped")}</Text>
      ) : null}
      {data.purposes.map(editor)}
    </FormSection>
  );

  return (
    <SettingsPage
      header={{
        path: [
          ...scope,
          { label: "settings", href: "/settings/organization" },
          { label: "models" },
        ],
        title: t("org.title"),
      }}
      nav={nav}
      activeNav="models"
      {...(actionRow !== undefined ? { actionRow } : {})}
    >
      {body}
    </SettingsPage>
  );
}
