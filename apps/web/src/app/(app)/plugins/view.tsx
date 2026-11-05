"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useOrgItemStatus } from "../../../components/CatalogInstallAction";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { displayNameOf, installableOf, type OrgCatalogItem } from "../../../lib/catalog";
import { canUpdateOrg } from "../../../lib/org-settings";
import { orgCatalogQuery } from "../../../lib/query/catalog";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import type { Me } from "../../../lib/session";
import NotFound from "../not-found";

/**
 * `/catalog`: the plugins in the catalog available to this org (members and up), as object rows.
 * The row action follows `installable` (the kernel decides): install opens the wizard, requests
 * and upgrades open the detail page, which carries the full action (CatalogInstallAction). From the
 * query cache (the layout prefetched it on a first load).
 */
export default function CatalogView() {
  const ws = useWorkspace({ min: "member", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Catalog orgId={ws.orgId} me={ws.me} />;
}

function Catalog({ orgId, me }: { orgId: string; me: Me }) {
  const scope = usePagePath("org");
  const t = useTranslations("catalog.org");
  const locale = useLocale();
  const status = useOrgItemStatus();
  const admin = canUpdateOrg(me);
  const [tab, setTab] = useState<"all" | "installed">("all");
  const list = usePageQuery(orgCatalogQuery(orgId));
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const all = list.kind === "ready" ? list.data.items : [];
  const installed = all.filter((i) => i.installed !== null);
  // A tab only when it holds something different from "all".
  const showTabs = installed.length > 0 && installed.length < all.length;
  const active = showTabs && tab === "installed" ? "installed" : "all";
  const rows = active === "installed" ? installed : all;

  const rowAction = (i: OrgCatalogItem) => {
    const detail = `/catalog/${encodeURIComponent(i.id)}`;
    if (i.installed !== null) {
      return admin && i.installed.upgradeAvailable !== null
        ? { label: t("action.upgrade"), href: detail }
        : undefined;
    }
    if (i.request !== null) return undefined;
    if (installableOf(i) === "disabled" || installableOf(i) === "not_deployed") return undefined;
    if (!admin) return { label: t("action.request"), href: detail };
    if (installableOf(i) === "needs_approval") {
      return { label: t("action.requestApproval"), href: detail };
    }
    return { label: t("action.install"), href: `${detail}/install` };
  };
  const tone = (i: OrgCatalogItem) =>
    i.installed !== null
      ? i.installed.upgradeAvailable !== null
        ? ("warn" as const)
        : ("ok" as const)
      : installableOf(i) === "not_deployed"
        ? ("warn" as const)
        : ("muted" as const);

  const header = {
    path: [...scope, { label: "catalog" }],
    title: t("title"),
    description: t("hint"),
    ...(showTabs
      ? {
          tabs: [
            { id: "all", label: t("tabs.all"), count: all.length, onSelect: () => setTab("all") },
            {
              id: "installed",
              label: t("tabs.installed"),
              count: installed.length,
              onSelect: () => setTab("installed"),
            },
          ],
          activeTab: active,
        }
      : {}),
  };
  const empty = all.length === 0 ? { text: t("empty") } : undefined;
  if (list.kind === "loading") return <ListPage header={header} variant="objects" loading />;
  return (
    <ListPage header={header} variant="objects" {...(empty ? { empty } : {})}>
      {rows.map((i) => {
        const action = rowAction(i);
        const name = displayNameOf(i, locale);
        return (
          <ObjectRow
            key={i.id}
            mark={{ text: name }}
            name={name}
            href={`/catalog/${encodeURIComponent(i.id)}`}
            description={i.description}
            meta={i.publisher}
            state={{ label: status(i), tone: tone(i) }}
            {...(action ? { action } : {})}
          />
        );
      })}
    </ListPage>
  );
}
