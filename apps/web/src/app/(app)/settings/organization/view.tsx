"use client";

import {
  DangerConfirm,
  DangerZone,
  DangerZoneItem,
  Field,
  FormSection,
  RadioGroup,
  Select,
  SettingsPage,
  Stack,
  Text,
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
import { navigateBrowser } from "../../../../lib/browser";
import { myRole } from "../../../../lib/members";
import {
  canUpdateOrg,
  type OrgSettings,
  type OrgSettingsPatch,
  type OrgSettingsResponse,
  updateOrgSettings,
} from "../../../../lib/org-settings";
import { deleteOrg } from "../../../../lib/orgs";
import { browserQueryClient } from "../../../../lib/query/client";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { orgSettingsQuery } from "../../../../lib/query/settings";
import { resetSession, useWorkspace } from "../../../../lib/query/workspace";
import { HOME_PATH } from "../../../../lib/routes";
import { broadcastSession } from "../../../../lib/session-sync";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/settings/organization`：组织设置（SettingsPage）——工具搜索开关、IM 语言（机器人固定话术的语言）、
 * 沙箱的设置在 `/settings/sandbox`。
 * 成员可看，管理员可改；有改动时出现 ActionRow。From the query cache (the layout prefetched it on a
 * first load); a save writes the answer into the cache (the sandbox page shares it).
 */
export default function OrganizationSettingsView() {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <OrganizationSettings orgId={ws.orgId} />;
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
  const qc = useQueryClient();
  const read = usePageQuery(orgSettingsQuery(orgId));
  const [draft, setDraft] = useState<Pick<Partial<OrgSettings>, "toolSearch" | "locale">>({});
  // The answer is the new settings: it replaces the cached ones (the response may leave out the
  // read-only parts the sandbox page shows, so the cached ones are kept).
  const update = useAppMutation({
    fn: (patch: OrgSettingsPatch) => updateOrgSettings(orgId, patch),
    invalidates: () => [],
    onSuccess: (res) =>
      qc.setQueryData<OrgSettingsResponse>(orgSettingsQuery(orgId).queryKey, (old) => ({
        ...old,
        ...res,
      })),
  });
  const header = {
    path: [
      ...scope,
      { label: "settings", href: "/settings/organization" },
      { label: "organization" },
    ],
    title: t("title"),
  };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="organization"
        // The sections say for themselves that they load: tool search (two radio cards, and the
        // read-only note for a member) and the IM locale (a select). The owner's danger zone needs
        // only the session: it renders for real.
        loading={{}}
      >
        <FormSection
          id="tool-search"
          title={t("toolSearch.title")}
          description={t("toolSearch.description")}
          loading={{ fields: [{ control: "radio-cards", options: 2, help: !manage }] }}
        />
        <FormSection
          id="im-locale"
          title={t("locale.title")}
          description={t("locale.description")}
          loading={{ fields: [{ control: "select" }] }}
        />
        {myRole(me) === "owner" ? <DeleteOrg orgId={orgId} /> : null}
      </SettingsPage>
    );
  }

  const saved = read.data.settings;
  const toolSearch = draft.toolSearch ?? saved.toolSearch ?? "on";
  const locale = draft.locale ?? saved.locale ?? "en";
  // 只提交改过的项
  const patch: OrgSettingsPatch = {
    ...(toolSearch !== saved.toolSearch ? { toolSearch } : {}),
    ...(locale !== (saved.locale ?? "en") ? { locale } : {}),
  };
  const unsaved = Object.keys(patch).length;
  const dirty = unsaved > 0;

  async function save() {
    try {
      await update.mutateAsync(patch);
      setDraft({});
      toast.success(t("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <SettingsPage
      header={header}
      nav={nav}
      activeNav="organization"
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
      {myRole(me) === "owner" ? <DeleteOrg orgId={orgId} /> : null}
    </SettingsPage>
  );
}

/**
 * 删除组织 (owners only, `org.delete`): the danger zone at the bottom of 通用, confirmed by typing
 * the org's slug; afterwards no org is current, so the org chooser opens.
 */
function DeleteOrg({ orgId }: { orgId: string }) {
  const t = useTranslations("orgLifecycle");
  const toast = useToast();
  const { me } = useSession();
  const errorMessage = useErrorMessage();
  const [open, setOpen] = useState(false);
  // The cache is dropped as a whole after it (`resetSession`): nothing to invalidate.
  const remove = useAppMutation({ fn: deleteOrg, invalidates: () => [] });
  const org = me.memberships.find((m) => m.orgId === orgId);
  if (org === undefined) return null;
  return (
    <>
      <DangerZone title={t("danger.title")}>
        <DangerZoneItem
          title={t("delete.item")}
          description={t("delete.hint")}
          action={{ label: t("delete.action"), onSelect: () => setOpen(true) }}
        />
      </DangerZone>
      <DangerConfirm
        open={open}
        onOpenChange={setOpen}
        title={t("delete.title")}
        description={t("delete.description", { name: org.name })}
        confirmName={org.slug}
        confirmLabel={t("delete.confirm")}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(orgId);
          } catch (e) {
            // DangerConfirm shows the message: the localized one, never the kernel's English
            throw new Error(errorMessage(e));
          }
          // The kernel cleared the current org with the org: a full navigation home (the org
          // chooser covers it), told to the other tabs (ruling R4). The dialog stays busy until
          // the unload.
          toast.success(t("delete.done"));
          broadcastSession("org-switched");
          // The browser's one client (the provider's): drop the old org's cache before leaving.
          await resetSession(browserQueryClient(), () => navigateBrowser(HOME_PATH));
          await new Promise<never>(() => {});
        }}
      />
    </>
  );
}
