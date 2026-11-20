"use client";

import { MePanel, type MePanelProps, OverviewPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { createContext, useContext } from "react";
import { usePagePath } from "./path";

/**
 * What the Me page draws, built by the app frame from the sidebar's own data (design spec §6.48):
 * the work context's panel, and the admin context's for a super admin (the compact class's admin
 * navigation: `/admin` shows it in place of the console's overview).
 */
export type MePanels = { work: MePanelProps; admin: MePanelProps | null };

export const MePanelsContext = createContext<MePanels | null>(null);

/**
 * The admin context's Me page (the compact class draws it for `/admin`, where the console has no
 * overview page of its own): the same MePanel from the admin context's nav data.
 */
export function AdminMePage() {
  const panels = useContext(MePanelsContext);
  const t = useTranslations("me");
  const scope = usePagePath("admin");
  if (panels?.admin == null) return null;
  return (
    <OverviewPage header={{ path: scope, title: t("adminTitle") }}>
      <MePanel {...panels.admin} />
    </OverviewPage>
  );
}
