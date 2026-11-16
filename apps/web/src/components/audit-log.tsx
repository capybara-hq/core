"use client";

import { CellTitle, type Column, DateTime, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { AuditEvent, AuditPage } from "../lib/admin";
import { auditActionKey } from "../lib/audit-actions";
import type { CursorSlice } from "./cursor-pages";

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

/** An audit page's rows and cursor, for `useCursorPages`. */
export const auditSlice = (p: AuditPage): CursorSlice<AuditEvent> => ({
  rows: p.events,
  next: p.next,
});
