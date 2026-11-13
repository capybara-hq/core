"use client";

import { DetailPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { PluginPage } from "../../../../components/extension-ui/PluginPage";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { contributionsQuery } from "../../../../lib/query/conversation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/p/[plugin]`: a plugin's page without the contribution id, for the plugins that have one page
 * (the sidebar links those here; a plugin with several pages keeps `/p/<plugin>/<id>`, and this
 * address opens the first). The page itself is the same template and slot as `/p/<plugin>/<id>`.
 */
export default function PluginRootPageView({ plugin }: { plugin: string }) {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <PluginRootPageData orgId={ws.orgId} plugin={plugin} />;
}

function PluginRootPageData({ orgId, plugin }: { orgId: string; plugin: string }) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const read = usePageQuery(contributionsQuery(orgId));
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
  const page = read.data.find((c) => c.plugin === plugin && c.slot === "org.page");
  if (page === undefined) return <NotFound />;
  return (
    <PluginPage orgId={orgId} plugin={plugin} id={page.id} contribution={page} direct={false} />
  );
}
