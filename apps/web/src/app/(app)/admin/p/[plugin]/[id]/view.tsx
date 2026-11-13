"use client";

import { DetailPage, Text } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { ErrorFrame } from "../../../../../../components/ErrorFrame";
import { ExtensionSlot } from "../../../../../../components/extension-ui/ExtensionSlot";
import { NoAccess } from "../../../../../../components/NoAccess";
import { usePagePath } from "../../../../../../components/shell/path";
import { retryOnMountOf } from "../../../../../../lib/query/client";
import { usePageQuery } from "../../../../../../lib/query/page-query";
import { adminUiArrangementQuery, adminUiContributionsQuery } from "../../../../../../lib/query/ui";
import { useAdmin } from "../../../../../../lib/query/workspace";
import {
  type UiArrangementListSlot,
  type UiContributionItem,
  uiLocale,
} from "../../../../../../lib/ui";
import NotFound from "../../../../not-found";

/**
 * `/admin/p/[plugin]/[id]`: an extension's platform page (slot `platform.page`, super admins; the
 * admin sidebar lists them), DetailPage without an inspector; the body is the slot's
 * (`ExtensionSlot`, on the org-less admin routes). Like an org page: a schema view from the query
 * cache refreshed by the platform UI stream, an embed in its sandboxed iframe. A page the platform
 * arrangement hides still renders by its direct URL; an unknown page says so.
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
        loading={{ blocks: 1 }}
      />
    );
  }
  const listed = read.data.find(
    (c) => c.plugin === plugin && c.id === id && c.slot === "platform.page",
  );
  return <PlatformPageHidden plugin={plugin} id={id} listed={listed} />;
}

/**
 * A page the contributions list leaves out may be one the platform arrangement hides: hidden means
 * not listed, so the direct URL still renders it (the arrangement listing names it with its hidden
 * flag). Read only then; the org page's twin.
 */
function PlatformPageHidden({
  plugin,
  id,
  listed,
}: {
  plugin: string;
  id: string;
  listed: UiContributionItem | undefined;
}) {
  const q = adminUiArrangementQuery();
  const arrangement = useQuery({
    ...q,
    enabled: listed === undefined,
    retryOnMount: retryOnMountOf(q.queryKey),
  });
  // A 404 is final: the designed not-found, no further read.
  if (listed === undefined && arrangement.error?.status === 404) return <NotFound />;
  if (listed === undefined && arrangement.data === undefined && arrangement.error === null) {
    return null;
  }
  const hidden = listed
    ? undefined
    : arrangement.data
        ?.find((s): s is UiArrangementListSlot => s.slot === "platform.page" && "items" in s)
        ?.items.find((c) => c.plugin === plugin && c.id === id && c.hidden);
  return (
    <PlatformPage
      plugin={plugin}
      id={id}
      contribution={listed ?? hidden}
      direct={hidden !== undefined}
    />
  );
}

function PlatformPage({
  plugin,
  id,
  contribution,
  direct,
}: {
  plugin: string;
  id: string;
  /** Undefined when the platform has no such page. */
  contribution: UiContributionItem | undefined;
  /** The page is hidden from the lists: the slot gets it as `args.direct`. */
  direct: boolean;
}) {
  const scope = usePagePath("admin");
  const t = useTranslations();
  const locale = uiLocale(useLocale());
  const title = contribution?.title[locale] ?? id;
  return (
    <DetailPage
      header={{ path: [...scope, { label: t("pluginPage.pathLabel") }, { label: title }], title }}
    >
      {contribution ? (
        <ExtensionSlot
          slot="platform.page"
          args={direct ? { direct: contribution } : {}}
          select={{ plugin, id }}
        />
      ) : (
        <Text tone="muted">{t("errors.ui.not_found")}</Text>
      )}
    </DetailPage>
  );
}
