"use client";

import {
  Callout,
  Field,
  FormPage,
  FormSection,
  Input,
  RadioGroup,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { platformOwned } from "../../../../components/AdminComponents";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { builtinChoice, type ThemeChoice, ThemePicker } from "../../../../components/ThemePicker";
import { UiArrangementSection } from "../../../../components/UiArrangementSection";
import {
  type CustomPolicy,
  type DeploymentSettings,
  type DeploymentSettingsPatch,
  isCurrencyCode,
  updateDeploymentSettings,
} from "../../../../lib/admin";
import { ApiClientError } from "../../../../lib/api";
import { componentName, type PlatformComponent } from "../../../../lib/components";
import { deploymentSettingsQuery, settingsChangeKeys } from "../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../lib/query/client";
import { adminComponentsQuery } from "../../../../lib/query/components";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { invalidatePlatformTheme } from "../../../../lib/query/themes";
import { useAdmin } from "../../../../lib/query/workspace";
import { useSecureCookiesBlocked } from "../../../../lib/secure-origin";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/admin/settings`：部署设置（超级管理员，SettingsPage）——谁能建组织、价格币种、
 * 组织能否自建连接器 / 技能（`deny` 时只能从平台目录安装）, and 外观: the platform default theme
 * (themes spec §7, §10), 内置主题 or a platform-owned theme whose scope is `all` and that is not
 * disabled; the kernel refuses one off in some org with the orgs (shown). 按组织的限额在「组织」页；
 * 组织自己的设置仍在 `/settings/*`。有改动时出现 ActionRow，只提交改过的项。
 * From the query cache (the layout prefetched it on a first load); a save writes the answered
 * settings into the cache.
 */
type Simple = Pick<
  DeploymentSettings,
  "orgCreation" | "priceCurrency" | "customConnectors" | "customSkills"
>;

const POLICIES = ["allow", "deny"] as const;

export default function AdminSettingsView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminSettingsRead />;
}

/** The picker's value for 内置主题 (never a theme id). */
const BUILTIN = "builtin";

/**
 * Whether a theme may be the platform default (themes spec §7): platform-owned, effective scope
 * `all`, not disabled and its plugin running. The kernel also needs it on in every org.
 */
const defaultEligible = (c: PlatformComponent): boolean =>
  platformOwned(c) && c.scope === "all" && !c.disabled && !c.pluginStopped;

/** A card radio group of two options (each section but the currency's). */
const RADIOS = [{ control: "radio-cards" as const, options: 2 }];

function AdminSettingsRead() {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.settings");
  const tc = useTranslations("common");
  const read = usePageQuery(deploymentSettingsQuery());
  const ta = useTranslations("appearance.platform");
  const header = { path: [...scope, { label: "settings" }], title: t("title") };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    const section = (id: string, key: string, fields: typeof RADIOS | [{ help: true }]) => (
      <FormSection
        id={id}
        title={t(`${key}.title`)}
        description={t(`${key}.description`)}
        loading={{ fields }}
      />
    );
    return (
      <FormPage
        header={header}
        loading
        actionRow={{
          cancel: { label: tc("cancel"), onSelect: () => {} },
          primary: { label: t("save"), onSelect: () => {} },
        }}
      >
        {section("org-creation", "orgCreation", RADIOS)}
        {section("currency", "currency", [{ help: true }])}
        {section("customConnectors", "customConnectors", RADIOS)}
        {section("customSkills", "customSkills", RADIOS)}
        <FormSection
          id="appearance"
          title={ta("title")}
          description={ta("description")}
          loading={{ fields: [{ control: "radio-cards", options: 3 }] }}
        />
      </FormPage>
    );
  }
  return <AdminSettings header={header} saved={read.data} />;
}

function AdminSettings({
  header,
  saved,
}: {
  header: { path: { label: string; href?: string }[]; title: string };
  saved: DeploymentSettings;
}) {
  const t = useTranslations("admin.settings");
  const ta = useTranslations("appearance");
  const locale = useLocale();
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  // The answer is the settings as they are now: it replaces the cached ones.
  const update = useAppMutation({
    fn: async (patch: DeploymentSettingsPatch) => {
      const r = await updateDeploymentSettings(patch);
      // the platform default: every org's resolved theme falls back to it
      if (patch.uiTheme !== undefined) await invalidatePlatformTheme(qc);
      return r;
    },
    invalidates: (patch) => settingsChangeKeys(patch),
    onSuccess: (r) => qc.setQueryData(deploymentSettingsQuery().queryKey, r),
  });
  const [draft, setDraft] = useState<Partial<Simple>>({});
  const [themeDraft, setThemeDraft] = useState<string | null | undefined>(undefined);
  const cq = adminComponentsQuery("theme");
  const eligible = (
    useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) }).data?.components ?? []
  ).filter(defaultEligible);
  const savedTheme = saved.uiTheme?.id ?? null;
  const uiTheme = themeDraft !== undefined ? themeDraft : savedTheme;
  const themeChoices: ThemeChoice[] = [
    builtinChoice(BUILTIN, ta("builtin")),
    ...eligible.map((c) =>
      c.theme === undefined
        ? builtinChoice(c.id, c.name)
        : { value: c.id, name: componentName(c, locale), swatches: c.theme.swatches },
    ),
  ];
  const [pending, setPending] = useState(false);
  const httpBlocked = useSecureCookiesBlocked();

  const value = <K extends keyof Simple>(k: K): Simple[K] | undefined => draft[k] ?? saved[k];
  const currency = value("priceCurrency") ?? "";
  const currencyValid = isCurrencyCode(currency);
  const patch: DeploymentSettingsPatch = {};
  for (const k of ["orgCreation", "priceCurrency", "customConnectors", "customSkills"] as const) {
    const v = draft[k];
    if (v !== undefined && v !== saved[k]) Object.assign(patch, { [k]: v });
  }
  if (uiTheme !== savedTheme) patch.uiTheme = { id: uiTheme };
  const unsaved = Object.keys(patch).length;

  async function save() {
    setPending(true);
    try {
      await update.mutateAsync(patch);
      setDraft({});
      setThemeDraft(undefined);
      toast.success(t("saved"));
    } catch (e) {
      const off = offOrgs(e);
      toast.error(
        off.length > 0
          ? ta("platform.notAvailable", { orgs: off.join(locale === "zh" ? "、" : ", ") })
          : errorMessage(e),
      );
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
      header={header}
      actionRow={{
        unsaved,
        ...(currencyValid ? {} : { errors: 1 }),
        cancel: {
          label: tc("cancel"),
          onSelect: () => {
            setDraft({});
            setThemeDraft(undefined);
          },
        },
        primary: {
          label: t("save"),
          onSelect: () => void save(),
          loading: pending,
          disabled: !currencyValid || unsaved === 0,
        },
      }}
    >
      {httpBlocked && <Callout tone="warn">{t("insecureOrigin")}</Callout>}
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
          options={(["anyone", "super_admin"] as const).map((v) => ({
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
      <FormSection
        id="appearance"
        title={ta("platform.title")}
        description={ta("platform.description")}
      >
        <ThemePicker
          label={ta("platform.label")}
          value={uiTheme ?? BUILTIN}
          choices={themeChoices}
          onChange={(v) => setThemeDraft(v === BUILTIN ? null : v)}
        />
      </FormSection>
      <UiArrangementSection scope={{ kind: "platform" }} canEdit />
    </FormPage>
  );
}

/** The orgs a `theme.not_available` refusal names (the theme is off there), by name. */
function offOrgs(e: unknown): string[] {
  if (!(e instanceof ApiClientError) || e.code !== "theme.not_available") return [];
  const d = e.rawDetails[0] as { orgs?: { orgName: string }[] } | undefined;
  return (d?.orgs ?? []).map((o) => o.orgName);
}
