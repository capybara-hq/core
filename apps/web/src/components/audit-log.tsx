"use client";

import { CellTitle, type Column, DateTime, Text, useToast } from "@capybara-hq/design";
import { type UseQueryOptions, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { AuditEvent, AuditPage } from "../lib/admin";
import type { ApiClientError } from "../lib/api";
import { auditActionKey } from "../lib/audit-actions";
import { useErrorMessage } from "../lib/use-error-message";

/**
 * An audit table's columns, shared by the admin overview, `/admin/audit` and the org's
 * `/settings/audit` (admin overview spec §6.4): Time, Actor (the name, System for the kernel, with
 * "Through an agent" / "Personal token" under it), Action (its label, or the raw action in mono
 * when it has none) and Target (mono).
 */
export function useAuditColumns(): Column<AuditEvent>[] {
  const t = useTranslations("admin.audit");
  return [
    {
      key: "at",
      header: t("columns.time"),
      tone: "muted",
      fit: true,
      cell: (e) => <DateTime value={e.at} />,
    },
    {
      key: "actor",
      header: t("columns.actor"),
      cell: (e) => {
        const name =
          e.actor === null ? t("system") : (e.actor.name ?? e.actor.email ?? t("deletedAccount"));
        const via = [
          ...(e.viaAgent ? [t("viaAgent")] : []),
          ...(e.viaToken ? [t("viaToken")] : []),
        ].join(" · ");
        return <CellTitle title={name} {...(via !== "" ? { description: via } : {})} />;
      },
    },
    {
      key: "action",
      header: t("columns.action"),
      cell: (e) => {
        const key = auditActionKey(e.action);
        return key === null ? (
          <Text variant="body">{e.action}</Text>
        ) : (
          <Text variant="prose">{t(`actions.${key}`)}</Text>
        );
      },
    },
    {
      key: "target",
      header: t("columns.target"),
      tone: "muted",
      cell: (e) => <Text variant="body">{e.target ?? "—"}</Text>,
    },
  ];
}

/**
 * The rows of an audit log shown by Load more: the first page (from the query cache) and the later
 * pages read through the cache by cursor (`pageQuery(after)`) and appended. Later pages belong to
 * the first page they continue: a newer first page starts over.
 */
export function useAuditPages(
  first: AuditPage,
  pageQuery: (after: string) => UseQueryOptions<AuditPage, ApiClientError>,
): { rows: AuditEvent[]; next: string | null; loadingMore: boolean; loadMore: () => void } {
  const qc = useQueryClient();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [more, setMore] = useState<{ source: AuditPage; pages: AuditPage[] }>({
    source: first,
    pages: [],
  });
  const pages = more.source === first ? more.pages : [];
  const rows = [...first.events, ...pages.flatMap((p) => p.events)];
  const next = pages.length > 0 ? (pages[pages.length - 1] as AuditPage).next : first.next;
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = () => {
    if (next === null) return;
    setLoadingMore(true);
    qc.fetchQuery(pageQuery(next))
      .then((page) => setMore({ source: first, pages: [...pages, page] }))
      .catch((e: unknown) => toast.error(errorMessage(e)))
      .finally(() => setLoadingMore(false));
  };
  return { rows, next, loadingMore, loadMore };
}
