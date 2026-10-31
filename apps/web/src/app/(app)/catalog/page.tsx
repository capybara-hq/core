"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useOrgItemStatus } from "../../../components/CatalogInstallAction";
import { RoleGate } from "../../../components/RoleGate";
import { usePagePath } from "../../../components/shell/path";
import { useSession } from "../../../components/shell/session";
import { displayNameOf, listOrgCatalog, type OrgCatalogItem } from "../../../lib/catalog";
import { canUpdateOrg } from "../../../lib/org-settings";
import { useLoad } from "../../../lib/use-load";

/**
 * `/catalog`: the plugins in the catalog available to this org (members and up), as object rows.
 * The row action follows `installable` (the kernel decides): install opens the wizard, requests
 * and upgrades open the detail page, which carries the full action (CatalogInstallAction).
 */
export default function CatalogPage() {
  return <RoleGate min="member">{(orgId) => <Catalog key={orgId} orgId={orgId} />}</RoleGate>;
}

function Catalog({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("catalog.org");
  const locale = useLocale();
  const status = useOrgItemStatus();
  const { me } = useSession();
  const admin = canUpdateOrg(me);
  const { state, reload } = useLoad(() => listOrgCatalog(orgId), [orgId]);
  const [tab, setTab] = useState<"all" | "installed">("all");
  const all = state.kind === "ready" ? state.data.items : [];
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
    if (i.request?.status === "pending") return undefined;
    if (i.installable === "disabled" || i.installable === "not_deployed") return undefined;
    if (!admin) return { label: t("action.request"), href: detail };
    if (i.installable === "needs_approval") {
      return { label: t("action.requestApproval"), href: detail };
    }
    return { label: t("action.install"), primary: true, href: `${detail}/install` };
  };
  const tone = (i: OrgCatalogItem) =>
    i.installed !== null
      ? i.installed.upgradeAvailable !== null
        ? ("warn" as const)
        : ("ok" as const)
      : i.installable === "not_deployed"
        ? ("warn" as const)
        : ("muted" as const);

  const header = {
    path: [...scope, { label: "catalog" }],
    title: t("title"),
    description: t("hint"),
    ...(state.kind === "ready" && showTabs
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
  const empty =
    state.kind === "error"
      ? {
          icon: "circle-alert" as const,
          text: t("loadFailed"),
          action: { label: t("retry"), variant: "default" as const, onSelect: reload },
        }
      : state.kind === "ready" && all.length === 0
        ? { text: t("empty") }
        : undefined;
  return (
    <ListPage
      header={header}
      variant="objects"
      loading={state.kind === "loading"}
      {...(empty ? { empty } : {})}
    >
      {rows.map((i) => {
        const action = rowAction(i);
        const name = displayNameOf(i, locale);
        return (
          <ObjectRow
            key={i.id}
            mark={{ text: Array.from(name)[0] ?? "?" }}
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
