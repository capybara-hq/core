"use client";

import { Badge, Card, CodeBlock, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { itemSensitive, type PackageWarning } from "../lib/admin-plugins";
import type { PermissionGroup } from "../lib/plugins";

/**
 * 插件权限审阅（只读）：后台安装确认页、插件详情的权限标签、组织插件设置与应用审阅共用（预检 F-T）。
 *
 * - 按类别分组；敏感分组用强调卡片并标「敏感」，写明为什么敏感（敏感能力逐项写原因）；敏感项以警示色显示；
 * - 网络访问一组标「声明，平台不拦截」；
 * - 给了 `added` / `removed`（升级、相对已批准快照）时列出新增 / 减少的权限键；
 * - 给了 `warnings`（迁移里的破坏性语句、DO 块）时逐条列出，同样算敏感。
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
  added?: string[];
  removed?: string[];
  warnings?: PackageWarning[];
}) {
  const t = useTranslations("plugins");
  const label = (category: string) =>
    t.has(`category.${category}`) ? t(`category.${category}`) : category;
  /** 敏感分组为什么敏感（敏感能力逐项一条）。 */
  const reasonsOf = (g: PermissionGroup): string[] => {
    if (!g.sensitive) return [];
    if (g.category === "provides") {
      return g.items
        .filter((i) => itemSensitive("provides", i))
        .map((c) => {
          const key = `review.capability.${c.split("@")[0]}`;
          return t.has(key) ? t(key) : c;
        });
    }
    const key = `review.reason.${g.category}`;
    return t.has(key) ? [t(key)] : [];
  };
  return (
    <section aria-label={t("permissionsLabel", { plugin })}>
      <Stack gap={12}>
        {groups.length === 0 && <Text tone="muted">{t("review.none")}</Text>}
        {groups.map((g) => {
          const reasons = reasonsOf(g);
          return (
            <Card key={g.category} tone={g.sensitive ? "accent" : "default"}>
              <Stack gap={4}>
                <Stack direction="row" gap={8} align="center">
                  <Text>{label(g.category)}</Text>
                  {g.sensitive && <Badge tone="accent">{t("sensitive")}</Badge>}
                </Stack>
                {reasons.map((r) => (
                  <Text key={r} variant="small" tone="warn">
                    {r}
                  </Text>
                ))}
                {g.category === "network" && (
                  <Text variant="small" tone="muted">
                    {t("review.network")}
                  </Text>
                )}
                {g.items.map((item) => (
                  <Text
                    key={item}
                    variant="small"
                    tone={g.sensitive && itemSensitive(g.category, item) ? "warn" : "muted"}
                  >
                    {`· ${item}`}
                  </Text>
                ))}
              </Stack>
            </Card>
          );
        })}
        {(added.length > 0 || removed.length > 0) && (
          <Stack gap={8}>
            {added.length > 0 && (
              <Stack gap={4}>
                <Text variant="small" tone="muted">
                  {t("review.added")}
                </Text>
                {added.map((k) => (
                  <Text key={k} variant="small" tone="warn">
                    {`+ ${k}`}
                  </Text>
                ))}
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
        {warnings.length > 0 && (
          <Card tone="danger">
            <Stack gap={8}>
              <Stack direction="row" gap={8} align="center">
                <Text>{t("review.warnings")}</Text>
                <Badge tone="accent">{t("sensitive")}</Badge>
              </Stack>
              <Text variant="small" tone="warn">
                {t("review.warningsHint")}
              </Text>
              {warnings.map((w) => (
                <Stack key={`${w.file}:${w.line}`} gap={4}>
                  <Text variant="small" tone="warn">
                    {`${t(`review.warning.${w.kind}`)} · ${t("review.at", { file: w.file, line: w.line })}`}
                  </Text>
                  <CodeBlock language="sql" text={w.statement} />
                </Stack>
              ))}
            </Stack>
          </Card>
        )}
      </Stack>
    </section>
  );
}
