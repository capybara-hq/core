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
  type CloudNetworkSetting,
  canUpdateOrg,
  cloudNetworkToSave,
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
 * sandbox tools (run directly / ask for approval), the org's Full permission switch (`fullAccess`:
 * the org may follow the platform or turn it off; 「平台未开放」 when the platform turned it off)
 * and its sandbox network (egress ceiling spec §D4): the cloud mode (开放挡内网 / allowlist) and the
 * host editor, shown in both modes because the hosts are also the ceiling of every local device in
 * sandbox mode; it starts from the effective hosts and saves a delta over the platform's list. The
 * kill switch makes both read-only; the platform ceiling (`within`) disables the open mode. An org
 * with a stored network gets 跟随平台 (after a confirmation: `cloudNetwork: null`, which drops its
 * own additions and removals; spec §D5: how an org migrated to base none re-attaches). Plus
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
    fullAccess?: "allowed" | "off";
    cloudMode?: NonNullable<CloudNetworkSetting["mode"]>;
    hostsText?: string;
  }>({});
  // The answer is the new settings; the read-only parts it leaves out keep their cached values.
  const update = useAppMutation({
    fn: (patch: OrgSettingsPatch) => updateOrgSettings(orgId, patch),
    // Full access and the cloud network change every device's effective Full access and network
    invalidates: (patch) =>
      patch.fullAccess !== undefined || patch.cloudNetwork !== undefined
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
  // (those not listed yet); the mode is left alone; nothing is saved until the person saves.
  const [prefilled, setPrefilled] = useState<string[] | null>(null);
  const [confirmingFollow, setConfirmingFollow] = useState(false);
  const loaded = read.kind === "ready" ? read.data : null;
  useEffect(() => {
    if (prefilled !== null || loaded === null || !manage || allowHosts.length === 0) return;
    const platformNetwork = loaded.deployment?.cloudNetwork;
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
        // Full access (two cards), the cloud network (two cards and the host list) and the resources
        // (three rows and the same note).
        loading={{
          sections: [
            {
              fields: [{ control: "radio-cards", options: 2, help: !manage }],
              title: t("sandbox.title"),
              description: t("sandbox.description"),
            },
            {
              fields: [{ control: "radio-cards", options: 2 }],
              title: t("fullAccess.title"),
              description: t("fullAccess.description"),
            },
            {
              fields: [
                { control: "radio-cards", options: 2 },
                { control: "textarea", rows: 8 },
              ],
              title: t("cloudNetwork.title"),
              description: t("cloudNetwork.description"),
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
  // The Full permission switch: the platform's answer wins; the org may narrow it, never widen it
  const platformOff = deployment.fullAccess.permission === "off";
  const savedFullAccess: "allowed" | "off" = platformOff
    ? "off"
    : (saved.fullAccess ?? deployment.fullAccess.permission);
  const fullAccess = platformOff ? "off" : (draft.fullAccess ?? savedFullAccess);
  const fullChanged =
    !platformOff && draft.fullAccess !== undefined && draft.fullAccess !== savedFullAccess;
  // The sandbox network (egress ceiling spec §D4): the page shows the effective mode and hosts. The
  // kill switch (`off`) makes it read-only and it is never sent; the ceiling (`within`) forces the
  // allowlist, so the open choice is disabled. A host outside the ceiling is the kernel's to refuse.
  const platformNetwork = deployment.cloudNetwork;
  const networkOff = platformNetwork.off;
  const within = platformNetwork.orgHosts === "within";
  const savedCloudMode = effectiveNetwork.mode;
  const cloudMode = networkOff ? "allowlist" : (draft.cloudMode ?? savedCloudMode);
  const modeChanged = !networkOff && cloudMode !== savedCloudMode;
  const baseHosts = effectiveNetwork.hosts;
  const hostsText = draft.hostsText ?? baseHosts.join("\n");
  const hosts = parseHostList(hostsText);
  const hostsChanged = !networkOff && draft.hostsText !== undefined && !sameList(hosts, baseHosts);
  const cloudChanged = modeChanged || hostsChanged;
  // PATCH replaces the stored value whole: the stored value with the edited fields changed
  const cloudValue = cloudNetworkToSave(
    saved.cloudNetwork,
    platformNetwork.allowHosts,
    hosts,
    modeChanged ? cloudMode : undefined,
  );
  const badHost = networkOff
    ? undefined
    : hosts.find((h) => allowHostProblem(h, { wildcard: true }) !== null);
  const hostsInvalid =
    badHost !== undefined ||
    (cloudValue.extraHosts?.length ?? 0) > 200 ||
    (cloudValue.excludedHosts?.length ?? 0) > 200;
  // Only the changed fields
  const patch: OrgSettingsPatch = {
    ...(fullChanged && draft.fullAccess !== undefined ? { fullAccess: draft.fullAccess } : {}),
    ...(cloudChanged ? { cloudNetwork: cloudValue } : {}),
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
      await update.mutateAsync({ cloudNetwork: null });
      setDraft(({ cloudMode: _m, hostsText: _h, ...rest }) => rest);
      setPrefilled([]);
      setConfirmingFollow(false);
      toast.success(t("cloudNetwork.followPlatformDone"));
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
        return t("cloudNetwork.outsideCeiling", { hosts: d.hosts.join(", ") });
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
        id="full-access"
        title={t("fullAccess.title")}
        description={t("fullAccess.description")}
      >
        <Stack gap={8}>
          <RadioGroup
            label={t("fullAccess.title")}
            variant="card"
            value={fullAccess}
            disabled={!manage || platformOff}
            onChange={(v) => setDraft((d) => ({ ...d, fullAccess: v as "allowed" | "off" }))}
            options={(["allowed", "off"] as const).map((v) => {
              const closed = v === "allowed" && platformOff;
              return {
                value: v,
                label: t(`fullAccess.${v}`),
                description: closed ? t("fullAccess.platformClosed") : t(`fullAccess.${v}Hint`),
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
        id="cloud-network"
        title={t("cloudNetwork.title")}
        description={t("cloudNetwork.description")}
      >
        <Stack gap={8}>
          <RadioGroup
            label={t("cloudNetwork.title")}
            variant="card"
            value={cloudMode}
            disabled={!manage || networkOff}
            onChange={(v) =>
              setDraft((d) => ({
                ...d,
                cloudMode: v as NonNullable<CloudNetworkSetting["mode"]>,
              }))
            }
            options={(["open", "allowlist"] as const).map((v) => {
              const closed = v === "open" && within && !networkOff;
              return {
                value: v,
                label: t(`cloudNetwork.${v}`),
                description: closed ? t("cloudNetwork.withinClosed") : t(`cloudNetwork.${v}Hint`),
                ...(closed ? { disabled: true } : {}),
              };
            })}
          />
          {networkOff && (
            <Text variant="small" tone="muted">
              {t("cloudNetwork.platformClosed")}
            </Text>
          )}
          <Field
            label={t("cloudNetwork.hosts")}
            help={t("cloudNetwork.hostsHelp")}
            {...(badHost !== undefined
              ? { error: t("cloudNetwork.invalidHost", { host: badHost }) }
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
          {manage && !networkOff && saved.cloudNetwork !== undefined && (
            <Stack gap={4}>
              <Text variant="prose" tone="muted">
                {t("cloudNetwork.ownNetwork")}
              </Text>
              <Stack direction="row" gap={8}>
                <Button
                  density="dense"
                  disabled={update.isPending}
                  onClick={() => setConfirmingFollow(true)}
                >
                  {t("cloudNetwork.followPlatform")}
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
              title={t("cloudNetwork.followPlatform")}
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
                    {t("cloudNetwork.followPlatform")}
                  </Button>
                </>
              }
            >
              <Text variant="prose">{t("cloudNetwork.followPlatformBody")}</Text>
            </Dialog>
          )}
          {prefilled !== null && prefilled.length > 0 && (
            <Text variant="small" tone="muted">
              {t("cloudNetwork.prefilled", { hosts: prefilled.join(", ") })}
            </Text>
          )}
          <Text variant="small" tone="muted">
            {t("cloudNetwork.publicOnly")}
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
