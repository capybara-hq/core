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
import { usePagePath } from "../../../../../components/shell/path";
import { useRouter } from "../../../../../i18n/navigation";
import { marketplaceTabs } from "../../../../../lib/admin-tabs";
import { issueLines } from "../../../../../lib/api";
import {
  entryHost,
  importMarketplaceEntry,
  importPageHref,
  type MarketplaceEntry,
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

/** 搜索框的防抖时长（浏览器里的计时，不涉及服务端状态）。 */
const SEARCH_DEBOUNCE_MS = 300;

type Notice = { message: string; extra: string[] };

/** One entry's row key: an entry is one version of a plugin in one marketplace. */
const keyOf = (e: MarketplaceEntry) => `${e.sourceId}/${e.name}/${e.version ?? ""}`;

/**
 * `/admin/marketplaces/entries`: browse marketplace entries (enterprise admins), as object rows.
 * One entry is one version of a plugin. A row: the mono name, the summary, a meta line (the
 * marketplace, its source: npm package, archive URL, a git URL pinned to a commit or following a
 * branch, a path in the marketplace's repository; the version, incompatible ones marked; the
 * permission summary with the sensitive count in warn), the state (not imported / imported
 * <version>, or why it cannot be imported: a host outside `marketplaces.allowedHosts`, a path
 * entry of an http marketplace), chips for a newer version or changed content, one action and a
 * menu. The action "Import <version>" (or, when the content changed, "Import the changed content")
 * downloads, verifies and stages the plugin, then opens the import review
 * (`/admin/catalog/import?staging=<id>`); an imported entry's action opens its catalog item. The
 * search sits in the page head; the marketplaces become tabs above the list when there is more
 * than one. Errors such as `marketplace.integrity_mismatch` are a fail callout (with the kernel's
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
  const rows = state.kind === "ready" ? state.data.items : [];
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
      versionText(e),
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
  /** The row's one action: import (again, when the content changed), or open the imported item. */
  const actionOf = (e: MarketplaceEntry) => {
    if (e.importable && e.compatible && (!imported(e) || e.contentChanged)) {
      return {
        label: importLabel(e),
        onSelect: () => {
          if (busy === undefined) void doImport(e);
        },
      };
    }
    if (e.adopted !== null) {
      return { label: t("view"), href: `/admin/catalog/${encodeURIComponent(e.adopted.itemId)}` };
    }
    return undefined;
  };
  const menuOf = (e: MarketplaceEntry): MenuItem[] => [
    ...(!e.importable
      ? [{ label: reasonOf(e), disabled: true, onSelect: () => {} }]
      : !e.compatible
        ? [{ label: t("noCompatible"), disabled: true, onSelect: () => {} }]
        : []),
    ...(e.adopted !== null
      ? [{ label: t("view"), href: `/admin/catalog/${encodeURIComponent(e.adopted.itemId)}` }]
      : []),
    ...(e.homepage !== null ? [{ label: t("homepage"), href: e.homepage }] : []),
  ];
  const stateOf = (e: MarketplaceEntry) =>
    !e.importable
      ? { label: reasonOf(e), tone: "warn" as const }
      : e.adopted === null
        ? { label: t("notAdopted"), tone: "muted" as const }
        : {
            label: t("adopted", {
              version: e.adopted.versions[0] == null ? "" : versionLabel(e.adopted.versions[0]),
            }),
            tone: "ok" as const,
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
        path: [
          ...scope,
          { label: "marketplaces", href: "/admin/marketplaces" },
          { label: "entries" },
        ],
        title: ta("marketplaces.title"),
        // One head for both tabs (description, tab counts, search): switching never moves the tabs
        description: ta("marketplaces.description"),
        tabs: marketplaceTabs(ta, sources),
        activeTab: "browse",
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
      {rows.map((e) => {
        const action = actionOf(e);
        return (
          <ObjectRow
            key={keyOf(e)}
            mark={{
              text: e.name,
              ...(!e.importable ? { tone: "warn" as const } : {}),
            }}
            name={e.name}
            mono
            chips={[
              ...(e.newerAvailable ? [{ label: td("newer") }] : []),
              ...(e.contentChanged ? [{ label: td("contentChanged"), tone: "warn" as const }] : []),
            ]}
            description={summaryOf(e)}
            meta={metaOf(e)}
            state={stateOf(e)}
            {...(action ? { action } : {})}
            menu={menuOf(e)}
          />
        );
      })}
    </ListPage>
  );
}
