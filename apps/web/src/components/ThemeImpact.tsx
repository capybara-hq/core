"use client";

import type { ImpactPreviewGroup } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { ThemePreview } from "../lib/catalog";
import { componentName } from "../lib/components";
import { retryOnMountOf } from "../lib/query/client";
import { adminComponentsQuery } from "../lib/query/components";
import { orgThemesQuery } from "../lib/query/themes";
import { themeName } from "../lib/themes";

/**
 * The 主题 group of an impact preview (themes spec §6 "Losing access"): each theme a change takes
 * away, with the orgs whose default it is (they follow the platform then) and how many people
 * picked it (they get their org's default). null when the preview names no theme. `orgsText` writes
 * the org list (an owner's preview names the orgs through its `orgNames` / `hideUnknown` rules);
 * the default joins the names the kernel sent.
 */
export function useThemeImpactGroup(
  themes: readonly ThemePreview[] | undefined,
  nameOf: (id: string) => string,
  orgsText?: (orgs: readonly { orgId: string; orgName: string }[]) => string,
): ImpactPreviewGroup | null {
  const t = useTranslations("themeImpact");
  const locale = useLocale();
  if (themes === undefined || themes.length === 0) return null;
  const sep = locale === "zh" ? "、" : ", ";
  return {
    id: "themes",
    title: t("title"),
    description: t("description"),
    items: themes.map((x) => {
      const notes = [
        ...(x.orgDefaults.length > 0
          ? [
              {
                text: t("orgDefaults", {
                  orgs:
                    orgsText !== undefined
                      ? orgsText(x.orgDefaults)
                      : x.orgDefaults.map((o) => o.orgName).join(sep),
                }),
                tone: "warn" as const,
              },
            ]
          : []),
        ...(x.pickedBy > 0
          ? [{ text: t("pickedBy", { n: x.pickedBy }), tone: "warn" as const }]
          : []),
      ];
      return {
        id: x.id,
        title: nameOf(x.id),
        notes: notes.length > 0 ? notes : [{ text: t("nobody") }],
      };
    }),
  };
}

/** A theme's name by its id from the admin themes list (super admins), else the id. */
export function useAdminThemeName(): (id: string) => string {
  const locale = useLocale();
  const q = adminComponentsQuery("theme");
  const list = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) }).data?.components;
  return (id) => {
    const c = list?.find((x) => x.id === id);
    return c === undefined ? id : componentName(c, locale);
  };
}

/** A theme's name by its id from the org's themes (on there), else the id. */
export function useOrgThemeName(orgId: string): (id: string) => string {
  const locale = useLocale();
  const q = orgThemesQuery(orgId);
  const list = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) }).data?.themes;
  return (id) => {
    const x = list?.find((y) => y.id === id);
    return x === undefined ? id : themeName(x, locale);
  };
}
