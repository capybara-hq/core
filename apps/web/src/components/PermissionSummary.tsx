"use client";

import { Badge, Disclosure, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { PermissionGroup } from "../lib/extensions";

/**
 * An extension's permissions folded into one line (the 扩展 pages' Sheet): each category with its
 * count (「数据库表 2 · 智能体工具 1」; `provides` is left out, the capabilities show it) and the
 * 「敏感」 mark when any group is sensitive. The line opens the full permission blocks (`children`:
 * `PermissionReview`, plus the approval on the admin console).
 */
export function PermissionSummary({
  groups,
  sensitive,
  defaultOpen = false,
  children,
}: {
  groups: readonly PermissionGroup[];
  /** Overrides the groups' own marks (the admin view's `sensitive`, which counts warnings too). */
  sensitive?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("extensions");
  const label = (category: string) =>
    t.has(`categoryShort.${category}`)
      ? t(`categoryShort.${category}`)
      : t.has(`category.${category}`)
        ? t(`category.${category}`)
        : category;
  const parts = groups
    .filter((g) => g.category !== "provides" && g.items.length > 0)
    .map((g) => `${label(g.category)} ${g.items.length}`);
  const marked = sensitive ?? groups.some((g) => g.sensitive);
  return (
    <Disclosure
      defaultOpen={defaultOpen}
      summary={
        <Stack direction="row" gap={8} align="center">
          <Text>{t("permissions")}</Text>
          <Text tone="muted">{parts.length > 0 ? parts.join(" · ") : t("permissionsNone")}</Text>
          {marked && <Badge tone="warn">{t("sensitive")}</Badge>}
        </Stack>
      }
    >
      {children}
    </Disclosure>
  );
}
