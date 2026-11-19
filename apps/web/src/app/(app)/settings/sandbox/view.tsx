"use client";

import {
  Button,
  Dialog,
  Field,
  FormSection,
  KeyValue,
  RadioGroup,
  SettingsPage,
  Stack,
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
import { ApiClientError } from "../../../../lib/api";
import { allowHostProblem } from "../../../../lib/network-hosts";
import {
  canUpdateOrg,
  type DeviceNetworkMode,
  deviceNetworkToSave,
  narrowerNetwork,
  type OrgSettings,
  type OrgSettingsPatch,
  type OrgSettingsResponse,
  parseHostList,
  updateOrgSettings,
} from "../../../../lib/org-settings";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { orgSettingsQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/settings/sandbox`: the organization's sandbox settings (SettingsPage): the default policy of the
 * sandbox tools (run directly / ask for approval), whether calls may run outside the sandbox
 * (`outsideSandbox`: the org may follow the platform or turn it off; the platform's off locks it,
 * naming the super admin) and its device network (approval-only profiles design, "Settings model"):
 * a ceiling and a default (open internet or the allowlist; never above the platform's ceiling, the
 * default never above the ceiling) and the host editor, which starts from the effective hosts and
 * saves a delta over the platform's list. The kill switch makes the network read-only. An org with
 * a stored network gets 跟随平台 (after a confirmation: `deviceNetwork: null`, which drops its own
 * default, ceiling, additions and removals). Plus
 * the sandbox resources (cpu / memory, read-only: super admins
 * override them per organization in the deployment settings, C19). Members can see, admins can
 * change; changes show an ActionRow. The org-settings PATCH is shared with the general page: this
 * page sends only its own fields. From the query cache (the layout prefetched it on a first load;
 * the general page shares it); a save writes the answer into the cache.
 */

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
    outsideSandbox?: "allowed" | "off";
    networkDefault?: DeviceNetworkMode;
    networkCeiling?: DeviceNetworkMode;
    hostsText?: string;
  }>({});
  // The answer is the new settings; the read-only parts it leaves out keep their cached values.
  const update = useAppMutation({
    fn: (patch: OrgSettingsPatch) => updateOrgSettings(orgId, patch),
    // both change every device's effective sandbox
    invalidates: (patch) =>
      patch.outsideSandbox !== undefined || patch.deviceNetwork !== undefined
        ? [keys.org(orgId).devices(), keys.org(orgId).deviceAll()]
        : [],
    onSuccess: (res) =>
      qc.setQueryData<OrgSettingsResponse>(orgSettingsQuery(orgId).queryKey, (old) => ({
        ...old,
        settings: res.settings,
        ...(res.deployment !== undefined ? { deployment: res.deployment } : {}),
        ...(res.sandboxLimits !== undefined ? { sandboxLimits: res.sandboxLimits } : {}),
        ...(res.effectiveNetwork !== undefined ? { effectiveNetwork: res.effectiveNetwork } : {}),
      })),
  });
  // `?allowHost=`: once the settings are in, an org admin's host editor gets the hosts appended
  // (those not listed yet); the modes are left alone; nothing is saved until the person saves.
  const [prefilled, setPrefilled] = useState<string[] | null>(null);
  const [confirmingFollow, setConfirmingFollow] = useState(false);
  const loaded = read.kind === "ready" ? read.data : null;
  useEffect(() => {
    if (prefilled !== null || loaded === null || !manage || allowHosts.length === 0) return;
    const platformNetwork = loaded.deployment?.deviceNetwork;
    // the kernel always answers with the deployment defaults; no list to add to without them
    if (platformNetwork === undefined) return;
    // no list to add to: the platform turned the network off
    if (platformNetwork.off) return;
    const base = loaded.effectiveNetwork?.hosts;
    if (base === undefined) return;
    const added = allowHosts.filter((h) => !base.includes(h));
    if (added.length === 0) {
      setPrefilled([]);
      return;
    }
    setPrefilled(added);
    setDraft((d) => ({ ...d, hostsText: [...base, ...added].join("\n") }));
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
        // running outside the sandbox (two cards), the device network (two card groups and the
        // host list) and the resources (three rows and the same note).
        loading={{
          sections: [
            {
              fields: [{ control: "radio-cards", options: 2, help: !manage }],
              title: t("sandbox.title"),
              description: t("sandbox.description"),
            },
            {
              fields: [{ control: "radio-cards", options: 2 }],
              title: t("outsideSandbox.title"),
              description: t("outsideSandbox.description"),
            },
            {
              fields: [
                { control: "radio-cards", options: 2 },
                { control: "radio-cards", options: 2 },
                { control: "textarea", rows: 8 },
              ],
              title: t("deviceNetwork.title"),
              description: t("deviceNetwork.description"),
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
  // The kernel always sends the deployment defaults; without them "follow the platform" has no
  // meaning, so the page fails visibly instead of guessing.
  const { deployment, effectiveNetwork } = data;
  if (deployment === undefined || effectiveNetwork === undefined) {
    return (
      <ErrorFrame
        reset={() => void qc.invalidateQueries({ queryKey: orgSettingsQuery(orgId).queryKey })}
      />
    );
  }
  const { sandboxLimits } = data;
  const sandboxPolicy = draft.sandboxToolPolicy ?? saved?.sandboxToolPolicy ?? "allow";
  // Running outside the sandbox: the platform's off wins; the org may narrow it, never widen it
  const platformOff = deployment.outsideSandbox.permission === "off";
  const savedOutside: "allowed" | "off" = platformOff
    ? "off"
    : (saved.outsideSandbox ?? deployment.outsideSandbox.permission);
  const outsideSandbox = platformOff ? "off" : (draft.outsideSandbox ?? savedOutside);
  const outsideChanged =
    !platformOff && draft.outsideSandbox !== undefined && draft.outsideSandbox !== savedOutside;
  // The device network: the kill switch (`off`) makes it read-only (an empty allowlist) and it is
  // never sent; the platform's allowlist ceiling disables open in both groups; the default never
  // goes above the ceiling. A host outside the platform list under `within` is the kernel's to refuse.
  const platformNetwork = deployment.deviceNetwork;
  const networkOff = platformNetwork.off;
  const within = platformNetwork.orgHosts === "within";
  const platformAllowlist = networkOff || platformNetwork.ceiling === "allowlist";
  const storedNetwork = saved.deviceNetwork;
  const ceilingOf = (choice: DeviceNetworkMode | undefined): DeviceNetworkMode =>
    platformAllowlist ? "allowlist" : (choice ?? platformNetwork.ceiling);
  const defaultOf = (choice: DeviceNetworkMode | undefined, ceiling: DeviceNetworkMode) =>
    narrowerNetwork(choice ?? platformNetwork.default, ceiling);
  const savedCeiling = ceilingOf(storedNetwork?.ceiling);
  const savedDefault = defaultOf(storedNetwork?.default, savedCeiling);
  const networkCeiling = ceilingOf(draft.networkCeiling ?? storedNetwork?.ceiling);
  const networkDefault = defaultOf(draft.networkDefault ?? storedNetwork?.default, networkCeiling);
  const ceilingChanged = !networkOff && networkCeiling !== savedCeiling;
  const defaultChanged = !networkOff && networkDefault !== savedDefault;
  const baseHosts = effectiveNetwork.hosts;
  const hostsText = draft.hostsText ?? baseHosts.join("\n");
  const hosts = parseHostList(hostsText);
  const hostsChanged = !networkOff && draft.hostsText !== undefined && !sameList(hosts, baseHosts);
  const networkChanged = ceilingChanged || defaultChanged || hostsChanged;
  // PATCH replaces the stored value whole: the stored value with the edited fields changed
  const networkValue = deviceNetworkToSave(storedNetwork, platformNetwork.allowHosts, hosts, {
    ...(ceilingChanged ? { ceiling: networkCeiling } : {}),
    ...(defaultChanged ? { default: networkDefault } : {}),
  });
  const badHost = networkOff
    ? undefined
    : hosts.find((h) => allowHostProblem(h, { wildcard: true }) !== null);
  const hostsInvalid =
    badHost !== undefined ||
    (networkValue.extraHosts?.length ?? 0) > 200 ||
    (networkValue.excludedHosts?.length ?? 0) > 200;
  // Only the changed fields
  const patch: OrgSettingsPatch = {
    ...(outsideChanged ? { outsideSandbox } : {}),
    ...(networkChanged ? { deviceNetwork: networkValue } : {}),
    ...(sandboxPolicy !== (saved.sandboxToolPolicy ?? "allow")
      ? { sandboxToolPolicy: sandboxPolicy }
      : {}),
  };
  const unsaved = Object.keys(patch).length;
  const dirty = unsaved > 0;

  async function save() {
    if (hostsInvalid) return;
    try {
      await update.mutateAsync(patch);
      setDraft({});
      setPrefilled([]);
      toast.success(ts("saved"));
    } catch (e) {
      toast.error(saveError(e));
    }
  }

  // 跟随平台: clears the stored network (and any unsaved network draft); other drafts stay.
  async function followPlatform() {
    try {
      await update.mutateAsync({ deviceNetwork: null });
      setDraft(({ networkDefault: _d, networkCeiling: _c, hostsText: _h, ...rest }) => rest);
      setPrefilled([]);
      setConfirmingFollow(false);
      toast.success(t("deviceNetwork.followPlatformDone"));
    } catch (e) {
      setConfirmingFollow(false);
      toast.error(saveError(e));
    }
  }

  // A host outside the platform ceiling: the kernel's refusal names it (spec §D2).
  function saveError(e: unknown): string {
    if (e instanceof ApiClientError && e.code === "org.sandbox_egress_not_allowed") {
      const d = e.rawDetails[0] as { reason?: unknown; hosts?: unknown } | undefined;
      if (d?.reason === "outside_ceiling" && Array.isArray(d.hosts) && d.hosts.length > 0) {
        return t("deviceNetwork.outsideCeiling", { hosts: d.hosts.join(", ") });
      }
    }
    return errorMessage(e);
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
              ...(hostsInvalid ? { errors: 1 } : {}),
              cancel: {
                label: tc("cancel"),
                onSelect: () => {
                  setDraft({});
                  setPrefilled([]);
                },
              },
              primary: {
                label: t("save"),
                onSelect: () => void save(),
                loading: update.isPending,
                disabled: hostsInvalid,
              },
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
      <FormSection
        id="outside-sandbox"
        title={t("outsideSandbox.title")}
        description={t("outsideSandbox.description")}
      >
        <Stack gap={8}>
          <RadioGroup
            label={t("outsideSandbox.title")}
            variant="card"
            value={outsideSandbox}
            disabled={!manage || platformOff}
            onChange={(v) => setDraft((d) => ({ ...d, outsideSandbox: v as "allowed" | "off" }))}
            options={(["allowed", "off"] as const).map((v) => {
              const closed = v === "allowed" && platformOff;
              return {
                value: v,
                label: t(`outsideSandbox.${v}`),
                description: closed
                  ? t("outsideSandbox.platformClosed")
                  : t(`outsideSandbox.${v}Hint`),
                ...(closed ? { disabled: true } : {}),
              };
            })}
          />
          {!manage && (
            <Text variant="small" tone="muted">
              {t("readonly")}
            </Text>
          )}
        </Stack>
      </FormSection>
      <FormSection
        id="device-network"
        title={t("deviceNetwork.title")}
        description={t("deviceNetwork.description")}
      >
        <Stack gap={8}>
          <Field label={t("deviceNetwork.ceiling")}>
            <RadioGroup
              label={t("deviceNetwork.ceiling")}
              variant="card"
              value={networkCeiling}
              disabled={!manage || networkOff}
              onChange={(v) => setDraft((d) => ({ ...d, networkCeiling: v as DeviceNetworkMode }))}
              options={(["open", "allowlist"] as const).map((v) => {
                const closed = v === "open" && platformAllowlist && !networkOff;
                return {
                  value: v,
                  label: t(`deviceNetwork.${v}`),
                  description: closed
                    ? t("deviceNetwork.platformAllowlist")
                    : t(`deviceNetwork.${v}Hint`),
                  ...(closed ? { disabled: true } : {}),
                };
              })}
            />
          </Field>
          <Field label={t("deviceNetwork.default")}>
            <RadioGroup
              label={t("deviceNetwork.default")}
              variant="card"
              value={networkDefault}
              disabled={!manage || networkOff}
              onChange={(v) => setDraft((d) => ({ ...d, networkDefault: v as DeviceNetworkMode }))}
              options={(["open", "allowlist"] as const).map((v) => {
                const closed = v === "open" && networkCeiling === "allowlist" && !networkOff;
                return {
                  value: v,
                  label: t(`deviceNetwork.${v}`),
                  description: !closed
                    ? t(`deviceNetwork.${v}Hint`)
                    : platformAllowlist
                      ? t("deviceNetwork.platformAllowlist")
                      : t("deviceNetwork.ceilingAllowlist"),
                  ...(closed ? { disabled: true } : {}),
                };
              })}
            />
          </Field>
          {networkOff && (
            <Text variant="small" tone="muted">
              {t("deviceNetwork.platformClosed")}
            </Text>
          )}
          <Field
            label={t("deviceNetwork.hosts")}
            help={t("deviceNetwork.hostsHelp")}
            {...(badHost !== undefined
              ? { error: t("deviceNetwork.invalidHost", { host: badHost }) }
              : {})}
          >
            <Textarea
              code
              rows={8}
              value={hostsText}
              disabled={!manage || networkOff}
              onChange={(e) => setDraft((d) => ({ ...d, hostsText: e.target.value }))}
            />
          </Field>
          {within && !networkOff && (
            <Text variant="small" tone="muted">
              {t("deviceNetwork.withinNote")}
            </Text>
          )}
          {manage && !networkOff && storedNetwork !== undefined && (
            <Stack gap={4}>
              <Text variant="prose" tone="muted">
                {t("deviceNetwork.ownNetwork")}
              </Text>
              <Stack direction="row" gap={8}>
                <Button
                  density="dense"
                  disabled={update.isPending}
                  onClick={() => setConfirmingFollow(true)}
                >
                  {t("deviceNetwork.followPlatform")}
                </Button>
              </Stack>
            </Stack>
          )}
          {confirmingFollow && (
            <Dialog
              open
              onOpenChange={(o) => {
                if (!o) setConfirmingFollow(false);
              }}
              title={t("deviceNetwork.followPlatform")}
              danger
              initialFocus="cancel"
              footer={
                <>
                  <Button variant="ghost" onClick={() => setConfirmingFollow(false)}>
                    {tc("cancel")}
                  </Button>
                  <Button
                    variant="danger-solid"
                    loading={update.isPending}
                    onClick={() => void followPlatform()}
                  >
                    {t("deviceNetwork.followPlatform")}
                  </Button>
                </>
              }
            >
              <Text variant="prose">{t("deviceNetwork.followPlatformBody")}</Text>
            </Dialog>
          )}
          {prefilled !== null && prefilled.length > 0 && (
            <Text variant="small" tone="muted">
              {t("deviceNetwork.prefilled", { hosts: prefilled.join(", ") })}
            </Text>
          )}
          <Text variant="small" tone="muted">
            {t("deviceNetwork.publicOnly")}
          </Text>
          {!manage && (
            <Text variant="small" tone="muted">
              {t("readonly")}
            </Text>
          )}
        </Stack>
      </FormSection>
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
