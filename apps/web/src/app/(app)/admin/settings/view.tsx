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
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { platformOwned } from "../../../../components/AdminComponents";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { CompactionSection } from "../../../../components/settings/CompactionSection";
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
  cdnOriginOf,
  type DeploymentSettings,
  type DeploymentSettingsPatch,
  isCdnOrigin,
  isCurrencyCode,
  type PlatformAttributionView,
  updateDeploymentSettings,
} from "../../../../lib/admin";
import {
  COMPACTION_DEFAULTS,
  type CompactionSettings,
  type CompactionSettingsPatch,
} from "../../../../lib/compaction";
import { componentName, type PlatformComponent } from "../../../../lib/components";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import {
  type DeviceNetworkMode,
  type DevicesNetworkView,
  type DevicesOutsideSandboxView,
  narrowerNetwork,
  lockedSource as startupLocked,
} from "../../../../lib/org-settings";
import {
  adminExtensionsQuery,
  deploymentSettingsQuery,
  invalidateAttribution,
  invalidateCompactionSettings,
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
 * §10.2); a save that changes it marks every cached client set stale. The device sandbox:
 * running outside the sandbox (`devicesOutsideSandbox`) and the device network's default and
 * ceiling (`devicesNetwork`), each read with where it comes from; a value set in the startup config
 * is shown read-only with its source. 按组织的限额在「组织」页；
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
  const tcp = useTranslations("compaction");
  const tps = useTranslations("promptSuggestions");
  const tsh = useTranslations("admin.settings.sharing");
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
          id="outside-sandbox"
          title={t("outsideSandbox.title")}
          description={t("outsideSandbox.description")}
          loading={{ fields: [{ control: "radio-cards", options: 2 }, { control: "text" }] }}
        />
        <FormSection
          id="device-network"
          title={t("deviceNetwork.title")}
          description={t("deviceNetwork.description")}
          loading={{
            fields: [
              { control: "radio-cards", options: 2 },
              { control: "radio-cards", options: 2 },
              { control: "text" },
            ],
          }}
        />
        <FormSection
          id="prompt-suggestions"
          title={tps("title")}
          description={tps("description")}
          loading={{ fields: [{ control: "switch" }] }}
        />
        <FormSection
          id="compaction"
          title={tcp("title")}
          description={tcp("description")}
          loading={{
            fields: [
              { control: "switch", help: true },
              { control: "input", help: true },
              { control: "input", help: true },
              { control: "input", help: true },
              { control: "input", help: true },
            ],
          }}
        />
        <FormSection
          id="sharing"
          title={tsh("title")}
          description={tsh("description")}
          loading={{
            fields: [
              { control: "switch", help: true },
              { control: "input", help: true },
              { control: "textarea", rows: 6, help: true },
            ],
          }}
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
  const tps = useTranslations("promptSuggestions");
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
      // the platform's device sandbox settings bound every org's and device's sandbox
      if (patch.devicesOutsideSandbox !== undefined || patch.devicesNetwork !== undefined)
        await invalidateDeviceModes(qc);
      // the attribution defaults ride on every org's settings (the agent page's help text)
      if (patch.attribution !== undefined) await invalidateAttribution(qc);
      // the platform's compaction defaults are what an org that follows the platform shows, and
      // the prompt suggestion switch locks the org's (both ride on every org's settings)
      if (patch.compaction !== undefined || patch.promptSuggestions !== undefined)
        await invalidateCompactionSettings(qc);
      return r;
    },
    invalidates: (patch) => settingsChangeKeys(patch),
    onSuccess: (r) => qc.setQueryData(deploymentSettingsQuery().queryKey, r),
  });
  const [draft, setDraft] = useState<Partial<Simple>>({});
  const [themeDraft, setThemeDraft] = useState<string | null | undefined>(undefined);
  const [clientDraft, setClientDraft] = useState<ClientExtensionsSetting | undefined>(undefined);
  const [attributionDraft, setAttributionDraft] = useState<AttributionDraft>({});
  const [outsideDraft, setOutsideDraft] = useState<"allowed" | "off" | undefined>(undefined);
  const [networkDraft, setNetworkDraft] = useState<
    Partial<Record<NetworkField, DeviceNetworkMode>>
  >({});
  const [compactionDraft, setCompactionDraft] = useState<CompactionSettingsPatch>({});
  const [suggestionsDraft, setSuggestionsDraft] = useState<"on" | "off" | undefined>(undefined);
  const [sharingDraft, setSharingDraft] = useState<SharingDraft>({});
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
  const outside = saved.devicesOutsideSandbox;
  if (
    outside !== undefined &&
    !startupLocked(outside.source) &&
    outsideDraft !== undefined &&
    outsideDraft !== outside.permission
  ) {
    patch.devicesOutsideSandbox = { permission: outsideDraft };
  }
  const network =
    saved.devicesNetwork === undefined ? null : networkOf(saved.devicesNetwork, networkDraft);
  if (network !== null && network.patch !== null) patch.devicesNetwork = network.patch;
  const savedCompaction = saved.compaction ?? COMPACTION_DEFAULTS;
  const compaction: CompactionSettings = { ...savedCompaction, ...compactionDraft };
  const compactionPatch = compactionChange(savedCompaction, compaction);
  if (compactionPatch !== null) patch.compaction = compactionPatch;
  const savedSuggestions = saved.promptSuggestions ?? "on";
  const promptSuggestions = suggestionsDraft ?? savedSuggestions;
  // "on" is the default: clear the key instead of storing it (spec §6)
  if (promptSuggestions !== savedSuggestions)
    patch.promptSuggestions = promptSuggestions === "on" ? null : "off";
  const sharing = sharingOf(saved, sharingDraft);
  Object.assign(patch, sharing.patch);
  const unsaved = Object.keys(patch).length;

  async function save() {
    setPending(true);
    try {
      await update.mutateAsync(patch);
      setDraft({});
      setThemeDraft(undefined);
      setClientDraft(undefined);
      setAttributionDraft({});
      setOutsideDraft(undefined);
      setNetworkDraft({});
      setCompactionDraft({});
      setSuggestionsDraft(undefined);
      setSharingDraft({});
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
        ...(currencyValid && sharing.errors === 0
          ? {}
          : { errors: (currencyValid ? 0 : 1) + sharing.errors }),
        cancel: {
          label: tc("cancel"),
          onSelect: () => {
            setDraft({});
            setThemeDraft(undefined);
            setClientDraft(undefined);
            setAttributionDraft({});
            setOutsideDraft(undefined);
            setNetworkDraft({});
            setCompactionDraft({});
            setSuggestionsDraft(undefined);
            setSharingDraft({});
          },
        },
        primary: {
          label: t("save"),
          onSelect: () => void save(),
          loading: pending,
          disabled: !currencyValid || sharing.errors > 0 || unsaved === 0,
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
      {saved.devicesOutsideSandbox !== undefined && (
        <OutsideSandboxSection
          value={saved.devicesOutsideSandbox}
          draft={outsideDraft}
          onChange={setOutsideDraft}
        />
      )}
      {saved.devicesNetwork !== undefined && network !== null && (
        <DeviceNetworkSection
          saved={saved.devicesNetwork}
          value={network.value}
          onChange={(field, mode) => setNetworkDraft((d) => ({ ...d, [field]: mode }))}
        />
      )}
      {saved.attribution !== undefined && attribution !== null && (
        <AttributionSection
          saved={saved.attribution}
          value={attribution.value}
          onChange={(d) => setAttributionDraft((cur) => ({ ...cur, ...d }))}
        />
      )}
      <FormSection id="prompt-suggestions" title={tps("title")} description={tps("description")}>
        <SwitchField
          label={tps("title")}
          checked={promptSuggestions === "on"}
          onChange={(on) => setSuggestionsDraft(on ? "on" : "off")}
        />
      </FormSection>
      <CompactionSection
        value={compaction}
        onChange={(d) => setCompactionDraft((cur) => ({ ...cur, ...d }))}
      />
      {saved.externalSharing !== undefined && saved.shareMaxExpiryDays !== undefined && (
        <SharingSection
          saved={saved}
          shown={sharing}
          onChange={(d) => setSharingDraft((cur) => ({ ...cur, ...d }))}
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

/** The sharing section's edits: the switch, the expiry maximum (text) and the allowlist (text). */
interface SharingDraft {
  external?: "allow" | "deny";
  maxDays?: string;
  allowlist?: string;
}

/** The entries of an allowlist text (one per line, commas and spaces too): trimmed, lower case. */
const originsOf = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map(cdnOriginOf)
      .filter((o) => o !== ""),
  ),
];

/**
 * What the sharing section shows (the draft over the saved values, a locked field always its
 * startup-config value), the first invalid allowlist entry, the number of errors and the patch:
 * changed fields only, never one the startup config sets. The allowlist is sent whole.
 */
function sharingOf(saved: DeploymentSettings, draft: SharingDraft) {
  const ext = saved.externalSharing;
  const max = saved.shareMaxExpiryDays;
  const list = saved.htmlRenderCdnAllowlist ?? [];
  const external =
    ext === undefined || lockedSource(ext.source) !== null
      ? (ext?.value ?? "deny")
      : (draft.external ?? ext.value);
  const maxText =
    max === undefined || lockedSource(max.source) !== null
      ? String(max?.value ?? 30)
      : (draft.maxDays ?? String(max.value));
  const days = Number(maxText);
  const maxValid = /^\d+$/.test(maxText) && days >= 1 && days <= 365;
  const allowText = draft.allowlist ?? list.join("\n");
  const origins = originsOf(allowText);
  const badOrigin = origins.find((o) => !isCdnOrigin(o));
  const patch: DeploymentSettingsPatch = {};
  if (ext !== undefined && lockedSource(ext.source) === null && external !== ext.value) {
    patch.externalSharing = external;
  }
  if (max !== undefined && lockedSource(max.source) === null && maxValid && days !== max.value) {
    patch.shareMaxExpiryDays = days;
  }
  if (
    draft.allowlist !== undefined &&
    badOrigin === undefined &&
    origins.join("\n") !== list.join("\n")
  ) {
    patch.htmlRenderCdnAllowlist = origins;
  }
  return {
    external,
    maxText,
    maxValid,
    allowText,
    badOrigin,
    errors: (maxValid ? 0 : 1) + (badOrigin === undefined ? 0 : 1),
    patch,
  };
}

/**
 * External sharing (file sharing spec §8): the platform switch (off by default; orgs turn it on only where
 * it is allowed), the longest link expiry and the CDN origins a rendered HTML file may load from.
 * The switch and the maximum read-only when the startup config sets them. Saved with the ActionRow.
 */
function SharingSection({
  saved,
  shown,
  onChange,
}: {
  saved: DeploymentSettings;
  shown: ReturnType<typeof sharingOf>;
  onChange(d: SharingDraft): void;
}) {
  const t = useTranslations("admin.settings.sharing");
  const tf = useTranslations("configForm");
  const ext = saved.externalSharing;
  const max = saved.shareMaxExpiryDays;
  const extLocked = ext === undefined ? null : lockedSource(ext.source);
  const maxLocked = max === undefined ? null : lockedSource(max.source);
  return (
    <FormSection id="sharing" title={t("title")} description={t("description")}>
      <Stack gap={12}>
        <Stack gap={4}>
          <SwitchField
            label={t("external")}
            checked={shown.external === "allow"}
            disabled={extLocked !== null}
            onChange={(on) => onChange({ external: on ? "allow" : "deny" })}
          />
          <Text variant="small" tone="muted">
            {extLocked === null
              ? t("externalHelp")
              : `${tf("readonly", { source: extLocked })} · sharing.external`}
          </Text>
        </Stack>
        <Field
          label={t("maxExpiryDays")}
          help={
            maxLocked === null
              ? t("maxExpiryHelp")
              : `${tf("readonly", { source: maxLocked })} · sharing.maxExpiryDays`
          }
          {...(shown.maxValid ? {} : { error: t("maxExpiryInvalid") })}
        >
          <Input
            type="number"
            min={1}
            max={365}
            value={shown.maxText}
            disabled={maxLocked !== null}
            onChange={(e) => onChange({ maxDays: e.target.value })}
          />
        </Field>
        <Field
          label={t("cdnAllowlist")}
          help={t("cdnHelp")}
          {...(shown.badOrigin === undefined
            ? {}
            : { error: t("invalidOrigin", { origin: shown.badOrigin }) })}
        >
          <Textarea
            code
            rows={6}
            value={shown.allowText}
            onChange={(e) => onChange({ allowlist: e.target.value })}
          />
        </Field>
      </Stack>
    </FormSection>
  );
}

/** The compaction patch: only the fields that differ from the saved platform settings, or null. */
function compactionChange(
  saved: CompactionSettings,
  next: CompactionSettings,
): CompactionSettingsPatch | null {
  const change: CompactionSettingsPatch = {};
  for (const f of [
    "enabled",
    "threshold",
    "keepRecentTurns",
    "reserveTokens",
    "maxOutputTokens",
  ] as const) {
    if (next[f] !== saved[f]) Object.assign(change, { [f]: next[f] });
  }
  return Object.keys(change).length > 0 ? change : null;
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

/** The two fields of the platform's device network. */
type NetworkField = "default" | "ceiling";

/**
 * The device network the section shows (the draft over the saved values, a locked field always
 * its startup-config value, the default never above the ceiling) and the patch: the changed fields
 * only, never a locked one.
 */
function networkOf(
  saved: DevicesNetworkView,
  draft: Partial<Record<NetworkField, DeviceNetworkMode>>,
): {
  value: Record<NetworkField, DeviceNetworkMode>;
  patch: Partial<Record<NetworkField, DeviceNetworkMode>> | null;
} {
  const shown = (f: NetworkField) =>
    startupLocked(saved.sources[f]) ? saved[f] : (draft[f] ?? saved[f]);
  const ceiling = shown("ceiling");
  const value = { ceiling, default: narrowerNetwork(shown("default"), ceiling) };
  const patch: Partial<Record<NetworkField, DeviceNetworkMode>> = {};
  for (const f of ["default", "ceiling"] as const)
    if (value[f] !== saved[f] && !startupLocked(saved.sources[f])) patch[f] = value[f];
  return { value, patch: Object.keys(patch).length > 0 ? patch : null };
}

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
 * Running outside the sandbox (`devicesOutsideSandbox`): one control, allowed or off, with where the
 * value comes from. A value set in the startup config is disabled with its source. Off keeps every
 * call inside the sandbox. The kernel refuses allowing it through an API token or the Platform
 * tool, which may only turn it off; a signed-in super admin here may set it either way. Saved with
 * the page's ActionRow.
 */
function OutsideSandboxSection({
  value,
  draft,
  onChange,
}: {
  value: DevicesOutsideSandboxView;
  draft: "allowed" | "off" | undefined;
  onChange(permission: "allowed" | "off"): void;
}) {
  const t = useTranslations("admin.settings.outsideSandbox");
  const tf = useTranslations("configForm");
  const locked = startupLocked(value.source);
  const mode = draft ?? value.permission;
  return (
    <FormSection id="outside-sandbox" title={t("title")} description={t("description")}>
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
            ? `${tf("readonly", { source: value.source })} · devices.outsideSandbox`
            : t("source", { source: t(`sources.${value.source}`) })}
        </Text>
      </Stack>
    </FormSection>
  );
}

/**
 * The device network (`devicesNetwork`): the ceiling and the default, each open internet or the
 * allowlist, each with where it comes from (a startup-config field is disabled with its source).
 * The default never goes above the ceiling: narrowing the ceiling to the allowlist takes the
 * default with it. An API token or the Platform tool may only narrow (a kernel rule). Saved with
 * the page's ActionRow.
 */
function DeviceNetworkSection({
  saved,
  value,
  onChange,
}: {
  saved: DevicesNetworkView;
  value: Record<NetworkField, DeviceNetworkMode>;
  onChange(field: NetworkField, mode: DeviceNetworkMode): void;
}) {
  const t = useTranslations("admin.settings.deviceNetwork");
  const tf = useTranslations("configForm");
  const group = (field: NetworkField) => {
    const source = saved.sources[field];
    const locked = startupLocked(source);
    return (
      <Field label={t(field)}>
        <RadioGroup
          label={t(field)}
          variant="card"
          value={value[field]}
          disabled={locked}
          onChange={(v) => onChange(field, v as DeviceNetworkMode)}
          options={(["open", "allowlist"] as const).map((v) => {
            const closed = field === "default" && v === "open" && value.ceiling === "allowlist";
            return {
              value: v,
              label: t(v),
              description: closed ? t("ceilingAllowlist") : t(`${v}Hint`),
              ...(closed ? { disabled: true } : {}),
            };
          })}
        />
      </Field>
    );
  };
  const sourceLine = (field: NetworkField) => {
    const source = saved.sources[field];
    return startupLocked(source)
      ? `${t("sourceOf", { field: t(field), source: tf("readonly", { source }) })} · devices.network.${field}`
      : t("sourceOf", { field: t(field), source: t(`sources.${source}`) });
  };
  return (
    <FormSection id="device-network" title={t("title")} description={t("description")}>
      <Stack gap={8}>
        {group("ceiling")}
        {group("default")}
        <Text variant="small" tone="muted">
          {sourceLine("ceiling")}
        </Text>
        <Text variant="small" tone="muted">
          {sourceLine("default")}
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
