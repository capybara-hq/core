"use client";

import {
  Field,
  FormSection,
  KeyValue,
  RadioGroup,
  SettingsPage,
  Skeleton,
  Stack,
  Text,
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../components/form-error";
import { OrgGate } from "../../../../components/OrgGate";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import { ApiClientError } from "../../../../lib/api";
import {
  canUpdateOrg,
  getOrgSettings,
  type OrgSettings,
  type OrgSettingsPatch,
  parseHostList,
  type SandboxEgressSetting,
  updateOrgSettings,
} from "../../../../lib/org-settings";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/settings/sandbox`: the organization's sandbox settings (SettingsPage): the default policy of the
 * sandbox tools (run directly / ask for approval), sandbox egress (follow the deployment / custom
 * allowlist / no network, ruling M19) and sandbox resources (cpu / memory, read-only: enterprise
 * admins override them per organization in the deployment settings, C19). Members can see, admins
 * can change; changes show an ActionRow. The org-settings PATCH is shared with the general page:
 * this page sends only its own fields.
 */

type EgressMode = "default" | SandboxEgressSetting["mode"];

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export default function SandboxSettingsPage() {
  return <OrgGate>{(orgId) => <SandboxSettings key={orgId} orgId={orgId} />}</OrgGate>;
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
  const { state, set } = useLoad(() => getOrgSettings(orgId), [orgId]);
  const [draft, setDraft] = useState<{
    sandboxToolPolicy?: NonNullable<OrgSettings["sandboxToolPolicy"]>;
    egressMode?: EgressMode;
    hostsText?: string;
  }>({});
  const [pending, setPending] = useState(false);

  const saved = state.kind === "ready" ? state.data.settings : undefined;
  const deployment = state.kind === "ready" ? state.data.deployment : undefined;
  const sandboxLimits = state.kind === "ready" ? state.data.sandboxLimits : undefined;
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
  const patch: OrgSettingsPatch =
    saved === undefined
      ? {}
      : {
          ...(sandboxPolicy !== (saved.sandboxToolPolicy ?? "allow")
            ? { sandboxToolPolicy: sandboxPolicy }
            : {}),
          ...(egressChanged ? { sandboxEgress: egressValue } : {}),
        };
  const unsaved = Object.keys(patch).length;
  const dirty = unsaved > 0;

  async function save() {
    setPending(true);
    try {
      const res = await updateOrgSettings(orgId, patch);
      const dep = res.deployment ?? deployment;
      const lim = res.sandboxLimits ?? sandboxLimits;
      set({
        settings: res.settings,
        ...(dep !== undefined ? { deployment: dep } : {}),
        ...(lim !== undefined ? { sandboxLimits: lim } : {}),
      });
      setDraft({});
      toast.success(ts("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsPage
      header={{
        path: [
          ...scope,
          { label: "settings", href: "/settings/organization" },
          { label: "sandbox" },
        ],
        title: ts("title"),
      }}
      nav={nav}
      activeNav="sandbox"
      {...(dirty
        ? {
            actionRow: {
              unsaved,
              cancel: { label: tc("cancel"), onSelect: () => setDraft({}) },
              primary: { label: t("save"), onSelect: () => void save(), loading: pending },
            },
          }
        : {})}
    >
      {state.kind === "loading" ? (
        <Skeleton rows={3} />
      ) : state.kind === "error" ? (
        <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />
      ) : null}
      {saved !== undefined && (
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
      )}
      {saved !== undefined && deployment !== undefined && (
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
      {saved !== undefined && sandboxLimits !== undefined && (
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
