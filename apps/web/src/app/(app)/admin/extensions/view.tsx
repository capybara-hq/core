"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { usePagePath } from "../../../../components/shell/path";
import {
  type AdminExtension,
  displaySource,
  type ExtensionStatus,
  replicaSummary,
} from "../../../../lib/admin-extensions";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";

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

/**
 * `/admin/extensions`: every extension on the deployment as object rows (enterprise admins). A
 * warn callout above the tabs names the extensions that need attention (anything that is neither
 * enabled nor disabled, such as a required extension without config); tabs All / Needs attention /
 * Enabled / Disabled carry counts and appear only when they hold something different from All.
 * A row: mark, mono name, the sensitive chip, description-free meta (version, required, extension
 * points, source, replicas, permissions: only what the API returns), state label, one secondary
 * action and a menu.
 */
export default function AdminPlugins({
  initial,
}: {
  initial: { extensions: AdminExtension[]; drainSeconds: number };
}) {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.extensions");
  const lang = labelLocale(useLocale());
  const [tab, setTab] = useState<TabId>("all");
  const all = initial.extensions;
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
            names: attention.map((p) => extensionLabel(p, lang)).join(", "),
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
    all.length === 0
      ? {
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
        // Plain facts are meta text, not badges: the version and "required" lead the meta line;
        // only "sensitive" stays a (warn) chip.
        const label = extensionLabel(p, lang);
        const meta = [
          // The id stays visible as muted meta next to a display name.
          p.displayName ? p.name : null,
          `v${p.version}`,
          p.required ? t("required") : null,
          points > 0 ? t("meta.points", { n: points }) : null,
          t(`source.${displaySource(p)}`),
          r.total > 0
            ? t(r.consistent ? "replicas.consistent" : "replicas.diverged", {
                ok: r.inSync,
                n: r.total,
              })
            : null,
          perms > 0 ? t("meta.permissions", { n: perms }) : null,
        ]
          .filter((x): x is string => x !== null)
          .join(" · ");
        return (
          <ObjectRow
            key={p.name}
            mark={{ text: label, tone: attn ? "warn" : "neutral" }}
            name={label}
            {...(p.displayName ? {} : { mono: true })}
            href={detail}
            {...(p.sensitive ? { chips: [{ label: t("sensitive"), tone: "warn" as const }] } : {})}
            meta={meta}
            state={{ label: t(`status.${p.status}`), tone: STATE_TONE[p.status] }}
            action={{
              label: p.status === "pending_config" ? t("configure") : t("settings"),
              href: detail,
            }}
            // The name and the action open the detail page already: no 详情 item (spec §6.7)
            menu={[
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
