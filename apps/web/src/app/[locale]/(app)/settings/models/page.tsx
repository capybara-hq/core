"use client";

import { FormSection, SettingsPage, Skeleton, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { PurposeEditor } from "../../../../../components/PurposeEditor";
import { useSettingsNav } from "../../../../../components/settings-nav";
import { listModels } from "../../../../../lib/agents";
import { ApiClientError } from "../../../../../lib/api";
import {
  EVAL_PURPOSE,
  listOrgPurposes,
  type PurposeView,
  putOrgPurpose,
} from "../../../../../lib/models";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/settings/models`：模型用途（组织管理员，SettingsPage）。每个用途显示企业管理员设的部署默认，
 * 组织可以覆盖（选模型与参数）或恢复默认；`eval` 没有生效的映射时提示评测不能开评委（评测向导链到这里）。
 */
export default function OrgModelsPage() {
  return <OrgGate>{(orgId) => <OrgModels key={orgId} orgId={orgId} />}</OrgGate>;
}

function OrgModels({ orgId }: { orgId: string }) {
  const t = useTranslations("models");
  const nav = useSettingsNav();
  const errorMessage = useErrorMessage();
  const { state, set } = useLoad(async () => {
    const [{ purposes }, { providers }] = await Promise.all([
      listOrgPurposes(orgId),
      listModels(orgId),
    ]);
    return { purposes, providers };
  }, [orgId]);

  let body: React.ReactNode;
  if (state.kind === "loading") body = <Skeleton rows={6} />;
  else if (state.kind === "error")
    body = <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />;
  else {
    const data = state.data;
    const evalView = data.purposes.find((p) => p.purpose === EVAL_PURPOSE);
    const replace = (v: PurposeView) =>
      set({ ...data, purposes: data.purposes.map((p) => (p.purpose === v.purpose ? v : p)) });
    body = (
      <FormSection id="purposes" title={t("org.title")} description={t("org.description")}>
        {evalView !== undefined && evalView.effective === null ? (
          <Text tone="warn">{t("evalUnmapped")}</Text>
        ) : null}
        {data.purposes.map((v) => (
          <PurposeEditor
            key={v.purpose}
            view={v}
            providers={data.providers}
            scope="org"
            save={(target) => putOrgPurpose(orgId, v.purpose, target).then((r) => r.purpose)}
            onSaved={replace}
          />
        ))}
      </FormSection>
    );
  }

  return (
    <SettingsPage header={{ title: t("org.title") }} nav={nav} activeNav="models">
      {body}
    </SettingsPage>
  );
}
