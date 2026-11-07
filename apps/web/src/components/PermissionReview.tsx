"use client";

import { Badge, CodeBlock, ItemList, ItemListItem, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { PackageWarning } from "../lib/admin-extensions";
import type { PermissionGroup, PermissionItem } from "../lib/extensions";

/**
 * 插件权限审阅（只读）：后台安装确认页、插件详情的权限标签、组织插件设置与应用审阅共用（预检 F-T）。
 * 敏感判定全在内核（分组 `sensitive`、逐项 `entries[].sensitive` 与原因码），这里只渲染：
 *
 * - 按类别分组：one ItemList row per category (hairlines, never cards: the review sits in a card,
 *   a Sheet or a Dialog); only the 「敏感」 mark after a sensitive group's title is yellow (warn);
 *   its reasons are muted meta lines and its items the plain muted list in the row's body;
 * - 网络访问一组标「声明，平台不拦截」；
 * - 给了 `added` / `removed`（升级、相对已批准快照）时列出新增（a sensitive one carries the mark and its
 *   reason）/ 减少的权限键；
 * - 给了 `warnings`（迁移里的破坏性语句、DO 块）时逐条列出，同样算敏感：the last row, its hint a warn
 *   line with the `circle-alert` icon, its body each statement's place and its (borderless) code.
 */
export function PermissionReview({
  plugin,
  groups,
  added = [],
  removed = [],
  warnings = [],
}: {
  plugin: string;
  groups: PermissionGroup[];
  added?: PermissionItem[];
  removed?: string[];
  warnings?: PackageWarning[];
}) {
  const t = useTranslations("extensions");
  const label = (category: string) =>
    t.has(`category.${category}`) ? t(`category.${category}`) : category;
  const reasonText = (item: PermissionItem): string | null => {
    if (item.reason === undefined) return null;
    const key = `review.reason.${item.reason}`;
    return t.has(key) ? t(key) : item.reason;
  };
  /** 一组里敏感项的原因（去重，按出现顺序）。 */
  const reasonsOf = (g: PermissionGroup): string[] => [
    ...new Set(
      g.entries.flatMap((e) => {
        const r = e.sensitive ? reasonText(e) : null;
        return r === null ? [] : [r];
      }),
    ),
  ];
  return (
    <section aria-label={t("permissionsLabel", { plugin })}>
      <Stack gap={12}>
        {groups.length === 0 && <Text tone="muted">{t("review.none")}</Text>}
        {/* One row per category, split by hairlines, never a card (spec §6.33 "A review row"):
            the review sits in a card, a Sheet or a Dialog, which is the one box */}
        {(groups.length > 0 || warnings.length > 0) && (
          // The section is named "<plugin> 的权限"; the list inside it is just "权限" (no
          // duplicate accessible name).
          <ItemList label={t("permissions")}>
            {groups.map((g) => {
              const meta = [
                ...reasonsOf(g),
                ...(g.category === "network" ? [t("review.network")] : []),
              ];
              return (
                <ItemListItem
                  key={g.category}
                  title={label(g.category)}
                  {...(g.sensitive && { marks: <Badge tone="warn">{t("sensitive")}</Badge> })}
                  {...(meta.length > 0 && {
                    meta: meta.map((r) => (
                      <Text key={r} variant="small" tone="muted">
                        {r}
                      </Text>
                    )),
                  })}
                >
                  {g.entries.length > 0 && (
                    <Stack gap={4}>
                      {g.entries.map((e) => (
                        <Text key={e.value} variant="small" tone="muted">
                          {`· ${e.value}`}
                        </Text>
                      ))}
                    </Stack>
                  )}
                </ItemListItem>
              );
            })}
            {/* The danger block: a row whose meta is a warn line, its body each statement's
                place and its code (borderless inside the box) */}
            {warnings.length > 0 && (
              <ItemListItem
                title={t("review.warnings")}
                marks={<Badge tone="warn">{t("sensitive")}</Badge>}
                meta={
                  <Text variant="small" tone="warn" icon="circle-alert">
                    {t("review.warningsHint")}
                  </Text>
                }
              >
                {warnings.map((w) => (
                  <Stack key={`${w.file}:${w.line}`} gap={4}>
                    <Text variant="small" tone="warn">
                      {`${t(`review.warning.${w.kind}`)} · ${t("review.at", { file: w.file, line: w.line })}`}
                    </Text>
                    <CodeBlock language="sql" text={w.statement} />
                  </Stack>
                ))}
              </ItemListItem>
            )}
          </ItemList>
        )}
        {(added.length > 0 || removed.length > 0) && (
          <Stack gap={8}>
            {added.length > 0 && (
              <Stack gap={4}>
                <Text variant="small" tone="muted">
                  {t("review.added")}
                </Text>
                {added.map((a) => {
                  const r = a.sensitive ? reasonText(a) : null;
                  return (
                    <Stack key={a.value} direction="row" gap={8} align="center">
                      <Text variant="small">
                        {r === null ? `+ ${a.value}` : `+ ${a.value} · ${r}`}
                      </Text>
                      {a.sensitive && <Badge tone="warn">{t("sensitive")}</Badge>}
                    </Stack>
                  );
                })}
              </Stack>
            )}
            {removed.length > 0 && (
              <Stack gap={4}>
                <Text variant="small" tone="muted">
                  {t("review.removed")}
                </Text>
                {removed.map((k) => (
                  <Text key={k} variant="small" tone="muted">
                    {k}
                  </Text>
                ))}
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
    </section>
  );
}
