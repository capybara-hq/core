"use client";

import {
  EmptyState,
  Field,
  FormSection,
  Select,
  SettingsPage,
  Stack,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { pageSections } from "../../../../components/shell/nav";
import { usePagePath } from "../../../../components/shell/path";
import {
  NAV_PRIMARY_MAX,
  type NavigationSetting,
  type OrgSettingsResponse,
  updateOrgSettings,
} from "../../../../lib/org-settings";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { orgSettingsQuery } from "../../../../lib/query/settings";
import { extensionPagesQuery } from "../../../../lib/query/shell";
import { useWorkspace } from "../../../../lib/query/workspace";
import { type UiContributionItem, uiLocale } from "../../../../lib/ui";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/settings/navigation` (SettingsPage, group Organization; org admins): the org's plugin pages
 * (slot `org.page`), each with a primary / more choice (plugin full pages spec §9). The page
 * shows what the sidebar shows (`pageSections`): a page with no saved choice follows its plugin's
 * suggestion while a primary slot is free; only the pages changed here (and the choices already
 * saved) are written, so a suggestion keeps applying until an admin chooses. At most 3 saved or
 * changed pages in primary. From the query cache (the layout prefetched both reads on a first load).
 */
export default function NavigationSettingsView() {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <NavigationSettings orgId={ws.orgId} />;
}

type Section = "primary" | "more";

function NavigationSettings({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("navSettings");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useOrgSettingsNav();
  const qc = useQueryClient();
  const locale = useLocale();
  const read = usePageQuery(orgSettingsQuery(orgId));
  const pagesQ = extensionPagesQuery(orgId);
  const pages =
    useQuery({ ...pagesQ, retryOnMount: retryOnMountOf(pagesQ.queryKey) }).data ?? NO_PAGES;
  const [draft, setDraft] = useState<Record<string, Section>>({});
  const update = useAppMutation({
    fn: (navigation: NavigationSetting) => updateOrgSettings(orgId, { navigation }),
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
      { label: "navigation" },
    ],
    title: t("title"),
    description: t("description"),
  };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="navigation"
        loading={{
          sections: [
            {
              fields: 3,
              title: t("section"),
              description: t("sectionHint"),
            },
          ],
        }}
      />
    );
  }
  const lang = uiLocale(locale);
  const savedSetting = read.data.settings.navigation ?? undefined;
  const keyOf = (p: { plugin: string; id: string }) => `${p.plugin}/${p.id}`;
  const listed = new Set(pages.map(keyOf));
  // the saved choices of pages still listed (a stale one for a removed page would count toward
  // the limit unseen)
  const saved = new Map(
    (savedSetting?.pluginPages ?? [])
      .filter((e) => listed.has(e.contribution))
      .map((e) => [e.contribution, e.section]),
  );
  // what the sidebar shows now: the baseline a change is measured against
  const baseline = new Map(
    pageSections(pages, savedSetting).map((s, i) => [keyOf(pages[i] as UiContributionItem), s]),
  );
  // the explicit choices once saved: the saved ones, the drafts replacing or joining them
  const explicit = new Map(saved);
  for (const [k, v] of Object.entries(draft)) if (listed.has(k)) explicit.set(k, v);
  // a page without an explicit choice follows its suggestion while a primary slot is free, as the
  // sidebar will after the save
  const projected = pageSections(pages, {
    pluginPages: [...explicit].map(([contribution, section]) => ({ contribution, section })),
  });
  const wanted = (p: (typeof pages)[number]): Section =>
    explicit.get(keyOf(p)) ?? projected[pages.indexOf(p)] ?? "more";
  // only explicit primaries count toward the limit: suggestions fill what is left
  const primaryCount = [...explicit.values()].filter((v) => v === "primary").length;
  const tooMany = primaryCount > NAV_PRIMARY_MAX;
  const unsaved = Object.entries(draft).filter(
    ([k, v]) => listed.has(k) && v !== (saved.get(k) ?? baseline.get(k)),
  ).length;

  async function save() {
    if (tooMany) return;
    try {
      await update.mutateAsync({
        pluginPages: [...explicit].map(([contribution, section]) => ({ contribution, section })),
      });
      setDraft({});
      toast.success(t("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const sectionLabel = (s: Section) => t(s);
  const labelOf = (p: (typeof pages)[number]) => {
    const title = p.title[lang];
    return pages.filter((x) => x.title[lang] === title).length > 1
      ? `${title} · ${p.plugin}`
      : title;
  };
  return (
    <SettingsPage
      header={header}
      nav={nav}
      activeNav="navigation"
      {...(unsaved > 0
        ? {
            actionRow: {
              unsaved,
              errors: tooMany ? 1 : 0,
              cancel: { label: tc("cancel"), onSelect: () => setDraft({}) },
              primary: {
                label: t("save"),
                onSelect: () => void save(),
                loading: update.isPending,
                disabled: tooMany,
              },
            },
          }
        : {})}
    >
      <FormSection id="navigation-pages" title={t("section")} description={t("sectionHint")}>
        {pages.length === 0 ? (
          <EmptyState size="panel" text={t("empty")} hint={t("emptyHint")} />
        ) : (
          <Stack gap={12}>
            {pages.map((p) => (
              <Field
                key={keyOf(p)}
                label={labelOf(p)}
                {...(p.nav !== undefined && !saved.has(keyOf(p))
                  ? { help: t("suggested", { section: sectionLabel(p.nav) }) }
                  : {})}
                {...(tooMany && explicit.get(keyOf(p)) === "primary" ? { error: t("limit") } : {})}
              >
                <Select
                  name={keyOf(p)}
                  value={wanted(p)}
                  options={(["primary", "more"] as const).map((s) => ({
                    value: s,
                    label: sectionLabel(s),
                  }))}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [keyOf(p)]: e.target.value as Section }))
                  }
                />
              </Field>
            ))}
          </Stack>
        )}
      </FormSection>
    </SettingsPage>
  );
}

const NO_PAGES: UiContributionItem[] = [];
