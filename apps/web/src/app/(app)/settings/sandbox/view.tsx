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
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import {
  canUpdateOrg,
  type OrgSettings,
  type OrgSettingsPatch,
  type OrgSettingsResponse,
  parseHostList,
  type SandboxEgressSetting,
  updateOrgSettings,
} from "../../../../lib/org-settings";
import { useAppMutation } from "../../../../lib/query/define";
import { usePageQuery } from "../../../../lib/query/page-query";
import { orgSettingsQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/settings/sandbox`: the organization's sandbox settings (SettingsPage): the default policy of the
 * sandbox tools (run directly / ask for approval), sandbox egress (follow the deployment / custom
 * allowlist / no network, ruling M19) and sandbox resources (cpu / memory, read-only: enterprise
 * admins override them per organization in the deployment settings, C19). Members can see, admins
 * can change; changes show an ActionRow. The org-settings PATCH is shared with the general page:
 * this page sends only its own fields. From the query cache (the layout prefetched it on a first
 * load; the general page shares it); a save writes the answer into the cache.
 */

type EgressMode = "default" | SandboxEgressSetting["mode"];

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export default function SandboxSettingsView() {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <SandboxSettings orgId={ws.orgId} />;
}

function SandboxSettings({ orgId }: { orgId: string }) {
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
    egressMode?: EgressMode;
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
        // The tool policy (two cards); egress and resources come with the settings.
        loading={{
          sections: [
            { fields: 2, title: t("sandbox.title"), description: t("sandbox.description") },
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
  // Only the changed fields
  const patch: OrgSettingsPatch = {
    ...(sandboxPolicy !== (saved.sandboxToolPolicy ?? "allow")
      ? { sandboxToolPolicy: sandboxPolicy }
      : {}),
    ...(egressChanged ? { sandboxEgress: egressValue } : {}),
  };
  const unsaved = Object.keys(patch).length;
  const dirty = unsaved > 0;

  async function save() {
    try {
      await update.mutateAsync(patch);
      setDraft({});
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
              cancel: { label: tc("cancel"), onSelect: () => setDraft({}) },
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
