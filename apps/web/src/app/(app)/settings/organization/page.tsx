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
import { FormError } from "../../../../components/form-error";
import { RoleGate } from "../../../../components/RoleGate";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import { ApiClientError } from "../../../../lib/api";
import {
  canUpdateOrg,
  getOrgSettings,
  type OrgSettings,
  type OrgSettingsPatch,
  updateOrgSettings,
} from "../../../../lib/org-settings";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/settings/organization`：组织设置（SettingsPage）——工具搜索开关、IM 语言（机器人固定话术的语言）、
 * 沙箱的设置在 `/settings/sandbox`。
 * 成员可看，管理员可改；有改动时出现 ActionRow。
 */

export default function OrganizationSettingsPage() {
  return (
    <RoleGate min="member">
      {(orgId) => <OrganizationSettings key={orgId} orgId={orgId} />}
    </RoleGate>
  );
}

function OrganizationSettings({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("orgSettings");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useOrgSettingsNav();
  const { me } = useSession();
  const manage = canUpdateOrg(me);
  const { state, set } = useLoad(() => getOrgSettings(orgId), [orgId]);
  const [draft, setDraft] = useState<Pick<Partial<OrgSettings>, "toolSearch" | "locale">>({});
  const [pending, setPending] = useState(false);

  const saved = state.kind === "ready" ? state.data.settings : undefined;
  const toolSearch = draft.toolSearch ?? saved?.toolSearch ?? "on";
  const locale = draft.locale ?? saved?.locale ?? "en";
  // 只提交改过的项
  const patch: OrgSettingsPatch =
    saved === undefined
      ? {}
      : {
          ...(toolSearch !== saved.toolSearch ? { toolSearch } : {}),
          ...(locale !== (saved.locale ?? "en") ? { locale } : {}),
        };
  const unsaved = Object.keys(patch).length;
  const dirty = unsaved > 0;

  async function save() {
    setPending(true);
    try {
      const res = await updateOrgSettings(orgId, patch);
      // The response may leave out the read-only parts the sandbox page shows: keep the loaded ones
      if (state.kind === "ready") set({ ...state.data, ...res });
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
      header={{
        path: [
          ...scope,
          { label: "settings", href: "/settings/organization" },
          { label: "organization" },
        ],
        title: t("title"),
      }}
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
    </SettingsPage>
  );
}
