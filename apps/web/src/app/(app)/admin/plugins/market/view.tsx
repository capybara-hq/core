"use client";

import {
  ListPage,
  type MenuItem,
  ObjectRow,
  Stack,
  Tabs,
  Text,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useCatalogErrorLines } from "../../../../../components/CatalogParts";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePluginsHead } from "../../../../../components/PluginsHead";
import { usePagePath } from "../../../../../components/shell/path";
import { useRouter } from "../../../../../i18n/navigation";
import { issueLines } from "../../../../../lib/api";
import {
  compareSemver,
  displayNameOf,
  entryDeprecated,
  entryHost,
  groupMarketplaceEntries,
  importMarketplaceEntry,
  importPageHref,
  type MarketplaceEntry,
  type MarketplacePlugin,
  marketplaceSourceText,
  shortCommit,
} from "../../../../../lib/catalog";
import {
  marketplaceEntriesQuery,
  marketplacesQuery,
  stagedImportQuery,
} from "../../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../../lib/query/client";
import { useAppMutation } from "../../../../../lib/query/mutation";
import { useAdmin } from "../../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../../lib/use-error-message";

/** The search box debounce (a browser timer; no server state involved). */
const SEARCH_DEBOUNCE_MS = 300;

type Notice = { message: string; extra: string[] };

/** One entry's row key: an entry is one version of a plugin in one marketplace. */
const keyOf = (e: MarketplaceEntry) => `${e.sourceId}/${e.name}/${e.version ?? ""}`;

/**
 * `/admin/plugins/market`: browse marketplace entries (super admins, the 插件 tab 市场), as
 * object rows.
 * A row's mark is the plugin's icon when there is one (the imported plugin's own icon, else the
 * one its marketplace gives; the kernel's `icon`), else its initial.
 * One entry is one version of a plugin; a row is one plugin of one marketplace, at its latest
 * version (see {@link groupMarketplaceEntries}). A row: the mono name, the summary, a meta line (the
 * marketplace, its source: npm package, archive URL, a git URL pinned to a commit or following a
 * branch, a path in the marketplace's repository; the version only when incompatible or unnamed;
 * the permission summary with the sensitive count in warn), the state (未安装 / 已安装 <version> /
 * 已安装 <version> · 可更新到 <latest>, or why it cannot be installed: a host outside
 * `marketplaces.allowedHosts`, a path entry of an http marketplace), a chip for changed content,
 * one action and a menu. The action 安装 <latest> (更新到 <latest> when an older version is
 * installed; when the content changed, 更新到 <version> 的新内容) downloads, verifies and stages the
 * plugin, then opens the wizard (`/admin/plugins/import?staging=<id>`: the install review, or for
 * an installed plugin the review and the update preview confirmed together, maintainer decision
 * 2026-11-13); a plugin installed at the latest opens its plugin. The menu's 其他版本 installs
 * another version of a plugin not installed yet the same way, and offers an installed plugin only
 * the versions newer than the ones it has (更新到; an older one is a rollback on the plugin's 版本
 * tab, never an import alone); a version the marketplace deprecates reads 已废弃 (with its reason)
 * there and is never installed, and prereleases sit there while a stable version can be installed.
 * The
 * search sits in the page head (the 插件 head with its tabs and counts); the marketplaces become
 * tabs above the list when there is more than one. Errors such as `marketplace.integrity_mismatch` are a fail callout (with the kernel's
 * line naming the host for network and git codes); a warn callout when the entries are truncated.
 * From the query cache (the layout prefetched the address's entries and the marketplaces on a
 * first load): each source and search is its own entry (one filter's rows never show under
 * another); the marketplaces are a section (while they load or when they failed: no source tabs,
 * no tab counts); a failed entries read is the empty state with a retry.
 */
export default function CatalogView({ sourceId, q }: { sourceId: string; q: string }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <Catalog initial={{ sourceId, q }} />;
}

function Catalog({ initial }: { initial: { sourceId: string; q: string } }) {
  const scope = usePagePath("admin");
  const head = usePluginsHead("market");
  const t = useTranslations("catalog.admin.entries");
  const ta = useTranslations("catalog.admin");
  const td = useTranslations("catalog");
  const locale = useLocale();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  // The initial source and search come from the address, with their entries read on the server
  const [sourceId, setSourceId] = useState(initial.sourceId);
  const [q, setQ] = useState(initial.q);
  // Debounced search: request again 300 ms after typing stops
  const [query, setQuery] = useState(initial.q);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);
  const eq = marketplaceEntriesQuery(sourceId, query);
  const entries = useQuery({ ...eq, retryOnMount: retryOnMountOf(eq.queryKey) });
  const reload = () => void entries.refetch();
  const state =
    entries.data !== undefined
      ? ({ kind: "ready", data: entries.data } as const)
      : entries.error
        ? ({ kind: "error" } as const)
        : ({ kind: "loading" } as const);
  const mq = marketplacesQuery();
  const sources = useQuery({ ...mq, retryOnMount: retryOnMountOf(mq.queryKey) }).data?.items;
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState<string>();
  const rows = groupMarketplaceEntries(state.kind === "ready" ? state.data.items : []);
  const truncated = state.kind === "ready" && state.data.truncated === true;
  const sourceList = sources ?? [];
  const qc = useQueryClient();
  // Stages the entry for review: the answer is the staged import, which the review page reads.
  const stage = useAppMutation({
    fn: (e: MarketplaceEntry) => importMarketplaceEntry(e, e.version),
    invalidates: () => [],
    onSuccess: (p) => qc.setQueryData(stagedImportQuery(p.stagingId).queryKey, p),
  });

  const doImport = async (e: MarketplaceEntry) => {
    setBusy(keyOf(e));
    setNotice(undefined);
    try {
      const p = await stage.mutateAsync(e);
      router.push(importPageHref(p.stagingId));
    } catch (err) {
      setNotice({ message: errorMessage(err), extra: [...issueLines(err), ...catalogLines(err)] });
    } finally {
      setBusy(undefined);
    }
  };

  const summaryOf = (e: MarketplaceEntry) =>
    locale === "zh" && e.summary.zh !== undefined ? e.summary.zh : e.summary.en;
  const imported = (e: MarketplaceEntry) =>
    e.version !== null && (e.adopted?.versions.includes(e.version) ?? false);
  /** Why an entry cannot be imported, naming the host when it is outside allowedHosts. */
  const reasonOf = (e: MarketplaceEntry) =>
    e.reason === "host_not_allowed"
      ? t("reason.host_not_allowed", {
          host: entryHost(e.source) ?? marketplaceSourceText(e.source),
        })
      : t("reason.path_needs_git_marketplace");
  /** The second line of a source: a git commit or the branch it follows, a repository path. */
  const sourceNote = (e: MarketplaceEntry): string | null => {
    const s = e.source;
    if ("path" in s) return t("pathSource", { path: s.path });
    if (!("git" in s)) return null;
    if (s.git.commit !== undefined) return t("gitPinned", { commit: shortCommit(s.git.commit) });
    return s.git.ref !== undefined ? t("gitFollows", { ref: s.git.ref }) : t("gitFollowsDefault");
  };

  const versionText = (e: MarketplaceEntry) =>
    e.compatible
      ? (e.version ?? t("noVersion"))
      : t("incompatible", {
          version: e.version == null ? t("noVersion") : versionLabel(e.version),
        });
  const metaOf = (e: MarketplaceEntry): (string | { label: string; tone: "warn" })[] => {
    const note = sourceNote(e);
    return [
      e.sourceName,
      ...("path" in e.source ? [] : [marketplaceSourceText(e.source)]),
      ...(note !== null ? [note] : []),
      // the version is in the state or the action, unless it is incompatible or unnamed
      ...(!e.compatible || e.version === null ? [versionText(e)] : []),
      ...(e.permissions === null
        ? [t("permissionsNone")]
        : [
            t("permissionsCount", { n: e.permissions.keys.length }),
            ...(e.permissions.sensitive.length > 0
              ? [
                  {
                    label: t("permissionsSensitive", { n: e.permissions.sensitive.length }),
                    tone: "warn" as const,
                  },
                ]
              : []),
          ]),
    ];
  };
  const importLabel = (e: MarketplaceEntry) =>
    e.contentChanged
      ? t("importChanged", {
          version: e.version == null ? t("noVersion") : versionLabel(e.version),
        })
      : e.version === null
        ? t("import")
        : t("importVersion", { version: versionLabel(e.version) });
  /** 已废弃 with the marketplace's reason when it gives one. */
  const deprecatedLabel = (e: MarketplaceEntry) => {
    const version = e.version === null ? t("noVersion") : versionLabel(e.version);
    const reason = e.deprecated?.reason ?? null;
    return reason !== null
      ? t("deprecatedReason", { version, reason })
      : t("deprecated", { version });
  };
  /** The newest imported version of the plugin (undefined when none is imported). */
  const importedTop = (e: MarketplaceEntry) => e.adopted?.versions[0] ?? undefined;
  /**
   * Another version than the row's latest is imported, and not a newer one: the row offers 更新 to
   * the latest (an imported version that is not semver counts as older). Returns that version.
   */
  const updatable = (e: MarketplaceEntry) => {
    const top = importedTop(e);
    if (top === undefined || e.version === null || imported(e)) return undefined;
    if (!e.compatible || !e.importable || entryDeprecated(e)) return undefined;
    return (compareSemver(top, e.version) ?? -1) < 0 ? top : undefined;
  };
  const canImport = (e: MarketplaceEntry) =>
    e.importable && e.compatible && !entryDeprecated(e) && (!imported(e) || e.contentChanged);
  const viewHref = (itemId: string) => `/admin/plugins/${encodeURIComponent(itemId)}`;
  /**
   * The row's one action: 引入 the latest (更新 when an older version is imported; again when the
   * content changed), or open the imported item.
   */
  const actionOf = (e: MarketplaceEntry) => {
    if (canImport(e) && (e.adopted === null || imported(e) || updatable(e) !== undefined)) {
      return {
        label:
          updatable(e) !== undefined && e.version !== null
            ? t("update", { version: versionLabel(e.version) })
            : importLabel(e),
        onSelect: () => {
          if (busy === undefined) void doImport(e);
        },
      };
    }
    if (e.adopted !== null) return { label: t("view"), href: viewHref(e.adopted.itemId) };
    return undefined;
  };
  /**
   * One other version in 其他版本: import it, or why not (deprecated, with the reason; imported,
   * incompatible, unimportable).
   */
  const otherItem = (o: MarketplaceEntry): MenuItem => {
    const v = o.version === null ? t("noVersion") : versionLabel(o.version);
    if (entryDeprecated(o))
      return { label: deprecatedLabel(o), disabled: true, onSelect: () => {} };
    if (canImport(o)) {
      return {
        label:
          o.adopted !== null && o.version !== null && !o.contentChanged
            ? t("update", { version: v })
            : importLabel(o),
        onSelect: () => {
          if (busy === undefined) void doImport(o);
        },
      };
    }
    const label = imported(o)
      ? t("adopted", { version: v })
      : !o.compatible
        ? t("incompatible", { version: v })
        : t("importVersion", { version: v });
    return { label, disabled: true, onSelect: () => {} };
  };
  /**
   * The other versions the menu offers: all of a plugin not installed yet; of an installed one
   * only those newer than its newest version (an older one is a rollback on its 版本 tab).
   */
  const othersOf = (e: MarketplaceEntry, others: MarketplaceEntry[]) => {
    const top = importedTop(e);
    if (top === undefined) return others;
    return others.filter((o) => o.version !== null && (compareSemver(o.version, top) ?? -1) > 0);
  };
  const menuOf = ({ latest: e, others: all }: MarketplacePlugin): MenuItem[] => {
    const action = actionOf(e);
    const others = othersOf(e, all);
    return [
      ...(!e.importable
        ? [{ label: reasonOf(e), disabled: true, onSelect: () => {} }]
        : !e.compatible
          ? [{ label: t("noCompatible"), disabled: true, onSelect: () => {} }]
          : []),
      ...(e.adopted !== null && action?.label !== t("view")
        ? [{ label: t("view"), href: viewHref(e.adopted.itemId) }]
        : []),
      ...(others.length > 0 ? [{ label: t("otherVersions"), submenu: others.map(otherItem) }] : []),
      ...(e.homepage !== null ? [{ label: t("homepage"), href: e.homepage }] : []),
    ];
  };
  const stateOf = (e: MarketplaceEntry) => {
    if (!e.importable) return { label: reasonOf(e), tone: "warn" as const };
    // every version is deprecated: the row's state says so
    if (entryDeprecated(e)) return { label: deprecatedLabel(e), tone: "warn" as const };
    const top = importedTop(e);
    if (e.adopted === null) return { label: t("notAdopted"), tone: "muted" as const };
    const older = updatable(e);
    return {
      label:
        older !== undefined && e.version !== null
          ? t("adoptedUpdate", {
              version: versionLabel(older),
              latest: versionLabel(e.version),
            })
          : t("adopted", { version: top === undefined ? "" : versionLabel(top) }),
      tone: "ok" as const,
    };
  };

  const filtering = sourceId !== "" || query !== "";
  const callout =
    notice !== undefined
      ? {
          tone: "fail" as const,
          children: (
            <Stack gap={4}>
              <Text tone="fail">{notice.message}</Text>
              {notice.extra.map((m) => (
                <Text key={m} variant="small" tone="fail">
                  {m}
                </Text>
              ))}
            </Stack>
          ),
        }
      : truncated
        ? { tone: "warn" as const, children: t("truncated") }
        : undefined;
  const empty =
    state.kind === "error"
      ? {
          text: t("loadFailed"),
          action: { label: t("retry"), variant: "default" as const, onSelect: reload },
        }
      : state.kind === "ready" && rows.length === 0
        ? filtering
          ? { text: t("noResults") }
          : { text: t("empty") }
        : undefined;

  return (
    <ListPage
      header={{
        // The 插件 head shared by its three tabs, with the search
        ...head,
        path: [...scope, { label: "plugins", href: "/admin/plugins" }, { label: "market" }],
        search: { label: t("search"), value: q, onChange: setQ },
      }}
      variant="objects"
      listLabel={t("title")}
      loading={state.kind === "loading"}
      {...(callout ? { callout } : {})}
      {...(empty ? { empty } : {})}
      {...(sourceList.length > 1
        ? {
            filters: (
              <Tabs
                label={ta("filters.source")}
                value={sourceId === "" ? "all" : sourceId}
                onChange={(id) => setSourceId(id === "all" ? "" : id)}
                items={[
                  { id: "all", label: ta("filters.allSources") },
                  ...sourceList.map((s) => ({ id: s.id, label: s.name })),
                ]}
              />
            ),
          }
        : {})}
    >
      {rows.map((plugin) => {
        const e = plugin.latest;
        const action = actionOf(e);
        const name = displayNameOf(e, locale);
        return (
          <ObjectRow
            key={plugin.key}
            mark={{
              text: name,
              // the imported plugin's icon, else the marketplace's (the kernel picks it)
              image: e.icon ?? null,
              ...(!e.importable ? { tone: "warn" as const } : {}),
            }}
            name={name}
            mono={e.displayName === null}
            chips={[
              // 有新版本 is the state's 可更新到; the changed content is said only here
              ...(e.contentChanged ? [{ label: td("contentChanged"), tone: "warn" as const }] : []),
            ]}
            description={summaryOf(e)}
            meta={metaOf(e)}
            state={stateOf(e)}
            {...(action ? { action } : {})}
            menu={menuOf(plugin)}
          />
        );
      })}
    </ListPage>
  );
}
