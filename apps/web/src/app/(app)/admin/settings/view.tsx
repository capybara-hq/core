"use client";

import {
  Button,
  Callout,
  Field,
  FormPage,
  FormSection,
  Input,
  ItemList,
  ItemListItem,
  RadioGroup,
  Stack,
  Switch,
  SwitchField,
  Text,
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
import {
  UiPlacementSection,
  UiReplacementsSection,
} from "../../../../components/UiArrangementSection";
import {
  ATTRIBUTION_DEFAULTS,
  ATTRIBUTION_FIELDS,
  type AttributionField,
  type AttributionPatch,
  CLIENT_EXTENSIONS_DEFAULT,
  type ClientExtensionsSetting,
  type CustomPolicy,
  type DeploymentSettings,
  type DeploymentSettingsPatch,
  isCurrencyCode,
  type PlatformAttributionView,
  updateDeploymentSettings,
} from "../../../../lib/admin";
import { componentName, type PlatformComponent } from "../../../../lib/components";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import type { DevicesAutoModeSource, DevicesAutoModeView } from "../../../../lib/org-settings";
import {
  adminExtensionsQuery,
  deploymentSettingsQuery,
  invalidateAttribution,
  invalidateDeviceModes,
  settingsChangeKeys,
} from "../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../lib/query/client";
import { invalidateClientSets } from "../../../../lib/query/client-extensions";
import { adminComponentsQuery } from "../../../../lib/query/components";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { invalidatePlatformTheme } from "../../../../lib/query/themes";
import { useAdmin } from "../../../../lib/query/workspace";
import { useSecureCookiesBlocked } from "../../../../lib/secure-origin";
import { themeOffOrgs } from "../../../../lib/themes";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/admin/settings`：部署设置（超级管理员，SettingsPage）——谁能建组织、价格币种、
 * 组织能否自建连接器 / 技能（`deny` 时只能从平台目录安装）, and 外观: the platform default theme
 * (themes spec §7, §10), 内置主题 or a platform-owned theme whose scope is `all` and that is not
 * disabled; the kernel refuses one off in some org with the orgs (shown). 插件界面代码: the client
 * code kill switch and the plugins whose client code alone is stopped (client extensions spec
 * §10.2); a save that changes it marks every cached client set stale. 自动模式: the platform's
 * auto-mode switch (auto mode spec §4.3), read with where it comes from; a value set in the startup
 * config is shown read-only with its source. 按组织的限额在「组织」页；
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
  const tk = useTranslations("admin.settings.clientCode");
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
          id="auto-mode"
          title={t("autoMode.title")}
          description={t("autoMode.description")}
          loading={{ fields: [{ control: "radio-cards", options: 2 }, { control: "text" }] }}
        />
        <FormSection
          id="appearance"
          title={ta("title")}
          description={ta("description")}
          loading={{ fields: [{ control: "radio-cards", options: 3 }] }}
        />
        <FormSection
          id="client-code"
          flush
          title={tk("title")}
          description={tk("description")}
          loading={{ items: [{ lines: 1, buttons: 1 }] }}
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
      // the kill switch: open pages drop (or pick up) client code at their next shell read
      if (patch.clientExtensions !== undefined) await invalidateClientSets(qc);
      // the platform's auto-mode switch decides every org's and device's mode
      if (patch.devicesAutoMode !== undefined) await invalidateDeviceModes(qc);
      // the attribution defaults ride on every org's settings (the agent page's help text)
      if (patch.attribution !== undefined) await invalidateAttribution(qc);
      return r;
    },
    invalidates: (patch) => settingsChangeKeys(patch),
    onSuccess: (r) => qc.setQueryData(deploymentSettingsQuery().queryKey, r),
  });
  const [draft, setDraft] = useState<Partial<Simple>>({});
  const [themeDraft, setThemeDraft] = useState<string | null | undefined>(undefined);
  const [clientDraft, setClientDraft] = useState<ClientExtensionsSetting | undefined>(undefined);
  const [attributionDraft, setAttributionDraft] = useState<AttributionDraft>({});
  const [autoDraft, setAutoDraft] = useState<"allowed" | "off" | undefined>(undefined);
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
  const savedClient = saved.clientExtensions ?? CLIENT_EXTENSIONS_DEFAULT;
  const client = clientDraft ?? savedClient;
  const clientPatch = clientChange(savedClient, client);
  if (clientPatch !== null) patch.clientExtensions = clientPatch;
  const attribution =
    saved.attribution === undefined ? null : attributionOf(saved.attribution, attributionDraft);
  if (attribution !== null && attribution.patch !== null) patch.attribution = attribution.patch;
  const autoMode = saved.devicesAutoMode;
  if (
    autoMode !== undefined &&
    !autoLocked(autoMode.source) &&
    autoDraft !== undefined &&
    autoDraft !== autoMode.mode
  ) {
    patch.devicesAutoMode = { mode: autoDraft };
  }
  const unsaved = Object.keys(patch).length;

  async function save() {
    setPending(true);
    try {
      await update.mutateAsync(patch);
      setDraft({});
      setThemeDraft(undefined);
      setClientDraft(undefined);
      setAttributionDraft({});
      setAutoDraft(undefined);
      toast.success(t("saved"));
    } catch (e) {
      const off = themeOffOrgs(e);
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
            setClientDraft(undefined);
            setAttributionDraft({});
            setAutoDraft(undefined);
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
      {saved.devicesAutoMode !== undefined && (
        <AutoModeSection value={saved.devicesAutoMode} draft={autoDraft} onChange={setAutoDraft} />
      )}
      {saved.attribution !== undefined && attribution !== null && (
        <AttributionSection
          saved={saved.attribution}
          value={attribution.value}
          onChange={(d) => setAttributionDraft((cur) => ({ ...cur, ...d }))}
        />
      )}
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
      <ClientCodeSection value={client} onChange={setClientDraft} />
      <UiReplacementsSection scope={{ kind: "platform" }} canEdit />
      <UiPlacementSection scope={{ kind: "platform" }} canEdit />
    </FormPage>
  );
}

/** The kill switch patch: only the fields that differ from the saved setting, or null. */
function clientChange(
  saved: ClientExtensionsSetting,
  next: ClientExtensionsSetting,
): Partial<ClientExtensionsSetting> | null {
  const sorted = (l: string[]) => [...new Set(l)].sort();
  const disabledChanged = sorted(saved.disabled).join("\n") !== sorted(next.disabled).join("\n");
  const change: Partial<ClientExtensionsSetting> = {
    ...(next.enabled !== saved.enabled && { enabled: next.enabled }),
    ...(disabledChanged && { disabled: sorted(next.disabled) }),
  };
  return Object.keys(change).length > 0 ? change : null;
}

/**
 * 插件界面代码 (client extensions spec §10.2): one switch for all client code, then one per plugin
 * with client code (the deployment's extensions with a client build, and any plugin still listed as
 * stopped); a plugin's switch off stops its client code alone, its server side keeps running. With
 * the switch for all off, no plugin row says it runs. Saved with the page's ActionRow.
 */
function ClientCodeSection({
  value,
  onChange,
}: {
  value: ClientExtensionsSetting;
  onChange(v: ClientExtensionsSetting): void;
}) {
  const t = useTranslations("admin.settings.clientCode");
  const lang = labelLocale(useLocale());
  const eq = adminExtensionsQuery();
  const extensions =
    useQuery({ ...eq, retryOnMount: retryOnMountOf(eq.queryKey) }).data?.extensions ?? [];
  const withClient = extensions.filter((e) => e.client != null);
  const plugins = [
    ...withClient.map((e) => ({ name: e.name, label: extensionLabel(e, lang) })),
    ...value.disabled
      .filter((n) => !withClient.some((e) => e.name === n))
      .map((n) => ({ name: n, label: n })),
  ];
  return (
    <FormSection id="client-code" flush title={t("title")} description={t("description")}>
      <ItemList label={t("title")} inset="flush">
        <ItemListItem
          title={t("all")}
          meta={t(value.enabled ? "allOnHint" : "allOffHint")}
          actions={
            <Switch
              label={t("all")}
              checked={value.enabled}
              onChange={(on) => onChange({ ...value, enabled: on })}
            />
          }
        />
        {plugins.map((p) => {
          const on = !value.disabled.includes(p.name);
          return (
            <ItemListItem
              key={p.name}
              title={p.label}
              {...(p.label !== p.name && { code: p.name })}
              // the kill switch off stops every plugin's code, whatever its own switch says
              meta={t(!on ? "pluginOffHint" : value.enabled ? "pluginOnHint" : "pluginAllOffHint")}
              actions={
                <Switch
                  label={t("pluginLabel", { name: p.label })}
                  checked={on}
                  onChange={(next) =>
                    onChange({
                      ...value,
                      disabled: next
                        ? value.disabled.filter((n) => n !== p.name)
                        : [...value.disabled, p.name],
                    })
                  }
                />
              }
            />
          );
        })}
      </ItemList>
    </FormSection>
  );
}

/** Whether a startup config source makes the platform's auto-mode switch read-only here. */
const autoLocked = (source: DevicesAutoModeSource | undefined): boolean =>
  source === "env" || source === "file" || source === "nacos";

/** The startup config's source of a field (read-only here), or null when it can be changed. */
const lockedSource = (s: string): "env" | "file" | "nacos" | null =>
  s === "env" || s === "file" || s === "nacos" ? s : null;

/** The attribution section's edits over the saved values. */
type AttributionDraft = Partial<Pick<PlatformAttributionView, AttributionField>>;

/**
 * The values the attribution section shows (the draft over the saved ones) and the patch: the
 * changed fields only, never one set in the startup config. A locked field always shows its
 * read-only (startup config) value, whatever a draft edit tried to put there.
 */
function attributionOf(
  saved: PlatformAttributionView,
  draft: AttributionDraft,
): { value: Omit<PlatformAttributionView, "sources">; patch: AttributionPatch | null } {
  const shown = <F extends AttributionField>(f: F): PlatformAttributionView[F] =>
    lockedSource(saved.sources[f]) === null ? (draft[f] ?? saved[f]) : saved[f];
  const value = {
    commit: shown("commit"),
    pr: shown("pr"),
    sessionUrl: shown("sessionUrl"),
  };
  const patch: AttributionPatch = {};
  for (const f of ATTRIBUTION_FIELDS) {
    if (value[f] !== saved[f] && lockedSource(saved.sources[f]) === null) {
      Object.assign(patch, { [f]: value[f] });
    }
  }
  return { value, patch: Object.keys(patch).length > 0 ? patch : null };
}

/**
 * 自动模式 (auto mode spec §4.3): one control, allowed or off, with where the value comes from. A
 * value set in the startup config is disabled with its source. Off forces local devices to sandbox
 * mode; cloud devices keep the container and follow the organization's cloud network. The kernel
 * refuses a raise through an API token or the Platform tool, which may only turn it off; a signed-in
 * super admin here may set it either way. Saved with the page's ActionRow.
 */
function AutoModeSection({
  value,
  draft,
  onChange,
}: {
  value: DevicesAutoModeView;
  draft: "allowed" | "off" | undefined;
  onChange(mode: "allowed" | "off"): void;
}) {
  const t = useTranslations("admin.settings.autoMode");
  const tf = useTranslations("configForm");
  const locked = autoLocked(value.source);
  const mode = draft ?? value.mode;
  return (
    <FormSection id="auto-mode" title={t("title")} description={t("description")}>
      <Stack gap={8}>
        <RadioGroup
          label={t("label")}
          variant="card"
          value={mode}
          disabled={locked}
          onChange={(v) => onChange(v as "allowed" | "off")}
          options={(["allowed", "off"] as const).map((v) => ({
            value: v,
            label: t(v),
            description: t(`${v}Hint`),
          }))}
        />
        <Text variant="small" tone="muted">
          {locked
            ? `${tf("readonly", { source: value.source })} · devices.autoMode`
            : t("source", { source: t(`sources.${value.source}`) })}
        </Text>
      </Stack>
    </FormSection>
  );
}

/**
 * 提交与 PR 署名 (spec 2026-11-14-agent-attribution): the trailer ending an agent-created commit
 * message, the line ending an agent-created pull-request body, and whether a pull request also
 * carries the conversation link (needs `http.publicUrl`, off by default). A field the startup
 * config sets is read-only with its source. The preview shows what a commit and a pull request end
 * with. 恢复默认 puts the built-in values back into the draft; the page's ActionRow saves it.
 */
function AttributionSection({
  saved,
  value,
  onChange,
}: {
  saved: PlatformAttributionView;
  value: Omit<PlatformAttributionView, "sources">;
  onChange(d: AttributionDraft): void;
}) {
  const t = useTranslations("admin.settings.attribution");
  const tf = useTranslations("configForm");
  const locked = (f: AttributionField) => lockedSource(saved.sources[f]);
  const lockedNote = (f: AttributionField) => {
    const source = locked(f);
    return source === null ? null : `${tf("readonly", { source })} · attribution.${f}`;
  };
  const off = t("off");
  return (
    <FormSection id="attribution" title={t("title")} description={t("description")}>
      <Stack gap={12}>
        <Field label={t("commitLabel")} help={lockedNote("commit") ?? t("commitHelp")}>
          <Input
            value={value.commit}
            maxLength={500}
            disabled={locked("commit") !== null}
            onChange={(e) => onChange({ commit: e.target.value })}
          />
        </Field>
        <Field label={t("prLabel")} help={lockedNote("pr") ?? t("prHelp")}>
          <Input
            value={value.pr}
            maxLength={500}
            disabled={locked("pr") !== null}
            onChange={(e) => onChange({ pr: e.target.value })}
          />
        </Field>
        <Stack gap={4}>
          <SwitchField
            label={t("sessionUrlLabel")}
            checked={value.sessionUrl}
            disabled={locked("sessionUrl") !== null}
            onChange={(next) => onChange({ sessionUrl: next })}
          />
          <Text variant="small" tone="muted">
            {lockedNote("sessionUrl") ?? t("sessionUrlHelp")}
          </Text>
        </Stack>
        <Stack gap={4}>
          <Text variant="small" tone="muted">
            {t("previewTitle")}
          </Text>
          <Text variant="small" tone="muted">
            {t("previewCommit")}
          </Text>
          <Text pre>{value.commit === "" ? off : value.commit}</Text>
          <Text variant="small" tone="muted">
            {t("previewPr")}
          </Text>
          <Text pre>{value.pr === "" ? off : value.pr}</Text>
        </Stack>
        <div>
          <Button
            variant="ghost"
            onClick={() => {
              // only the fields this console may change: a field the startup config sets keeps its
              // read-only value (restoring it to the built-in default would show a value not in effect)
              const next: AttributionDraft = {};
              if (locked("commit") === null) next.commit = ATTRIBUTION_DEFAULTS.commit;
              if (locked("pr") === null) next.pr = ATTRIBUTION_DEFAULTS.pr;
              if (locked("sessionUrl") === null) next.sessionUrl = ATTRIBUTION_DEFAULTS.sessionUrl;
              onChange(next);
            }}
          >
            {t("restore")}
          </Button>
        </div>
      </Stack>
    </FormSection>
  );
}
