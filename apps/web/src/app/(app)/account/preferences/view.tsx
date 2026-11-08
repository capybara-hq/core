"use client";

import { Field, FormSection, Select, SettingsPage, useToast } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import {
  type Preferences,
  putPreferences,
  timeZoneOptions,
} from "../../../../lib/account-preferences";
import { preferencesQuery } from "../../../../lib/query/account";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { meQuery } from "../../../../lib/query/shell";
import { useErrorMessage } from "../../../../lib/use-error-message";

/** The select's value for "follow the browser" (no zone stored; never an IANA name). */
const FOLLOW = "browser";

/**
 * `/account/preferences`: the person's preferences (SettingsPage). 时区: 跟随浏览器 (the default:
 * every message sends the browser's zone) or a zone that overrides it; the agents date their
 * answers by it. Not tied to an org, only signed in. From the query cache (the layout prefetched
 * it on a first load); a save writes the answer into the cache.
 */
export default function PreferencesView() {
  const me = useQuery(meQuery()).data;
  if (me === undefined) return null;
  return <PreferencesForm accountId={me.account.id} />;
}

function PreferencesForm({ accountId }: { accountId: string }) {
  const scope = usePagePath("home");
  const t = useTranslations("preferences");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useAccountNav();
  const qc = useQueryClient();
  const read = usePageQuery(preferencesQuery(accountId));
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const update = useAppMutation({
    fn: (prefs: Partial<Preferences>) => putPreferences(prefs),
    invalidates: () => [],
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
  const dirty = value !== saved;

  async function save() {
    try {
      await update.mutateAsync({ timeZone: value === FOLLOW ? null : value });
      setDraft(undefined);
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
              unsaved: 1,
              cancel: { label: tc("cancel"), onSelect: () => setDraft(undefined) },
              primary: { label: t("save"), onSelect: () => void save(), loading: update.isPending },
            },
          }
        : {})}
    >
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
