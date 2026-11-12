"use client";

import {
  Disclosure,
  Field,
  FormSection,
  KeyValue,
  RadioGroup,
  Select,
  SettingsPage,
  Stack,
  SwitchField,
  Text,
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import { SANDBOX_TIERS, type SandboxTier, tierAbove } from "../../../../lib/devices";
import {
  canUpdateOrg,
  type OrgSettings,
  type OrgSettingsPatch,
  type OrgSettingsResponse,
  parseHostList,
  type SandboxEgressSetting,
  type SandboxTierSetting,
  updateOrgSettings,
} from "../../../../lib/org-settings";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { orgSettingsQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/settings/sandbox`: the organization's sandbox settings (SettingsPage): the default policy of the
 * sandbox tools (run directly / ask for approval), the sandbox levels (sandbox dev tiers spec
 * §11.2: 最高级别 as three cards, 开放 disabled with 平台未开放 when the platform's max is lower and
 * carrying the risk text; 新设备默认 at most the highest; 允许成员的设备不使用沙箱 under 开放 when
 * the platform allows it), sandbox egress (follow the deployment / custom
 * allowlist / no network, ruling M19) and sandbox resources (cpu / memory, read-only: super
 * admins override them per organization in the deployment settings, C19). Members can see, admins
 * can change; changes show an ActionRow. The org-settings PATCH is shared with the general page:
 * this page sends only its own fields. From the query cache (the layout prefetched it on a first
 * load; the general page shares it); a save writes the answer into the cache.
 */

type EgressMode = "default" | SandboxEgressSetting["mode"];

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export default function SandboxSettingsView({ allowHosts = [] }: { allowHosts?: string[] }) {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <SandboxSettings orgId={ws.orgId} allowHosts={allowHosts} />;
}

function SandboxSettings({ orgId, allowHosts }: { orgId: string; allowHosts: string[] }) {
  const scope = usePagePath("org");
  const t = useTranslations("orgSettings");
  const ts = useTranslations("sandboxSettings");
  const td = useTranslations("devices.tier");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useOrgSettingsNav();
  const { me } = useSession();
  const manage = canUpdateOrg(me);
  const qc = useQueryClient();
  const read = usePageQuery(orgSettingsQuery(orgId));
  const [draft, setDraft] = useState<{
    sandboxToolPolicy?: NonNullable<OrgSettings["sandboxToolPolicy"]>;
    egressMode?: EgressMode;
    hostsText?: string;
    tierMax?: SandboxTier;
    tierDefault?: SandboxTier;
    allowUnsandboxed?: boolean;
  }>({});
  // The answer is the new settings; the read-only parts it leaves out keep their cached values.
  const update = useAppMutation({
    fn: (patch: OrgSettingsPatch) => updateOrgSettings(orgId, patch),
    invalidates: () => [],
    onSuccess: (res) =>
      qc.setQueryData<OrgSettingsResponse>(orgSettingsQuery(orgId).queryKey, (old) => ({
        ...old,
        settings: res.settings,
        ...(res.deployment !== undefined ? { deployment: res.deployment } : {}),
        ...(res.sandboxLimits !== undefined ? { sandboxLimits: res.sandboxLimits } : {}),
      })),
  });
  // `?allowHost=`: once the settings are in, an org admin's draft becomes a custom allowlist with
  // the hosts appended (those not listed yet); nothing is saved until the person saves.
  const [prefilled, setPrefilled] = useState<string[] | null>(null);
  const loaded = read.kind === "ready" ? read.data : null;
  useEffect(() => {
    if (prefilled !== null || loaded === null || !manage || allowHosts.length === 0) return;
    const deploymentEgress = loaded.deployment?.sandboxEgress;
    const own = loaded.settings.sandboxEgress;
    // no list to add to: the platform has no network
    if (deploymentEgress === undefined || deploymentEgress.mode === "none") return;
    const base = own?.allowHosts ?? deploymentEgress.allowHosts;
    const added = allowHosts.filter((h) => !base.includes(h));
    if (added.length === 0) {
      setPrefilled([]);
      return;
    }
    setPrefilled(added);
    setDraft((d) => ({
      ...d,
      egressMode: "allowlist",
      hostsText: [...base, ...added].join("\n"),
    }));
  }, [loaded, manage, allowHosts, prefilled]);
  const header = {
    path: [...scope, { label: "settings", href: "/settings/organization" }, { label: "sandbox" }],
    title: ts("title"),
  };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="sandbox"
        // The static sections: the tool policy (two cards, and the read-only note for a member),
        // egress (three cards and the "new sandboxes only" note) and the resources (three rows and
        // the same note).
        loading={{
          sections: [
            {
              fields: [{ control: "radio-cards", options: 2, help: !manage }],
              title: t("sandbox.title"),
              description: t("sandbox.description"),
            },
            {
              fields: [{ control: "radio-cards", options: 3 }, { control: "select" }],
              title: t("tiers.title"),
              description: t("tiers.description"),
            },
            {
              fields: [{ control: "radio-cards", options: 3, help: true }],
              title: t("egress.title"),
              description: t("egress.description"),
            },
            {
              fields: [{ control: "key-value", rows: 3, keyWidth: "10ch", help: true }],
              title: t("limits.title"),
              description: t("limits.description"),
            },
          ],
        }}
      />
    );
  }
  const data = read.data;
  const saved = data.settings;
  const { deployment, sandboxLimits } = data;
  const sandboxPolicy = draft.sandboxToolPolicy ?? saved?.sandboxToolPolicy ?? "allow";
  // Following the deployment leaves sandboxEgress unset; a custom allowlist starts from the org's or the deployment's list
  const savedEgress = saved?.sandboxEgress;
  // An org allowlist under a deployment that went to "none" is effectively none (kernel effectiveSandboxEgress)
  const savedMode: EgressMode =
    savedEgress?.mode === "allowlist" && deployment?.sandboxEgress.mode === "none"
      ? "none"
      : (savedEgress?.mode ?? "default");
  const egressMode = draft.egressMode ?? savedMode;
  const baseHosts = savedEgress?.allowHosts ?? deployment?.sandboxEgress.allowHosts ?? [];
  const hostsText = draft.hostsText ?? baseHosts.join("\n");
  const hosts = parseHostList(hostsText);
  const egressChanged =
    egressMode !== savedMode ||
    (egressMode === "allowlist" && draft.hostsText !== undefined && !sameList(hosts, baseHosts));
  const egressValue: SandboxEgressSetting | null =
    egressMode === "default"
      ? null
      : egressMode === "none"
        ? { mode: "none" }
        : { mode: "allowlist", allowHosts: hosts };
  // The levels: the org's own setting over the platform's (absent = follow the platform)
  const platformTiers = deployment?.sandboxTiers;
  const ownTier = saved.sandboxTier;
  const savedMax = ownTier?.max ?? platformTiers?.max ?? "dev";
  const tierMax = draft.tierMax ?? savedMax;
  const clampTo = (tier: SandboxTier, max: SandboxTier) => (tierAbove(tier, max) ? max : tier);
  const savedDefault = clampTo(ownTier?.default ?? platformTiers?.default ?? "dev", savedMax);
  const tierDefault = clampTo(draft.tierDefault ?? savedDefault, tierMax);
  const savedAllow = ownTier?.allowUnsandboxed ?? platformTiers?.allowUnsandboxed ?? false;
  const allowUnsandboxed = draft.allowUnsandboxed ?? savedAllow;
  const tierChanged =
    tierMax !== savedMax || tierDefault !== savedDefault || allowUnsandboxed !== savedAllow;
  // Only the fields the person set, kept explicit once changed; a default above the new highest
  // level comes down with it.
  const tierValue: SandboxTierSetting = {
    ...ownTier,
    ...(draft.tierMax !== undefined || ownTier?.max !== undefined ? { max: tierMax } : {}),
    ...(draft.tierDefault !== undefined ||
    ownTier?.default !== undefined ||
    tierDefault !== savedDefault
      ? { default: tierDefault }
      : {}),
    ...(draft.allowUnsandboxed !== undefined ? { allowUnsandboxed } : {}),
  };
  // Only the changed fields
  const patch: OrgSettingsPatch = {
    ...(tierChanged ? { sandboxTier: tierValue } : {}),
    ...(sandboxPolicy !== (saved.sandboxToolPolicy ?? "allow")
      ? { sandboxToolPolicy: sandboxPolicy }
      : {}),
    ...(egressChanged ? { sandboxEgress: egressValue } : {}),
  };
  const unsaved = Object.keys(patch).length;
  const devHosts = platformTiers?.devHosts ?? [];
  const dirty = unsaved > 0;

  async function save() {
    try {
      await update.mutateAsync(patch);
      setDraft({});
      setPrefilled([]);
      toast.success(ts("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <SettingsPage
      header={header}
      nav={nav}
      activeNav="sandbox"
      {...(dirty
        ? {
            actionRow: {
              unsaved,
              cancel: {
                label: tc("cancel"),
                onSelect: () => {
                  setDraft({});
                  setPrefilled([]);
                },
              },
              primary: { label: t("save"), onSelect: () => void save(), loading: update.isPending },
            },
          }
        : {})}
    >
      <FormSection
        id="sandbox-tools"
        title={t("sandbox.title")}
        description={t("sandbox.description")}
      >
        <Stack gap={8}>
          <RadioGroup
            label={t("sandbox.title")}
            variant="card"
            value={sandboxPolicy}
            disabled={!manage}
            onChange={(v) =>
              setDraft((d) => ({
                ...d,
                sandboxToolPolicy: v as NonNullable<OrgSettings["sandboxToolPolicy"]>,
              }))
            }
            options={(["allow", "ask"] as const).map((v) => ({
              value: v,
              label: t(`sandbox.${v}`),
              description: t(`sandbox.${v}Hint`),
            }))}
          />
          {!manage && (
            <Text variant="small" tone="muted">
              {t("readonly")}
            </Text>
          )}
        </Stack>
      </FormSection>
      {platformTiers !== undefined && (
        <FormSection
          id="sandbox-tiers"
          title={t("tiers.title")}
          description={t("tiers.description")}
        >
          <Stack gap={12}>
            <RadioGroup
              label={t("tiers.max")}
              variant="card"
              value={tierMax}
              disabled={!manage}
              onChange={(v) => setDraft((d) => ({ ...d, tierMax: v as SandboxTier }))}
              options={SANDBOX_TIERS.map((tier) => {
                const closed = tierAbove(tier, platformTiers.max);
                return {
                  value: tier,
                  label: td(tier),
                  description: closed ? t("tiers.platformClosed") : t(`tiers.${tier}Hint`),
                  ...(closed ? { disabled: true } : {}),
                };
              })}
            />
            {tierMax === "open" && platformTiers.allowUnsandboxed && (
              <Stack gap={4}>
                <SwitchField
                  label={t("tiers.allowUnsandboxed")}
                  checked={allowUnsandboxed}
                  disabled={!manage}
                  onChange={(next) => setDraft((d) => ({ ...d, allowUnsandboxed: next }))}
                />
                <Text variant="small" tone="muted">
                  {t("tiers.allowUnsandboxedHint")}
                </Text>
              </Stack>
            )}
            <Field label={t("tiers.default")} help={t("tiers.defaultHelp")}>
              <Select
                value={tierDefault}
                disabled={!manage}
                onChange={(ev) =>
                  setDraft((d) => ({ ...d, tierDefault: ev.target.value as SandboxTier }))
                }
                options={SANDBOX_TIERS.filter((tier) => !tierAbove(tier, tierMax)).map((tier) => ({
                  value: tier,
                  label: td(tier),
                }))}
              />
            </Field>
            {!manage && (
              <Text variant="small" tone="muted">
                {t("readonly")}
              </Text>
            )}
          </Stack>
        </FormSection>
      )}
      {deployment !== undefined && (
        <FormSection
          id="sandbox-egress"
          title={t("egress.title")}
          description={t("egress.description")}
        >
          <Stack gap={8}>
            <RadioGroup
              label={t("egress.title")}
              variant="card"
              value={egressMode}
              disabled={!manage}
              onChange={(v) => setDraft((d) => ({ ...d, egressMode: v as EgressMode }))}
              options={(
                [
                  "default",
                  // 部署不联网时组织不能放开
                  ...(deployment.sandboxEgress.mode === "none" ? [] : (["allowlist"] as const)),
                  "none",
                ] as const
              ).map((v) => ({
                value: v,
                label: t(`egress.${v}`),
                description:
                  v === "default"
                    ? t(`egress.defaultHint.${deployment.sandboxEgress.mode}`, {
                        count: deployment.sandboxEgress.allowHosts.length,
                      })
                    : t(`egress.${v}Hint`),
              }))}
            />
            {egressMode === "allowlist" && (
              <Field label={t("egress.hosts")} help={t("egress.hostsHelp")}>
                <Textarea
                  code
                  rows={8}
                  value={hostsText}
                  disabled={!manage}
                  onChange={(e) => setDraft((d) => ({ ...d, hostsText: e.target.value }))}
                />
              </Field>
            )}
            {devHosts.length > 0 &&
              (egressMode === "allowlist" ||
                (egressMode === "default" && deployment.sandboxEgress.mode === "allowlist")) && (
                <Disclosure summary={t("egress.devHosts", { count: devHosts.length })}>
                  <Text variant="small" tone="muted">
                    {devHosts.join(", ")}
                  </Text>
                </Disclosure>
              )}
            {egressMode === "allowlist" && prefilled !== null && prefilled.length > 0 && (
              <Text variant="small" tone="muted">
                {t("egress.prefilled", { hosts: prefilled.join(", ") })}
              </Text>
            )}
            <Text variant="small" tone="muted">
              {t("egress.newOnly")}
            </Text>
          </Stack>
        </FormSection>
      )}
      {sandboxLimits !== undefined && (
        <FormSection
          id="sandbox-limits"
          title={t("limits.title")}
          description={t("limits.description")}
        >
          <Stack gap={8}>
            <KeyValue
              keyWidth="10ch"
              rows={[
                { k: t("limits.cpu"), v: t("limits.cpuValue", { cpu: sandboxLimits.cpu }) },
                {
                  k: t("limits.memory"),
                  v: t("limits.memoryValue", { mb: sandboxLimits.memoryMb }),
                },
                { k: t("limits.sourceLabel"), v: t(`limits.source.${sandboxLimits.source}`) },
              ]}
            />
            <Text variant="small" tone="muted">
              {t("limits.newOnly")}
            </Text>
          </Stack>
        </FormSection>
      )}
    </SettingsPage>
  );
}
