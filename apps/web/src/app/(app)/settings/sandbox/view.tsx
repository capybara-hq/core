"use client";

import {
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
import { allowHostProblem } from "../../../../lib/network-hosts";
import {
  type CloudNetworkSetting,
  canUpdateOrg,
  type OrgSettings,
  type OrgSettingsPatch,
  type OrgSettingsResponse,
  parseHostList,
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
 * sandbox tools (run directly / ask for approval), the org's auto-mode switch (auto mode spec §4.3:
 * the org may follow the platform or turn it off; 「平台未开放」 when the platform turned it off)
 * and the network of its cloud devices in sandbox mode (开放挡内网 / an allowlist whose hosts default
 * to the platform's list), plus the sandbox resources (cpu / memory, read-only: super admins
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
    autoMode?: "allowed" | "off";
    cloudMode?: CloudNetworkSetting["mode"];
    hostsText?: string;
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
  // `?allowHost=`: once the settings are in, an org admin's draft becomes an allowlist with the
  // hosts appended (those not listed yet); nothing is saved until the person saves.
  const [prefilled, setPrefilled] = useState<string[] | null>(null);
  const loaded = read.kind === "ready" ? read.data : null;
  useEffect(() => {
    if (prefilled !== null || loaded === null || !manage || allowHosts.length === 0) return;
    const platformNetwork = loaded.deployment?.cloudNetwork;
    // the kernel always answers with the deployment defaults; no list to add to without them
    if (platformNetwork === undefined) return;
    // no list to add to: the platform turned the network off
    if (platformNetwork.mode === "allowlist") return;
    const own = loaded.settings.cloudNetwork;
    const base = own?.allowHosts ?? platformNetwork.allowHosts;
    const added = allowHosts.filter((h) => !base.includes(h));
    if (added.length === 0) {
      setPrefilled([]);
      return;
    }
    setPrefilled(added);
    setDraft((d) => ({
      ...d,
      cloudMode: "allowlist",
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
        // auto mode (two cards), the cloud network (two cards and the host list) and the resources
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
              title: t("autoMode.title"),
              description: t("autoMode.description"),
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
  const deployment = data.deployment;
  if (deployment === undefined) {
    return (
      <ErrorFrame
        reset={() => void qc.invalidateQueries({ queryKey: orgSettingsQuery(orgId).queryKey })}
      />
    );
  }
  const { sandboxLimits } = data;
  const sandboxPolicy = draft.sandboxToolPolicy ?? saved?.sandboxToolPolicy ?? "allow";
  // The auto-mode switch: the platform's answer wins; the org may narrow it, never widen it
  const platformOff = deployment.autoMode.mode === "off";
  const savedAutoMode: "allowed" | "off" = platformOff
    ? "off"
    : (saved.autoMode ?? deployment.autoMode.mode);
  const autoMode = platformOff ? "off" : (draft.autoMode ?? savedAutoMode);
  const autoChanged =
    !platformOff && draft.autoMode !== undefined && draft.autoMode !== savedAutoMode;
  // The cloud-device network (sandbox mode): absent follows the platform's default; the platform's
  // kill switch forces an empty allowlist and cannot be reopened here.
  const platformNetwork = deployment.cloudNetwork;
  const networkOff = platformNetwork.mode === "allowlist";
  const savedCloudMode: CloudNetworkSetting["mode"] = networkOff
    ? "allowlist"
    : (saved.cloudNetwork?.mode ?? platformNetwork.mode);
  const cloudMode = networkOff ? "allowlist" : (draft.cloudMode ?? savedCloudMode);
  const baseHosts = saved.cloudNetwork?.allowHosts ?? platformNetwork.allowHosts;
  const hostsText = draft.hostsText ?? baseHosts.join("\n");
  const hosts = parseHostList(hostsText);
  const badHost = hosts.find((h) => allowHostProblem(h, { wildcard: true }) !== null);
  const hostsInvalid = badHost !== undefined || hosts.length > 200;
  const cloudChanged =
    cloudMode !== savedCloudMode ||
    (cloudMode === "allowlist" && draft.hostsText !== undefined && !sameList(hosts, baseHosts));
  const cloudValue: CloudNetworkSetting =
    cloudMode === "open" ? { mode: "open" } : { mode: "allowlist", allowHosts: hosts };
  // Only the changed fields
  const patch: OrgSettingsPatch = {
    ...(autoChanged && draft.autoMode !== undefined ? { autoMode: draft.autoMode } : {}),
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
        id="auto-mode"
        title={t("autoMode.title")}
        description={t("autoMode.description")}
      >
        <Stack gap={8}>
          <RadioGroup
            label={t("autoMode.title")}
            variant="card"
            value={autoMode}
            disabled={!manage || platformOff}
            onChange={(v) => setDraft((d) => ({ ...d, autoMode: v as "allowed" | "off" }))}
            options={(["allowed", "off"] as const).map((v) => {
              const closed = v === "allowed" && platformOff;
              return {
                value: v,
                label: t(`autoMode.${v}`),
                description: closed ? t("autoMode.platformClosed") : t(`autoMode.${v}Hint`),
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
              setDraft((d) => ({ ...d, cloudMode: v as CloudNetworkSetting["mode"] }))
            }
            options={(["open", "allowlist"] as const).map((v) => ({
              value: v,
              label: t(`cloudNetwork.${v}`),
              description: t(`cloudNetwork.${v}Hint`),
            }))}
          />
          {networkOff && (
            <Text variant="small" tone="muted">
              {t("cloudNetwork.platformClosed")}
            </Text>
          )}{" "}
          {cloudMode === "allowlist" && (
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
