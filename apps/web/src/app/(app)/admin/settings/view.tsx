"use client";

import {
  Button,
  Callout,
  Dialog,
  Field,
  FormPage,
  FormSection,
  Input,
  ItemList,
  ItemListItem,
  RadioGroup,
  Select,
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
import { CompactionSection } from "../../../../components/settings/CompactionSection";
import { usePagePath } from "../../../../components/shell/path";
import { builtinChoice, type ThemeChoice, ThemePicker } from "../../../../components/ThemePicker";
import {
  UiPlacementSection,
  UiReplacementsSection,
} from "../../../../components/UiArrangementSection";
import {
  CLIENT_EXTENSIONS_DEFAULT,
  type ClientExtensionsSetting,
  type CustomPolicy,
  type DeploymentSettings,
  type DeploymentSettingsPatch,
  isCurrencyCode,
  type PlatformTierSource,
  type PlatformTiersPatch,
  type PlatformTiersView,
  updateDeploymentSettings,
} from "../../../../lib/admin";
import {
  COMPACTION_DEFAULTS,
  type CompactionSettings,
  type CompactionSettingsPatch,
} from "../../../../lib/compaction";
import { componentName, type PlatformComponent } from "../../../../lib/components";
import { SANDBOX_TIERS, type SandboxTier, tierAbove } from "../../../../lib/devices";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import {
  adminExtensionsQuery,
  deploymentSettingsQuery,
  invalidateCompactionSettings,
  invalidateSandboxTiers,
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
 * §10.2); a save that changes it marks every cached client set stale. 沙箱级别: the platform's
 * highest and default sandbox level and whether devices may run unsandboxed (sandbox dev tiers spec
 * §4.1); a field set in the startup config is shown read-only with its source, raising the highest
 * level to 开放 asks first. 按组织的限额在「组织」页；
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
          id="sandbox-tiers"
          title={t("sandboxTiers.title")}
          description={t("sandboxTiers.description")}
          loading={{
            fields: [
              { control: "radio-cards", options: 3 },
              { control: "select", help: true },
              { control: "switch", help: true },
            ],
          }}
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
      // the platform's sandbox levels cap every org's levels and devices
      if (patch.sandboxTiers !== undefined) await invalidateSandboxTiers(qc);
      // the platform's compaction defaults are what an org that follows the platform shows
      if (patch.compaction !== undefined) await invalidateCompactionSettings(qc);
      return r;
    },
    invalidates: (patch) => settingsChangeKeys(patch),
    onSuccess: (r) => qc.setQueryData(deploymentSettingsQuery().queryKey, r),
  });
  const [draft, setDraft] = useState<Partial<Simple>>({});
  const [themeDraft, setThemeDraft] = useState<string | null | undefined>(undefined);
  const [clientDraft, setClientDraft] = useState<ClientExtensionsSetting | undefined>(undefined);
  const [tiersDraft, setTiersDraft] = useState<TiersDraft>({});
  const [compactionDraft, setCompactionDraft] = useState<CompactionSettingsPatch>({});
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
  const tiers = saved.sandboxTiers === undefined ? null : tiersOf(saved.sandboxTiers, tiersDraft);
  if (tiers !== null && tiers.patch !== null) patch.sandboxTiers = tiers.patch;
  const savedCompaction = saved.compaction ?? COMPACTION_DEFAULTS;
  const compaction: CompactionSettings = { ...savedCompaction, ...compactionDraft };
  const compactionPatch = compactionChange(savedCompaction, compaction);
  if (compactionPatch !== null) patch.compaction = compactionPatch;
  const unsaved = Object.keys(patch).length;

  async function save() {
    setPending(true);
    try {
      await update.mutateAsync(patch);
      setDraft({});
      setThemeDraft(undefined);
      setClientDraft(undefined);
      setTiersDraft({});
      setCompactionDraft({});
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
            setTiersDraft({});
            setCompactionDraft({});
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
      {saved.sandboxTiers !== undefined && tiers !== null && (
        <SandboxTiersSection
          saved={saved.sandboxTiers}
          value={tiers.value}
          onChange={(d) => setTiersDraft((cur) => ({ ...cur, ...d }))}
        />
      )}
      <CompactionSection
        value={compaction}
        onChange={(d) => setCompactionDraft((cur) => ({ ...cur, ...d }))}
      />
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

/** The fields of the platform's sandbox levels the person changed. */
type TiersDraft = Partial<Pick<PlatformTiersView, "max" | "default" | "allowUnsandboxed">>;

/**
 * The levels shown (the draft over the saved ones; the default comes down with a lower highest
 * level) and the patch: the changed fields only, never one set in the startup config.
 */
function tiersOf(
  saved: PlatformTiersView,
  draft: TiersDraft,
): { value: Omit<PlatformTiersView, "sources">; patch: PlatformTiersPatch | null } {
  const max = draft.max ?? saved.max;
  const chosen = draft.default ?? saved.default;
  const value = {
    max,
    default: tierAbove(chosen, max) ? max : chosen,
    allowUnsandboxed: draft.allowUnsandboxed ?? saved.allowUnsandboxed,
  };
  const patch: PlatformTiersPatch = {};
  for (const f of ["max", "default", "allowUnsandboxed"] as const) {
    if (value[f] !== saved[f] && !lockedSource(saved.sources[f]))
      Object.assign(patch, { [f]: value[f] });
  }
  return { value, patch: Object.keys(patch).length > 0 ? patch : null };
}

/** The startup config's source of a field (read-only here), or null when it can be changed. */
const lockedSource = (s: PlatformTierSource): "env" | "file" | "nacos" | null =>
  s === "env" || s === "file" || s === "nacos" ? s : null;

/**
 * 沙箱级别 (sandbox dev tiers spec §4.1): 最高级别 as three cards, 默认级别 (at most the highest)
 * and 允许设备不使用沙箱. A field the startup config sets is disabled with its source. Choosing
 * 开放 above a lower saved level asks first with the risk text. Saved with the page's ActionRow.
 */
function SandboxTiersSection({
  saved,
  value,
  onChange,
}: {
  saved: PlatformTiersView;
  value: Omit<PlatformTiersView, "sources">;
  onChange(d: TiersDraft): void;
}) {
  const t = useTranslations("admin.settings.sandboxTiers");
  const td = useTranslations("devices.tier");
  const tf = useTranslations("configForm");
  const [confirming, setConfirming] = useState(false);
  const locked = {
    max: lockedSource(saved.sources.max),
    default: lockedSource(saved.sources.default),
    allowUnsandboxed: lockedSource(saved.sources.allowUnsandboxed),
  };
  const lockedNote = (f: keyof typeof locked) => {
    const source = locked[f];
    return source === null ? null : `${tf("readonly", { source })} · sandbox.tiers.${f}`;
  };
  return (
    <FormSection id="sandbox-tiers" title={t("title")} description={t("description")}>
      <Stack gap={12}>
        <Stack gap={4}>
          <RadioGroup
            label={t("max")}
            variant="card"
            value={value.max}
            disabled={locked.max !== null}
            onChange={(v) => {
              const next = v as SandboxTier;
              // raising the platform to open asks first; going back to a saved open does not
              if (next === "open" && saved.max !== "open") setConfirming(true);
              else onChange({ max: next });
            }}
            options={SANDBOX_TIERS.map((tier) => {
              // a default fixed in the startup config may not end up above the highest level
              const below = locked.default !== null && tierAbove(saved.default, tier);
              return {
                value: tier,
                label: td(tier),
                description: below ? t("belowDefault") : t(`${tier}Hint`),
                ...(below && { disabled: true }),
              };
            })}
          />
          {locked.max !== null && (
            <Text variant="small" tone="muted">
              {lockedNote("max")}
            </Text>
          )}
        </Stack>
        <Field label={t("default")} help={lockedNote("default") ?? t("defaultHelp")}>
          <Select
            value={value.default}
            disabled={locked.default !== null}
            onChange={(ev) => onChange({ default: ev.target.value as SandboxTier })}
            options={SANDBOX_TIERS.filter((tier) => !tierAbove(tier, value.max)).map((tier) => ({
              value: tier,
              label: td(tier),
            }))}
          />
        </Field>
        <Stack gap={4}>
          <SwitchField
            label={t("allowUnsandboxed")}
            checked={value.allowUnsandboxed}
            disabled={locked.allowUnsandboxed !== null}
            onChange={(next) => onChange({ allowUnsandboxed: next })}
          />
          <Text variant="small" tone="muted">
            {lockedNote("allowUnsandboxed") ?? t("allowUnsandboxedHint")}
          </Text>
        </Stack>
      </Stack>
      {confirming && (
        <Dialog
          open
          danger
          initialFocus="cancel"
          onOpenChange={(o) => {
            if (!o) setConfirming(false);
          }}
          title={t("openConfirmTitle")}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t("cancel")}
              </Button>
              <Button
                variant="danger-solid"
                onClick={() => {
                  onChange({ max: "open" });
                  setConfirming(false);
                }}
              >
                {t("openConfirmSubmit")}
              </Button>
            </>
          }
        >
          <Text variant="prose">{t("openConfirmBody")}</Text>
        </Dialog>
      )}
    </FormSection>
  );
}
