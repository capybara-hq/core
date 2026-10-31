"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AdminGate } from "../../../../components/AdminGate";
import { usePagePath } from "../../../../components/shell/path";
import {
  type AdminExtension,
  displaySource,
  type ExtensionStatus,
  listAdminExtensions,
  replicaSummary,
} from "../../../../lib/admin-extensions";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/admin/extensions`: every extension on the deployment as object rows (enterprise admins). A
 * warn callout above the tabs names the extensions that need attention (anything that is neither
 * enabled nor disabled, such as a required extension without config); tabs All / Needs attention /
 * Enabled / Disabled carry counts and appear only when they hold something different from All.
 * A row: mark, mono name, version and chips, description-free meta (extension points, source,
 * replicas, permissions: only what the API returns), state label, one action and a menu.
 */
export default function AdminExtensionsPage() {
  return (
    <AdminGate>
      <AdminPlugins />
    </AdminGate>
  );
}

type TabId = "all" | "attention" | "enabled" | "disabled";

/** An extension that is neither running nor deliberately off needs an admin. */
const needsAttention = (p: AdminExtension) => p.status !== "enabled" && p.status !== "disabled";

const STATE_TONE: Record<ExtensionStatus, "ok" | "warn" | "fail" | "muted"> = {
  enabled: "ok",
  disabled: "muted",
  pending_approval: "warn",
  pending_config: "warn",
  pending_migration: "warn",
  converging: "warn",
  failed: "fail",
  dependency: "fail",
  legacy_format: "fail",
};

function AdminPlugins() {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.extensions");
  const { state, reload } = useLoad(listAdminExtensions, []);
  const [tab, setTab] = useState<TabId>("all");
  const all = state.kind === "ready" ? state.data.extensions : [];
  const groups: Record<Exclude<TabId, "all">, AdminExtension[]> = {
    attention: all.filter(needsAttention),
    enabled: all.filter((p) => p.status === "enabled"),
    disabled: all.filter((p) => p.status === "disabled"),
  };
  // A tab only when it holds something different from "all".
  const tabIds = (Object.keys(groups) as Exclude<TabId, "all">[]).filter(
    (id) => groups[id].length > 0 && groups[id].length < all.length,
  );
  const active: TabId = tab !== "all" && tabIds.includes(tab) ? tab : "all";
  const rows = active === "all" ? all : groups[active];
  const attention = groups.attention;

  const header = {
    path: [...scope, { label: "extensions" }],
    title: t("title"),
    actions: [
      { label: t("install"), variant: "primary" as const, href: "/admin/extensions/install" },
    ],
    ...(tabIds.length > 0
      ? {
          tabs: [
            { id: "all", label: t("tabs.all"), count: all.length, onSelect: () => setTab("all") },
            ...tabIds.map((id) => ({
              id,
              label: t(`tabs.${id}`),
              count: groups[id].length,
              onSelect: () => setTab(id),
            })),
          ],
          activeTab: active,
        }
      : {}),
  };

  const callout =
    attention.length > 0
      ? {
          tone: "warn" as const,
          children: t("callout", {
            n: attention.length,
            names: attention.map((p) => p.name).join(", "),
          }),
          action: {
            label: t("calloutFix"),
            ...(attention.length === 1
              ? { href: `/admin/extensions/${encodeURIComponent(attention[0]?.name ?? "")}` }
              : { onSelect: () => setTab("attention") }),
          },
        }
      : undefined;

  const empty =
    state.kind === "error"
      ? {
          icon: "circle-alert" as const,
          text: t("loadFailed"),
          action: { label: t("retry"), variant: "default" as const, onSelect: reload },
        }
      : state.kind === "ready" && all.length === 0
        ? {
            icon: "extension" as const,
            text: t("empty"),
            action: {
              label: t("install"),
              variant: "primary" as const,
              href: "/admin/extensions/install",
            },
          }
        : undefined;

  return (
    <ListPage
      header={header}
      variant="objects"
      {...(callout ? { callout } : {})}
      {...(empty ? { empty } : {})}
    >
      {rows.map((p) => {
        const detail = `/admin/extensions/${encodeURIComponent(p.name)}`;
        const attn = needsAttention(p);
        const points = p.permissions
          .filter((g) => g.category === "provides")
          .reduce((n, g) => n + g.items.length, 0);
        const perms = p.permissions
          .filter((g) => g.category !== "provides")
          .reduce((n, g) => n + g.items.length, 0);
        const r = replicaSummary(p);
        const meta = [
          points > 0 ? t("meta.points", { n: points }) : null,
          t(`source.${displaySource(p)}`),
          r.total > 0
            ? t(r.consistent ? "replicas.consistent" : "replicas.diverged", { n: r.total })
            : null,
          perms > 0 ? t("meta.permissions", { n: perms }) : null,
        ]
          .filter((x): x is string => x !== null)
          .join(" · ");
        return (
          <ObjectRow
            key={p.name}
            mark={{ icon: "extension", tone: attn ? "warn" : "neutral" }}
            name={p.name}
            mono
            href={detail}
            chips={[
              { label: `v${p.version}` },
              ...(p.required ? [{ label: t("required") }] : []),
              ...(p.sensitive ? [{ label: t("sensitive"), tone: "warn" as const }] : []),
            ]}
            meta={meta}
            state={{ label: t(`status.${p.status}`), tone: STATE_TONE[p.status] }}
            action={{
              label: p.status === "pending_config" ? t("configure") : t("settings"),
              href: detail,
              ...(p.status === "pending_config" ? { primary: true } : {}),
            }}
            menu={[
              { label: t("details"), href: detail },
              ...(p.source === "install"
                ? [
                    {
                      label: t("upgrade"),
                      href: `/admin/extensions/install?upgrade=${encodeURIComponent(p.name)}`,
                    },
                  ]
                : []),
            ]}
          />
        );
      })}
    </ListPage>
  );
}
