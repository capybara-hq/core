"use client";

import {
  FormSection,
  ItemList,
  SettingsPage,
  Stack,
  SwitchField,
  SwitchList,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useComponentState, useComponentSwitch } from "../../../../components/ComponentSwitch";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import { builtinChoice, type ThemeChoice, ThemePicker } from "../../../../components/ThemePicker";
import type { OrgComponent } from "../../../../lib/components";
import {
  canUpdateOrg,
  type OrgThemeSetting,
  updateOrgSettings,
} from "../../../../lib/org-settings";
import { retryOnMountOf } from "../../../../lib/query/client";
import { orgComponentsQuery } from "../../../../lib/query/components";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { orgThemesQuery, platformThemeQuery } from "../../../../lib/query/themes";
import { useWorkspace } from "../../../../lib/query/workspace";
import { type ListedTheme, type OrgThemes, themeName } from "../../../../lib/themes";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/** The picker's value for 跟随平台 (never a theme id: those are UUIDs). */
const FOLLOW = "platform";

/**
 * `/settings/appearance`: the org's 外观 (themes spec §7, §10; SettingsPage). 主题: the themes
 * offered to the org with the org admin's switch each (the platform default theme is locked on);
 * 默认主题: 跟随平台 or a theme on in the org, and 允许成员自选 (off locks the personal picker).
 * Members read it all, without controls that act (roles everywhere). From the query cache: the
 * org's themes (the page) and the theme components (a section).
 */
export default function AppearanceSettingsView() {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <AppearanceSettings orgId={ws.orgId} />;
}

function AppearanceSettings({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("appearance");
  const nav = useOrgSettingsNav();
  const { me } = useSession();
  const admin = canUpdateOrg(me);
  const read = usePageQuery(orgThemesQuery(orgId));
  const cq = orgComponentsQuery(orgId, { kind: "theme" });
  const components = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) }).data
    ?.components;
  const header = {
    path: [
      ...scope,
      { label: "settings", href: "/settings/organization" },
      { label: "appearance" },
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
        activeNav="appearance"
        loading={{
          sections: [
            { items: [{ lines: 1 }, { lines: 1 }], title: t("themes.title") },
            {
              fields: [
                { control: "radio-cards", options: 3 },
                { control: "switch", help: true },
              ],
              title: t("org.title"),
              description: t("org.description"),
            },
          ],
        }}
      />
    );
  }
  return (
    <Appearance
      orgId={orgId}
      admin={admin}
      header={header}
      nav={nav}
      data={read.data}
      components={components}
    />
  );
}

function Appearance({
  orgId,
  admin,
  header,
  nav,
  data,
  components,
}: {
  orgId: string;
  admin: boolean;
  header: { path: { label: string; href?: string }[]; title: string };
  nav: ReturnType<typeof useOrgSettingsNav>;
  data: OrgThemes;
  components: OrgComponent[] | undefined;
}) {
  const t = useTranslations("appearance");
  const tc = useTranslations("common");
  const ts = useTranslations("orgSettings");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const stateOf = useComponentState();
  const sw = useComponentSwitch({ orgId, admin });
  const [draft, setDraft] = useState<Partial<OrgThemeSetting>>({});
  const update = useAppMutation({
    fn: (theme: OrgThemeSetting) => updateOrgSettings(orgId, { theme }),
    // the org's pickers and its resolved theme, and the settings the other pages read
    invalidates: () => [keys.org(orgId).themes(), keys.org(orgId).orgSettings()],
  });

  const byId = new Map<string, ListedTheme>(data.themes.map((x) => [x.id, x]));
  const nameOf = (id: string) => {
    const listed = byId.get(id);
    if (listed !== undefined) return themeName(listed, locale);
    return components?.find((c) => c.id === id)?.name ?? id;
  };
  const saved = data.org;
  const unavailable = saved.id !== null && !byId.has(saved.id);
  const id = draft.id !== undefined ? draft.id : saved.id;
  const personal = draft.personal ?? saved.personal;
  const dirty = id !== saved.id || personal !== saved.personal;
  // 跟随平台 draws the platform default (on in every org, so it is listed), else the built-in
  const pq = platformThemeQuery();
  const platformDefault = useQuery({ ...pq, retryOnMount: retryOnMountOf(pq.queryKey) }).data;
  const followSwatches =
    platformDefault == null ? undefined : byId.get(platformDefault.id)?.swatches;
  const choices: ThemeChoice[] = [
    followSwatches === undefined
      ? builtinChoice(FOLLOW, t("followPlatform"))
      : { value: FOLLOW, name: t("followPlatform"), swatches: followSwatches },
    ...data.themes.map((x) => ({ value: x.id, name: themeName(x, locale), swatches: x.swatches })),
  ];
  // An unavailable default is skipped (the org follows the platform): 跟随平台 is what applies
  const picked = id === null || (id === saved.id && unavailable) ? FOLLOW : id;

  async function save() {
    try {
      await update.mutateAsync({ id, personal });
      setDraft({});
      toast.success(t("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const rows = (components ?? []).filter((c) => c.kind === "theme");
  // the dialog and the toasts name the theme as the list does
  const toggle = (c: OrgComponent, next: boolean) =>
    sw
      .actionsOf({ ...c, name: c.on ? nameOf(c.id) : c.name })
      .find((a) => a.id === (next ? "enable" : "disable"))
      ?.onSelect?.();

  return (
    <SettingsPage
      header={header}
      nav={nav}
      activeNav="appearance"
      {...(admin && dirty
        ? {
            actionRow: {
              unsaved: (id !== saved.id ? 1 : 0) + (personal !== saved.personal ? 1 : 0),
              cancel: { label: tc("cancel"), onSelect: () => setDraft({}) },
              primary: { label: t("save"), onSelect: () => void save(), loading: update.isPending },
            },
          }
        : {})}
    >
      {sw.error !== undefined && <FormError message={sw.error.message} extra={sw.error.extra} />}
      <FormSection
        id="themes"
        title={t("themes.title")}
        description={t("themes.description")}
        flush
      >
        {rows.length === 0 ? (
          <ItemList label={t("themes.label")} inset="flush" empty={t("themes.empty")} />
        ) : (
          <SwitchList
            label={t("themes.label")}
            rows={rows.map((c) => {
              const state = stateOf(c);
              return {
                id: c.id,
                name: c.on ? nameOf(c.id) : c.name,
                ...(c.description !== null && c.description !== ""
                  ? { description: c.description }
                  : {}),
                meta: c.locked ? t("themes.lockedDefault") : state.label,
                checked: c.on,
                disabled: !admin || sw.busy || c.locked || !c.pluginOn || !c.switchable,
                onChange: (next: boolean) => toggle(c, next),
              };
            })}
          />
        )}
      </FormSection>
      <FormSection id="default" title={t("org.title")} description={t("org.description")}>
        <Stack gap={12}>
          {unavailable && saved.id !== null && (
            <Text tone="warn">{t("org.unavailable", { name: nameOf(saved.id) })}</Text>
          )}
          <ThemePicker
            label={t("org.label")}
            value={picked}
            choices={choices}
            disabled={!admin}
            onChange={(v) => setDraft((d) => ({ ...d, id: v === FOLLOW ? null : v }))}
          />
          <Stack gap={4}>
            <SwitchField
              label={t("org.personal")}
              checked={personal === "allowed"}
              disabled={!admin}
              onText={t("org.personalOn")}
              offText={t("org.personalOff")}
              onChange={(next) =>
                setDraft((d) => ({ ...d, personal: next ? "allowed" : "locked" }))
              }
            />
            <Text variant="prose" tone="muted">
              {t("org.personalHelp")}
            </Text>
          </Stack>
          {!admin && (
            <Text variant="small" tone="muted">
              {ts("readonly")}
            </Text>
          )}
        </Stack>
      </FormSection>
      {sw.dialog}
    </SettingsPage>
  );
}
