"use client";

import {
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

  if (attention.data === undefined || inbox.data === undefined) {
    const failed = [attention, inbox].filter((q) => q.data === undefined && q.error);
    if (failed.length > 0) {
      return (
        <OverviewSection
          title={t("title")}
          state="error"
          error={{
            summary: t("failed"),
            detail: failed.map((q) => errorMessage(q.error)).join("\n"),
            // only what failed is read again
            onRetry: () => {
              for (const q of failed) void q.refetch();
            },
          }}
        />
      );
    }
    return (
      <OverviewSection title={t("title")} state="loading" loading={[{ kind: "list", items: 4 }]} />
    );
  }
  return (
    <OverviewSection title={t("title")} state="ready">
      <AttentionGroups attention={attention.data} inbox={inbox.data} t={t} locale={locale} />
    </OverviewSection>
  );
}

function AttentionGroups({
  attention,
  inbox,
  t,
  locale,
}: {
  attention: AdminAttention;
  inbox: PlatformInboxView;
  t: T;
  locale: string;
}) {
  const unavailable = new Set(attention.unavailable);
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
  const inboxRows: ItemListRow[] = PLATFORM_INBOX_TYPES.filter(
    (type) => (inbox.byType[type] ?? 0) > 0,
  ).map((type) => ({
    id: type,
    title: t(`inboxTypes.${type}`),
    status: { label: inbox.byType[type].toLocaleString("en-US"), tone: "accent" },
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
  const groups: { id: string; title: string; rows: ItemListRow[]; source?: AttentionSource }[] = [
    { id: "inbox", title: t("groups.inbox"), rows: inboxRows },
    { id: "extensions", title: t("groups.extensions"), rows: extensionRows, source: "extensions" },
    { id: "updates", title: t("groups.updates"), rows: updateRows, source: "updates" },
    { id: "providers", title: t("groups.providers"), rows: providerRows, source: "providers" },
  ];
  // A group shows when it has rows, or when its list could not be read (it says so).
  const shown = groups.filter(
    (g) => g.rows.length > 0 || (g.source !== undefined && unavailable.has(g.source)),
  );
  if (shown.length === 0) return <EmptyState size="panel" text={t("empty")} />;
  return shown.map((g) => (
    <Subsection
      key={g.id}
      title={g.title}
      variant="divided"
      {...(g.id === "inbox"
        ? {
            actions: (
              <LinkButton href="/admin/inbox" density="dense">
                {t("viewInbox")}
              </LinkButton>
            ),
          }
        : {})}
    >
      {g.source !== undefined && unavailable.has(g.source) ? (
        <Text variant="prose" tone="muted">
          {t("unavailable")}
        </Text>
      ) : (
        <ItemList label={g.title} rows={g.rows} />
      )}
    </Subsection>
  ));
}
