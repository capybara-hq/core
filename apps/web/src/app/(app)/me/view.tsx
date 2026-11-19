"use client";

import { MePanel, OverviewPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useContext } from "react";
import { MePanelsContext } from "../../../components/shell/me";
import { usePagePath } from "../../../components/shell/path";

/**
 * `/me`: the Me tab, an `OverviewPage` with the MePanel as its one body and no stat cards (design
 * spec §6.48). The panel is built by the app frame from the sidebar's own nav, org and account
 * data, so this page reads nothing.
 */
export default function MeView() {
  const panels = useContext(MePanelsContext);
  const t = useTranslations("me");
  const scope = usePagePath("org");
  if (panels === null) return null;
  return (
    <OverviewPage header={{ path: [...scope, { label: "me" }], title: t("title") }}>
      <MePanel {...panels.work} />
    </OverviewPage>
  );
}
