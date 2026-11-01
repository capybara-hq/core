"use client";

import { Field, FormPage, FormSection, Input, RadioGroup, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { usePagePath } from "../../../../components/shell/path";
import {
  type CustomPolicy,
  type DeploymentSettings,
  type DeploymentSettingsPatch,
  isCurrencyCode,
  updateDeploymentSettings,
} from "../../../../lib/admin";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useServerState } from "../../../../lib/use-server-state";

/**
 * `/admin/settings`：部署设置（企业管理员，SettingsPage）——谁能建组织、价格币种、
 * 组织能否自建连接器 / 技能（`deny` 时只能从企业目录安装）。按组织的限额在「组织」页；
 * 组织自己的设置仍在 `/settings/*`。有改动时出现 ActionRow，只提交改过的项。
 */
type Simple = Pick<
  DeploymentSettings,
  "orgCreation" | "priceCurrency" | "customConnectors" | "customSkills"
>;

const POLICIES = ["allow", "deny"] as const;

export default function AdminSettings({ initial }: { initial: DeploymentSettings }) {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.settings");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [saved, set] = useServerState(initial);
  const [draft, setDraft] = useState<Partial<Simple>>({});
  const [pending, setPending] = useState(false);

  const value = <K extends keyof Simple>(k: K): Simple[K] | undefined => draft[k] ?? saved[k];
  const currency = value("priceCurrency") ?? "";
  const currencyValid = isCurrencyCode(currency);
  const patch: DeploymentSettingsPatch = {};
  for (const k of ["orgCreation", "priceCurrency", "customConnectors", "customSkills"] as const) {
    const v = draft[k];
    if (v !== undefined && v !== saved[k]) Object.assign(patch, { [k]: v });
  }
  const unsaved = Object.keys(patch).length;

  async function save() {
    setPending(true);
    try {
      set(await updateDeploymentSettings(patch));
      setDraft({});
      toast.success(t("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  const policy = (key: "customConnectors" | "customSkills") => (
    <FormSection id={key} title={t(`${key}.title`)} description={t(`${key}.description`)}>
      <RadioGroup
        label={t(`${key}.title`)}
        variant="card"
        value={value(key) ?? "allow"}
        onChange={(v) => setDraft((d) => ({ ...d, [key]: v as CustomPolicy }))}
        options={POLICIES.map((p) => ({
          value: p,
          label: t(p),
          description: t(`${key}.${p}Hint`),
        }))}
      />
    </FormSection>
  );

  return (
    <FormPage
      header={{ path: [...scope, { label: "settings" }], title: t("title") }}
      actionRow={{
        unsaved,
        ...(currencyValid ? {} : { errors: 1 }),
        cancel: { label: tc("cancel"), onSelect: () => setDraft({}) },
        primary: {
          label: t("save"),
          onSelect: () => void save(),
          loading: pending,
          disabled: !currencyValid || unsaved === 0,
        },
      }}
    >
      <FormSection
        id="org-creation"
        title={t("orgCreation.title")}
        description={t("orgCreation.description")}
      >
        <RadioGroup
          label={t("orgCreation.title")}
          variant="card"
          value={value("orgCreation") ?? "anyone"}
          onChange={(v) => setDraft((d) => ({ ...d, orgCreation: v as Simple["orgCreation"] }))}
          options={(["anyone", "enterprise_admin"] as const).map((v) => ({
            value: v,
            label: t(`orgCreation.${v}`),
            description: t(`orgCreation.${v}Hint`),
          }))}
        />
      </FormSection>
      <FormSection
        id="currency"
        title={t("currency.title")}
        description={t("currency.description")}
      >
        <Field
          label={t("currency.label")}
          help={t("currency.help")}
          {...(currencyValid ? {} : { error: t("currency.invalid") })}
        >
          <Input
            value={currency}
            maxLength={3}
            onChange={(e) =>
              setDraft((d) => ({ ...d, priceCurrency: e.target.value.toUpperCase() }))
            }
          />
        </Field>
      </FormSection>
      {policy("customConnectors")}
      {policy("customSkills")}
    </FormPage>
  );
}
