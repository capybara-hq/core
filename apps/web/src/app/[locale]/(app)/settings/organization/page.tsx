"use client";

import {
  Field,
  FormSection,
  RadioGroup,
  Select,
  SettingsPage,
  Skeleton,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useSettingsNav } from "../../../../../components/settings-nav";
import { useSession } from "../../../../../components/shell/session";
import { ApiClientError } from "../../../../../lib/api";
import {
  canUpdateOrg,
  getOrgSettings,
  type OrgSettings,
  updateOrgSettings,
} from "../../../../../lib/org-settings";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/settings/organization`：组织设置（SettingsPage）——工具搜索开关、IM 语言（机器人固定话术的语言）、
 * 沙箱工具的默认策略（直接执行 / 需要审批）。成员可看，管理员可改；
 * 有改动时出现 ActionRow。
 */
export default function OrganizationSettingsPage() {
  return <OrgGate>{(orgId) => <OrganizationSettings key={orgId} orgId={orgId} />}</OrgGate>;
}

function OrganizationSettings({ orgId }: { orgId: string }) {
  const t = useTranslations("orgSettings");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useSettingsNav();
  const { me } = useSession();
  const manage = canUpdateOrg(me);
  const { state, set } = useLoad(() => getOrgSettings(orgId).then((r) => r.settings), [orgId]);
  const [draft, setDraft] = useState<Partial<OrgSettings>>({});
  const [pending, setPending] = useState(false);

  const saved = state.kind === "ready" ? state.data : undefined;
  const toolSearch = draft.toolSearch ?? saved?.toolSearch ?? "on";
  const locale = draft.locale ?? saved?.locale ?? "en";
  const sandboxPolicy = draft.sandboxToolPolicy ?? saved?.sandboxToolPolicy ?? "allow";
  // 只提交改过的项
  const patch: Partial<OrgSettings> =
    saved === undefined
      ? {}
      : {
          ...(toolSearch !== saved.toolSearch ? { toolSearch } : {}),
          ...(locale !== (saved.locale ?? "en") ? { locale } : {}),
          ...(sandboxPolicy !== (saved.sandboxToolPolicy ?? "allow")
            ? { sandboxToolPolicy: sandboxPolicy }
            : {}),
        };
  const unsaved = Object.keys(patch).length;
  const dirty = unsaved > 0;

  async function save() {
    setPending(true);
    try {
      const { settings } = await updateOrgSettings(orgId, patch);
      set(settings);
      setDraft({});
      toast.success(t("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsPage
      header={{ title: t("title") }}
      nav={nav}
      activeNav="organization"
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
      ) : (
        <FormSection
          id="tool-search"
          title={t("toolSearch.title")}
          description={t("toolSearch.description")}
        >
          <Stack gap={8}>
            <RadioGroup
              label={t("toolSearch.title")}
              variant="card"
              value={toolSearch}
              disabled={!manage}
              onChange={(v) =>
                setDraft((d) => ({ ...d, toolSearch: v as OrgSettings["toolSearch"] }))
              }
              options={(["on", "off"] as const).map((v) => ({
                value: v,
                label: t(`toolSearch.${v}`),
                description: t(`toolSearch.${v}Hint`),
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
      {saved !== undefined && (
        <FormSection id="im-locale" title={t("locale.title")} description={t("locale.description")}>
          <Field label={t("locale.label")}>
            <Select
              value={locale}
              disabled={!manage}
              onChange={(e) =>
                setDraft((d) => ({ ...d, locale: e.target.value as OrgSettings["locale"] }))
              }
              options={(["en", "zh"] as const).map((v) => ({
                value: v,
                label: tc(`localeName.${v}`),
              }))}
            />
          </Field>
        </FormSection>
      )}
      {saved !== undefined && (
        <FormSection
          id="sandbox-tools"
          title={t("sandbox.title")}
          description={t("sandbox.description")}
        >
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
        </FormSection>
      )}
    </SettingsPage>
  );
}
