"use client";

import {
  Field,
  FormSection,
  Select,
  SettingsPage,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { builtinChoice, type ThemeChoice, ThemePicker } from "../../../../components/ThemePicker";
import {
  type Preferences,
  putPreferences,
  timeZoneOptions,
} from "../../../../lib/account-preferences";
import { preferencesQuery } from "../../../../lib/query/account";
import { retryOnMountOf } from "../../../../lib/query/client";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { meQuery } from "../../../../lib/query/shell";
import { orgThemesQuery, platformThemeQuery } from "../../../../lib/query/themes";
import { type OrgThemes, themeName } from "../../../../lib/themes";
import { useErrorMessage } from "../../../../lib/use-error-message";

/** The select's value for "follow the browser" (no zone stored; never an IANA name). */
const FOLLOW = "browser";

/** The theme picker's value for 默认 (follow the org; never a theme id). */
const DEFAULT_THEME = "default";

/** 外观's loading shape: a row of theme cards. */
const THEME_CARDS = [{ control: "radio-cards" as const, options: 3 }];

/**
 * `/account/preferences`: the person's preferences (SettingsPage). 外观 (themes spec §7, §10): 默认
 * (follow the org) or a theme on in the current org, one pick for every org; hidden when the org
 * locks it, with one line saying the org sets it. 时区: 跟随浏览器 (the default: every message sends
 * the browser's zone) or a zone that overrides it; the agents date their answers by it. Not tied to
 * an org, only signed in (外观 needs a current org). From the query cache (the layout prefetched
 * it on a first load); a save writes the answer into the cache.
 */
export default function PreferencesView() {
  const me = useQuery(meQuery()).data;
  if (me === undefined) return null;
  return <PreferencesForm accountId={me.account.id} orgId={me.currentOrgId} />;
}

function PreferencesForm({ accountId, orgId }: { accountId: string; orgId: string | null }) {
  const scope = usePagePath("home");
  const t = useTranslations("preferences");
  const ta = useTranslations("appearance.personal");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useAccountNav();
  const qc = useQueryClient();
  const read = usePageQuery(preferencesQuery(accountId));
  const tq = orgThemesQuery(orgId ?? "");
  const themes = useQuery({
    ...tq,
    enabled: orgId !== null,
    retryOnMount: retryOnMountOf(tq.queryKey),
  }).data;
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [themeDraft, setThemeDraft] = useState<string | null | undefined>(undefined);
  const update = useAppMutation({
    fn: (prefs: Partial<Preferences>) => putPreferences(prefs),
    // a theme pick changes the current org's resolved theme (the page repaints with it)
    invalidates: (prefs) =>
      prefs.theme !== undefined && orgId !== null ? [keys.org(orgId).themes()] : [],
    onSuccess: (res) => qc.setQueryData(preferencesQuery(accountId).queryKey, res),
  });
  const header = {
    path: [...scope, { label: "account", href: "/account/connections" }, { label: "preferences" }],
    title: t("title"),
  };
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading" || read.kind === "notFound") {
    return (
      <SettingsPage header={header} nav={nav} activeNav="preferences" loading={{}}>
        {orgId !== null && (
          <FormSection
            id="appearance"
            title={ta("title")}
            description={ta("description")}
            loading={{ fields: THEME_CARDS }}
          />
        )}
        <FormSection
          id="time-zone"
          title={t("timeZone.title")}
          description={t("timeZone.description")}
          loading={{ fields: [{ control: "select", help: true }] }}
        />
      </SettingsPage>
    );
  }
  const saved = read.data.timeZone ?? FOLLOW;
  const value = draft ?? saved;
  const savedTheme = read.data.theme ?? null;
  const theme = themeDraft !== undefined ? themeDraft : savedTheme;
  const zoneDirty = value !== saved;
  const themeDirty = theme !== savedTheme;
  const dirty = zoneDirty || themeDirty;

  async function save() {
    try {
      await update.mutateAsync({
        ...(zoneDirty ? { timeZone: value === FOLLOW ? null : value } : {}),
        ...(themeDirty ? { theme } : {}),
      });
      setDraft(undefined);
      setThemeDraft(undefined);
      toast.success(t("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <SettingsPage
      header={header}
      nav={nav}
      activeNav="preferences"
      {...(dirty
        ? {
            actionRow: {
              unsaved: (zoneDirty ? 1 : 0) + (themeDirty ? 1 : 0),
              cancel: {
                label: tc("cancel"),
                onSelect: () => {
                  setDraft(undefined);
                  setThemeDraft(undefined);
                },
              },
              primary: { label: t("save"), onSelect: () => void save(), loading: update.isPending },
            },
          }
        : {})}
    >
      {orgId !== null && <ThemeSection themes={themes} value={theme} onChange={setThemeDraft} />}
      <FormSection
        id="time-zone"
        title={t("timeZone.title")}
        description={t("timeZone.description")}
      >
        <Field label={t("timeZone.label")} help={t("timeZone.help")}>
          <Select
            name="timeZone"
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            options={[
              { value: FOLLOW, label: t("timeZone.follow") },
              ...timeZoneOptions(read.data.timeZone),
            ]}
          />
        </Field>
      </FormSection>
    </SettingsPage>
  );
}

/**
 * 外观: the person's theme cards (默认 first: the org's default applies), or the org's lock line.
 * A pick not on in this org is shown as 默认 with a line saying so (the kernel skips it).
 */
function ThemeSection({
  themes,
  value,
  onChange,
}: {
  /** The current org's themes; undefined while they load. */
  themes: OrgThemes | undefined;
  value: string | null;
  onChange(v: string | null): void;
}) {
  const t = useTranslations("appearance.personal");
  const locale = useLocale();
  const pq = platformThemeQuery();
  const platformDefault = useQuery({ ...pq, retryOnMount: retryOnMountOf(pq.queryKey) }).data;
  if (themes === undefined) {
    return (
      <FormSection
        id="appearance"
        title={t("title")}
        description={t("description")}
        loading={{ fields: THEME_CARDS }}
      />
    );
  }
  const locked = themes.org.personal === "locked";
  const listed = value === null || themes.themes.some((x) => x.id === value);
  // 默认 is what the org gives: its default when on, else the platform default, else the built-in
  const orgDefault =
    themes.themes.find((x) => x.id === themes.org.id) ??
    (platformDefault == null ? undefined : themes.themes.find((x) => x.id === platformDefault.id));
  const choices: ThemeChoice[] = [
    orgDefault === undefined
      ? builtinChoice(DEFAULT_THEME, t("default"))
      : { value: DEFAULT_THEME, name: t("default"), swatches: orgDefault.swatches },
    ...themes.themes.map((x) => ({
      value: x.id,
      name: themeName(x, locale),
      swatches: x.swatches,
    })),
  ];
  return (
    <FormSection id="appearance" title={t("title")} description={t("description")}>
      {locked ? (
        <Text variant="prose" tone="muted">
          {t("locked")}
        </Text>
      ) : (
        <Stack gap={12}>
          {!listed && <Text tone="warn">{t("unavailable")}</Text>}
          <ThemePicker
            label={t("label")}
            value={value === null || !listed ? DEFAULT_THEME : value}
            choices={choices}
            onChange={(v) => onChange(v === DEFAULT_THEME ? null : v)}
          />
        </Stack>
      )}
    </FormSection>
  );
}
