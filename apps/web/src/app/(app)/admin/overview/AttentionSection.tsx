"use client";

import {
  Button,
  EmptyState,
  ItemList,
  type ItemListRow,
  LinkButton,
  OverviewSection,
  Subsection,
  Text,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { AdminAttention, AttentionExtension, AttentionSource } from "../../../../lib/admin";
import {
  PLATFORM_INBOX_TYPES,
  type PlatformInboxView,
  platformInboxTypeHref,
} from "../../../../lib/admin-inbox";
import { displayNameOf } from "../../../../lib/catalog";
import { adminAttentionQuery, adminInboxQuery } from "../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useErrorMessage } from "../../../../lib/use-error-message";

type T = ReturnType<typeof useTranslations<"admin.overview.attention">>;

/** Where the "+n" row of a capped list leads: the page that lists them all. */
const MORE_HREF: Record<AttentionSource, string> = {
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
 * 待处理 (spec §6.1): one section with up to four groups, each only when it has rows: the inbox by
 * type (a count per type, each linking where it is handled), extensions needing a look, plugins
 * with a newer marketplace version and model providers with problems. Reads the cached inbox (the
 * layout prefetched it) and the attention lists, which are not prefetched (a provider's model list
 * may be slow), so this section draws its own skeleton and its own error with 重试.
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
  more: { extensions: 0, updates: 0, providers: 0 },
  unavailable: ["extensions", "updates", "providers"],
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
  const more = (source: AttentionSource): ItemListRow[] =>
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
        ) : (
          <ItemList label={g.title} rows={g.rows} />
        )}
      </Subsection>
    );
  });
}
