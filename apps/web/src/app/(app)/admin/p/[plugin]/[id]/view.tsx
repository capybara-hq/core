"use client";

import { DetailPage, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { ErrorFrame } from "../../../../../../components/ErrorFrame";
import { ExtensionSlot } from "../../../../../../components/extension-ui/ExtensionSlot";
import { NoAccess } from "../../../../../../components/NoAccess";
import { usePagePath } from "../../../../../../components/shell/path";
import { usePageQuery } from "../../../../../../lib/query/page-query";
import { adminUiContributionsQuery } from "../../../../../../lib/query/ui";
import { useAdmin } from "../../../../../../lib/query/workspace";
import { type UiContributionItem, uiLocale } from "../../../../../../lib/ui";
import NotFound from "../../../../not-found";

/**
 * `/admin/p/[plugin]/[id]`: an extension's platform page (slot `platform.page`, super admins; the
 * admin sidebar lists them), DetailPage without an inspector; the body is the slot's
 * (`ExtensionSlot`, on the org-less admin routes). Like an org page: a schema view from the query
 * cache refreshed by the platform UI stream, an embed in its sandboxed iframe. An unknown page
 * says so.
 */
export default function PlatformPageView({ plugin, id }: { plugin: string; id: string }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <PlatformPageData plugin={plugin} id={id} />;
}

function PlatformPageData({ plugin, id }: { plugin: string; id: string }) {
  const scope = usePagePath("admin");
  const t = useTranslations();
  const read = usePageQuery(adminUiContributionsQuery());
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{ path: [...scope, { label: t("pluginPage.pathLabel") }], title: "" }}
        tabs={{ label: id, items: [{ id: "view", label: id }], value: "view" }}
        loading={{ blocks: 1 }}
      />
    );
  }
  const contribution = read.data.find(
    (c) => c.plugin === plugin && c.id === id && c.slot === "platform.page",
  );
  return <PlatformPage plugin={plugin} id={id} contribution={contribution} />;
}

function PlatformPage({
  plugin,
  id,
  contribution,
}: {
  plugin: string;
  id: string;
  /** Undefined when the platform has no such page. */
  contribution: UiContributionItem | undefined;
}) {
  const scope = usePagePath("admin");
  const t = useTranslations();
  const locale = uiLocale(useLocale());
  const title = contribution?.title[locale] ?? id;
  return (
    <DetailPage
      header={{ path: [...scope, { label: t("pluginPage.pathLabel") }, { label: title }], title }}
      tabs={{ label: title, items: [{ id: "view", label: title }], value: "view" }}
    >
      {contribution ? (
        <ExtensionSlot slot="platform.page" args={{}} select={{ plugin, id }} />
      ) : (
        <Text tone="muted">{t("errors.ui.not_found")}</Text>
      )}
    </DetailPage>
  );
}
