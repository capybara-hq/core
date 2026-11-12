"use client";

import {
  Button,
  Dialog,
  EmptyState,
  ItemList,
  type ItemListRow,
  LinkButton,
  OverviewSection,
  Subsection,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  type AdminAttention,
  type AttentionExtension,
  type AttentionOutboxDead,
  type AttentionSource,
  discardOutboxDead,
  type OutboxDeadRow,
  retryOutboxDead,
} from "../../../../lib/admin";
import {
  PLATFORM_INBOX_TYPES,
  type PlatformInboxView,
  platformInboxTypeHref,
} from "../../../../lib/admin-inbox";
import { displayNameOf } from "../../../../lib/catalog";
import {
  adminAttentionQuery,
  adminInboxQuery,
  adminOutboxDeadQuery,
} from "../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../lib/query/client";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { useErrorMessage } from "../../../../lib/use-error-message";

type T = ReturnType<typeof useTranslations<"admin.overview.attention">>;

/** Where the "+n" row of a capped list leads: the page that lists them all. */
const MORE_HREF: Record<Exclude<AttentionSource, "outbox" | "queue">, string> = {
  extensions: "/admin/extensions",
  updates: "/admin/plugins",
  providers: "/admin/models",
};

/** The reason words of an extension (spec §6.1): `config` is missing config while pending, else invalid. */
const reasonOf = (e: AttentionExtension, t: T): string =>
  e.reason === "config"
    ? e.status === "pending_config"
      ? t("reasons.missingConfig")
      : t("reasons.invalidConfig")
    : t(`reasons.${e.reason}`);

/**
 * 待处理 (spec §6.1): one section with up to six groups, each only when it has rows: the inbox by
 * type (a count per type, each linking where it is handled), extensions needing a look, plugins
 * with a newer marketplace version, model providers with problems, background work the kernel
 * could not queue (dead outbox rows, each with 重试 and 丢弃: transactional outbox spec §3.4) and
 * the run queue's lost jobs (Redis lost data; the runs were queued again: spec §8.3).
 * Reads the cached inbox (the layout prefetched it) and the attention lists, which are not
 * prefetched (a provider's model list may be slow), so this section draws its own skeleton and its
 * own error with 重试.
 */
export function AttentionSection() {
  const t = useTranslations("admin.overview.attention");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const aq = adminAttentionQuery();
  const iq = adminInboxQuery();
  const attention = useQuery({ ...aq, retryOnMount: retryOnMountOf(aq.queryKey) });
  const inbox = useQuery({ ...iq, retryOnMount: retryOnMountOf(iq.queryKey) });

  const pending = (q: { data: unknown; error: unknown }) => q.data === undefined && !q.error;
  // Still loading either read: the skeleton (never half the groups, then the rest).
  if (pending(attention) || pending(inbox)) {
    return (
      <OverviewSection title={t("title")} state="loading" loading={[{ kind: "list", items: 4 }]} />
    );
  }
  // Both failed: the section's error; one failed: its groups say so, the other's render.
  if (attention.data === undefined && inbox.data === undefined) {
    return (
      <OverviewSection
        title={t("title")}
        state="error"
        error={{
          summary: t("failed"),
          detail: [attention.error, inbox.error].map((e) => errorMessage(e)).join("\n"),
          onRetry: () => {
            void attention.refetch();
            void inbox.refetch();
          },
        }}
      />
    );
  }
  return (
    <OverviewSection title={t("title")} state="ready">
      <AttentionGroups
        attention={attention.data ?? null}
        inbox={inbox.data ?? null}
        retryAttention={() => void attention.refetch()}
        retryInbox={() => void inbox.refetch()}
        t={t}
        locale={locale}
      />
    </OverviewSection>
  );
}

/** What a failed read leaves: no lists, every source unavailable. */
const NO_ATTENTION: AdminAttention = {
  extensions: [],
  updates: [],
  providers: [],
  outbox: [],
  queue: [],
  more: { extensions: 0, updates: 0, providers: 0, outbox: 0, queue: 0 },
  unavailable: ["extensions", "updates", "providers", "outbox", "queue"],
};

function AttentionGroups({
  attention: read,
  inbox,
  retryAttention,
  retryInbox,
  t,
  locale,
}: {
  /** null: the attention read failed (its three groups say so, with 重试). */
  attention: AdminAttention | null;
  /** null: the inbox read failed (its group says so, with 重试). */
  inbox: PlatformInboxView | null;
  retryAttention(): void;
  retryInbox(): void;
  t: T;
  locale: string;
}) {
  const attention = read ?? NO_ATTENTION;
  const unavailable = new Set<string>(attention.unavailable);
  if (inbox === null) unavailable.add("inbox");
  const more = (source: Exclude<AttentionSource, "outbox" | "queue">): ItemListRow[] =>
    attention.more[source] > 0
      ? [
          {
            id: `more-${source}`,
            title: t("more", { n: attention.more[source] }),
            href: MORE_HREF[source],
          },
        ]
      : [];
  const byType = inbox?.byType;
  const inboxRows: ItemListRow[] =
    byType === undefined
      ? []
      : PLATFORM_INBOX_TYPES.filter((type) => (byType[type] ?? 0) > 0).map((type) => ({
          id: type,
          title: t(`inboxTypes.${type}`),
          status: { label: byType[type].toLocaleString("en-US"), tone: "accent" },
          href: platformInboxTypeHref(type),
        }));
  const extensionRows: ItemListRow[] = [
    ...attention.extensions.map((e) => ({
      id: e.name,
      mark: { text: displayNameOf(e, locale), image: e.icon },
      title: displayNameOf(e, locale),
      status: { label: reasonOf(e, t) },
      href: `/admin/extensions/${encodeURIComponent(e.name)}`,
    })),
    ...more("extensions"),
  ];
  const updateRows: ItemListRow[] = [
    ...attention.updates.map((u) => ({
      id: u.itemId,
      mark: { text: displayNameOf(u, locale), image: u.icon },
      title: displayNameOf(u, locale),
      ...(u.marketplaceName !== null && { meta: u.marketplaceName }),
      status: { label: `${versionLabel(u.version)} → ${versionLabel(u.marketplaceVersion)}` },
      href: `/admin/plugins/${encodeURIComponent(u.itemId)}`,
    })),
    ...more("updates"),
  ];
  const providerRows: ItemListRow[] = [
    ...attention.providers.map((p) => ({
      id: p.plugin,
      mark: {
        text: displayNameOf({ name: p.plugin, displayName: p.displayName }, locale),
        image: p.icon,
      },
      title: displayNameOf({ name: p.plugin, displayName: p.displayName }, locale),
      status: { label: t(`problems.${p.problem}`) },
      href: "/admin/models",
    })),
    ...more("providers"),
  ];
  const groups: { id: string; title: string; rows: ItemListRow[]; source: string }[] = [
    { id: "inbox", title: t("groups.inbox"), rows: inboxRows, source: "inbox" },
    { id: "extensions", title: t("groups.extensions"), rows: extensionRows, source: "extensions" },
    { id: "updates", title: t("groups.updates"), rows: updateRows, source: "updates" },
    { id: "providers", title: t("groups.providers"), rows: providerRows, source: "providers" },
    // its rows are read on their own (OutboxDeadList); the summary item only says there are some
    {
      id: "outbox",
      title: t("groups.outbox"),
      rows: attention.outbox.map((o) => ({ id: o.kind, title: o.kind })),
      source: "outbox",
    },
    {
      id: "queue",
      title: t("groups.queue"),
      rows: attention.queue.map((q) => ({
        id: q.kind,
        title: t("queue.lostJobs"),
        meta: t("queue.hint"),
        status: { label: t("queue.count", { n: q.count }), tone: "accent" },
      })),
      source: "queue",
    },
  ];
  // A group shows when it has rows, or when its list could not be read (it says so).
  const shown = groups.filter((g) => g.rows.length > 0 || unavailable.has(g.source));
  // A failed read (not a source the kernel reported) can be read again from its group.
  const retryOf = (g: { source: string }) =>
    g.source === "inbox"
      ? inbox === null
        ? retryInbox
        : null
      : read === null
        ? retryAttention
        : null;
  if (shown.length === 0) return <EmptyState size="panel" text={t("empty")} />;
  return shown.map((g) => {
    const retry = retryOf(g);
    const actions =
      retry !== null ? (
        <Button density="dense" onClick={retry}>
          {t("retry")}
        </Button>
      ) : g.id === "inbox" ? (
        <LinkButton href="/admin/inbox" density="dense">
          {t("viewInbox")}
        </LinkButton>
      ) : null;
    return (
      <Subsection
        key={g.id}
        title={g.title}
        variant="divided"
        {...(actions !== null ? { actions } : {})}
      >
        {unavailable.has(g.source) ? (
          <Text variant="prose" tone="muted">
            {t("unavailable")}
          </Text>
        ) : g.id === "outbox" ? (
          <OutboxDeadList label={g.title} summary={attention.outbox} t={t} />
        ) : (
          <ItemList label={g.title} rows={g.rows} />
        )}
      </Subsection>
    );
  });
}

/**
 * The dead outbox rows (transactional outbox spec §3.4): each with its job, queue and last error,
 * 重试 (queued again; dropped instead when the same job is owed already) and 丢弃 (after a
 * confirmation: the job never runs). Until the rows are read, the summary's count stands in.
 */
function OutboxDeadList({
  label,
  summary,
  t,
}: {
  label: string;
  summary: AttentionOutboxDead[];
  t: T;
}) {
  const errorMessage = useErrorMessage();
  const toast = useToast();
  const q = adminOutboxDeadQuery();
  const dead = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  const [discarding, setDiscarding] = useState<OutboxDeadRow | null>(null);
  const d = keys.deployment();
  const invalidates = () => [d.adminOverview(), d.platformAuditAll()];
  const retry = useAppMutation({
    fn: (id: string) => retryOutboxDead(id),
    invalidates,
    onSuccess: (r) =>
      toast.success(t(r.outcome === "retried" ? "outbox.retried" : "outbox.alreadyOwed")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const discard = useAppMutation({
    fn: (id: string) => discardOutboxDead(id),
    invalidates,
    onSuccess: () => toast.success(t("outbox.discarded")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const busy = retry.isPending || discard.isPending;
  const rows: ItemListRow[] =
    dead.data === undefined
      ? summary.map((o) => ({ id: o.kind, title: t("outbox.count", { n: o.count }) }))
      : dead.data.items.map((r) => ({
          id: r.id,
          title: r.jobName,
          meta: [r.queue, r.lastError].filter((x) => x !== null && x !== "").join(" · "),
          actions: (
            <>
              <Button density="dense" disabled={busy} onClick={() => retry.mutate(r.id)}>
                {t("outbox.retry")}
              </Button>
              <Button density="dense" disabled={busy} onClick={() => setDiscarding(r)}>
                {t("outbox.discard")}
              </Button>
            </>
          ),
        }));
  return (
    <>
      <ItemList label={label} rows={rows} />
      <Dialog
        open={discarding !== null}
        onOpenChange={(open) => {
          if (!open) setDiscarding(null);
        }}
        title={t("outbox.discardTitle")}
        danger
        initialFocus="cancel"
        footer={
          <>
            <Button onClick={() => setDiscarding(null)}>{t("outbox.cancel")}</Button>
            <Button
              variant="danger-solid"
              disabled={discard.isPending}
              onClick={() => {
                if (discarding === null) return;
                discard.mutate(discarding.id, { onSettled: () => setDiscarding(null) });
              }}
            >
              {t("outbox.discard")}
            </Button>
          </>
        }
      >
        <Text variant="prose">{t("outbox.discardHint", { job: discarding?.jobName ?? "" })}</Text>
      </Dialog>
    </>
  );
}
