"use client";

import {
  Button,
  DangerConfirm,
  Dialog,
  ErrorDetail,
  formatDateTime,
  ListPage,
  type MenuItem,
  ObjectCard,
  Stack,
  Text,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import {
  MarketplaceSourceDialog,
  sourceChangeKeys,
  useProblem,
} from "../../../../../components/MarketplaceSourceDialog";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath, usePathWord } from "../../../../../components/shell/path";
import {
  type Marketplace,
  marketplaceErrorKind,
  refreshMarketplace,
  removeMarketplace,
  shortCommit,
  updateMarketplace,
} from "../../../../../lib/catalog";
import { marketplacesQuery } from "../../../../../lib/query/admin";
import { useAppMutation } from "../../../../../lib/query/mutation";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import NotFound from "../../../not-found";

type SourceList = { items: Marketplace[]; offline: boolean };

/**
 * `/admin/plugins/sources`: the marketplace sources (super admins, ListPage cards; the plugins page
 * market filter row leads here, its entries are the Marketplace tab). One card per source with its kind,
 * address, state, the enable / disable switch and "Refresh now"; Details (the raw error, the skipped
 * entries, the official source's mirrors and a managed source's token note), Edit and Delete are in
 * the ⋯ menu. The official marketplace is read-only (its address is in the deployment config), as
 * is a config-managed one: only the switch and refresh. Adding and editing a custom source is the
 * {@link MarketplaceSourceDialog} (a marketplace.json URL or a git repository). From the query
 * cache (the layout prefetched it on a first load): each change reads the list again and
 * invalidates the entries and the catalog's marks.
 */
export default function SourcesView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <SourcesRead />;
}

function SourcesRead() {
  const scope = usePagePath("admin");
  const pw = usePathWord("admin");
  const t = useTranslations("catalog.admin.marketplaces");
  const read = usePageQuery(marketplacesQuery());
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <ListPage
        header={{
          path: [...scope, pw("plugins", "/admin/plugins"), pw("sources")],
          title: t("title"),
          description: t("description"),
          search: { label: t("search"), value: "", onChange: () => {} },
        }}
        variant="cards"
        loading
      />
    );
  }
  return <Sources data={read.data} />;
}

function Sources({ data }: { data: SourceList }) {
  const scope = usePagePath("admin");
  const pw = usePathWord("admin");
  const t = useTranslations("catalog.admin.marketplaces");
  const ta = useTranslations("catalog.admin.actions");
  // The dialog: `null` closed, `"add"`, or the custom source being edited
  const [dialog, setDialog] = useState<null | "add" | Marketplace>(null);
  // The head's search narrows the marketplaces shown, by name or address
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = data.items.filter(
    (s) =>
      needle === "" ||
      s.name.toLowerCase().includes(needle) ||
      s.url.toLowerCase().includes(needle),
  );
  // The official one first
  const ordered = [...shown.filter((s) => s.builtin), ...shown.filter((s) => !s.builtin)];

  return (
    <>
      <ListPage
        header={{
          path: [...scope, pw("plugins", "/admin/plugins"), pw("sources")],
          title: t("title"),
          description: t("description"),
          search: { label: t("search"), value: q, onChange: setQ },
          actions: [
            { label: ta("addSource"), variant: "primary", onSelect: () => setDialog("add") },
          ],
        }}
        variant="cards"
        listLabel={t("title")}
        // A search matching no marketplace: the page empty state instead of the cards (§6.18)
        {...(needle !== "" && shown.length === 0
          ? {
              empty: {
                text: t("noMatch"),
                action: {
                  label: t("clearSearch"),
                  variant: "default" as const,
                  onSelect: () => setQ(""),
                },
              },
            }
          : {})}
      >
        {ordered.map((s) => (
          <SourceCard key={s.id} source={s} offline={data.offline} onEdit={() => setDialog(s)} />
        ))}
      </ListPage>
      <MarketplaceSourceDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        {...(dialog !== null && dialog !== "add" ? { source: dialog } : {})}
      />
    </>
  );
}

/** `host/path` of an address (a git `owner/repo` shorthand stays as it is). */
function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * One marketplace source (spec §5.5.3). The official source and a config-managed one are
 * read-only (no Edit / Delete). The card's switch is enable / disable; Refresh now is the primary.
 */
function SourceCard({
  source,
  offline,
  onEdit,
}: {
  source: Marketplace;
  offline: boolean;
  onEdit(): void;
}) {
  const t = useTranslations("catalog.admin.marketplaces");
  const timeZone = useTimeZone();
  const toast = useToast();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const problem = useProblem();
  const [confirm, setConfirm] = useState(false);
  const [details, setDetails] = useState(false);
  const builtin = source.builtin;
  // Set by the deployment config: only the switch and the refresh work
  const locked = builtin || source.managed === "config";
  const title = builtin ? t("official") : source.name;
  const git = source.form === "git";
  const listKey = marketplacesQuery().queryKey;

  const update = useAppMutation({
    fn: (body: Parameters<typeof updateMarketplace>[1]) => updateMarketplace(source.id, body),
    invalidates: () => [listKey, ...sourceChangeKeys()],
  });
  const refresh = useAppMutation({
    fn: () => refreshMarketplace(source.id),
    invalidates: () => [listKey, ...sourceChangeKeys()],
  });
  const remove = useAppMutation({
    fn: () => removeMarketplace(source.id),
    invalidates: () => [listKey, ...sourceChangeKeys()],
  });

  const fail = (e: unknown) => {
    const p = problem(e);
    toast.error([p.message, ...p.extra].join(" "));
    // A failed refresh also recorded its status: read the list again
    void qc.invalidateQueries({ queryKey: listKey });
  };
  const toggle = async () => {
    try {
      await update.mutateAsync({ enabled: !source.enabled });
      toast.success(t("saved", { name: title }));
    } catch (e) {
      fail(e);
    }
  };
  const doRefresh = async () => {
    try {
      await refresh.mutateAsync(undefined);
      toast.success(t("refreshed", { name: title }));
    } catch (e) {
      fail(e);
    }
  };

  const skipped = source.skipped ?? [];
  const raw = source.lastStatus === "error" ? (source.lastError ?? "") : "";
  const errorSentence =
    source.lastStatus === "error" ? t(`statusValue.errors.${marketplaceErrorKind(raw)}`) : null;
  const note = builtin ? (offline ? t("offline") : t("officialNote")) : null;
  // The state is a short label at the head's right; what it means (the entry count and the last
  // refresh, or the error sentence) leads the description, so the name keeps the head's width.
  // The raw text and the skipped lines are in the Details dialog.
  const summary = !source.enabled
    ? null
    : errorSentence !== null
      ? errorSentence
      : source.lastStatus === "never"
        ? null
        : t("statusValue.summary", {
            n: source.entryCount,
            at: source.lastRefreshedAt
              ? formatDateTime(source.lastRefreshedAt, "full", timeZone)
              : "—",
          });
  const description = [summary, note, source.managed === "config" ? t("managed") : null]
    .filter((x): x is string => x !== null)
    .join(" ");

  const state = !source.enabled
    ? { label: t("disabled"), tone: "muted" as const }
    : source.lastStatus === "error"
      ? { label: t("statusValue.failed"), tone: "fail" as const }
      : source.lastStatus === "never"
        ? { label: t("statusValue.never"), tone: "muted" as const }
        : { label: t("statusValue.ok"), tone: "ok" as const };

  const mirrors = source.mirrors;
  const tokenNote =
    source.managed === "config"
      ? t(source.hasToken ? "managedTokenSet" : "managedTokenUnset")
      : null;
  const menu: MenuItem[] = [
    ...(errorSentence !== null || skipped.length > 0 || mirrors.length > 0 || tokenNote !== null
      ? [{ label: t("details"), onSelect: () => setDetails(true) }]
      : []),
    ...(locked
      ? []
      : [
          { label: t("edit"), onSelect: onEdit },
          { label: t("remove"), danger: true, onSelect: () => setConfirm(true) },
        ]),
  ];

  return (
    <>
      <ObjectCard
        avatar={{ icon: "store" }}
        title={title}
        {...(description !== "" ? { description } : {})}
        meta={[
          t(git ? "formGit" : "formHttp"),
          hostPath(source.url),
          ...(git ? [t("gitInfo", { ref: source.ref ?? t("defaultBranch") })] : []),
          ...(git && source.lastCommit !== null
            ? [t("lastCommit", { commit: shortCommit(source.lastCommit) })]
            : []),
          ...(skipped.length > 0
            ? [{ label: t("skipped.title", { n: skipped.length }), tone: "warn" as const }]
            : []),
        ]}
        state={state}
        toggle={{
          label: t("enabledLabel", { name: title }),
          checked: source.enabled,
          disabled: source.disabledByConfig,
          loading: update.isPending,
          onChange: () => void toggle(),
        }}
        {...(source.enabled
          ? {
              primary: {
                label: t("refresh"),
                onSelect: () => void doRefresh(),
                loading: refresh.isPending,
              },
            }
          : {})}
        {...(menu.length > 0 ? { menu } : {})}
      />
      <Dialog
        open={details}
        onOpenChange={setDetails}
        title={t("detailsTitle", { name: title })}
        size={640}
        footer={
          <Button variant="primary" onClick={() => setDetails(false)}>
            {t("close")}
          </Button>
        }
      >
        <Stack gap={12}>
          {mirrors.length > 0 && (
            <Text variant="small" tone="muted">{`${t("mirrors")}: ${mirrors.join(", ")}`}</Text>
          )}
          {tokenNote !== null && (
            <Text variant="small" tone="muted">
              {tokenNote}
            </Text>
          )}
          {errorSentence !== null && (
            <ErrorDetail summary={errorSentence} {...(raw !== "" ? { detail: raw } : {})} />
          )}
          {skipped.length > 0 && (
            <Stack gap={4}>
              <Text variant="small" tone="warn">
                {t("skipped.title", { n: skipped.length })}
              </Text>
              {skipped.map((x, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; the list is static
                <Text key={i} variant="small" tone="muted">
                  {t("skipped.line", {
                    name: x.name,
                    reason: t.has(`skipped.reasons.${x.reason}`)
                      ? t(`skipped.reasons.${x.reason}`)
                      : x.reason,
                  })}
                </Text>
              ))}
            </Stack>
          )}
        </Stack>
      </Dialog>
      {!locked && (
        <DangerConfirm
          open={confirm}
          onOpenChange={setConfirm}
          title={t("removeConfirm.title", { name: source.name })}
          description={t("removeConfirm.hint")}
          confirmName={source.name}
          confirmLabel={t("removeConfirm.confirm")}
          onConfirm={async () => {
            await remove.mutateAsync(undefined).catch((e: unknown) => {
              throw new Error(errorMessage(e));
            });
            toast.success(t("removed", { name: source.name }));
            setConfirm(false);
          }}
        />
      )}
    </>
  );
}
