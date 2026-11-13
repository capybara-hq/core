"use client";

import { DetailPage, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type UiContributionItem, uiLocale } from "../../lib/ui";
import { usePagePath } from "../shell/path";
import { ExtensionSlot } from "./ExtensionSlot";

/**
 * An extension's org page (`/p/<plugin>/<id>`, and `/p/<plugin>` for a plugin with one page): the
 * page template with the page's title as its head, the body the slot's (`ExtensionSlot`). No tabs:
 * one page is one view (a single tab is a control that does nothing).
 */
export function PluginPage({
  orgId,
  plugin,
  id,
  contribution,
  direct,
}: {
  orgId: string;
  plugin: string;
  id: string;
  /** Undefined when the org has no such page. */
  contribution: UiContributionItem | undefined;
  /** The page is hidden from the lists: the slot gets it as `args.direct`. */
  direct: boolean;
}) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const locale = uiLocale(useLocale());
  const title = contribution?.title[locale] ?? id;
  return (
    <DetailPage
      header={{ path: [...scope, { label: t("pluginPage.pathLabel") }, { label: title }], title }}
    >
      {contribution ? (
        <ExtensionSlot
          slot="org.page"
          args={{ orgId, ...(direct ? { direct: contribution } : {}) }}
          select={{ plugin, id }}
        />
      ) : (
        <Text tone="muted">{t("errors.ui.not_found")}</Text>
      )}
    </DetailPage>
  );
}
