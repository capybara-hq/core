"use client";

import { Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { PermissionScope } from "../lib/conversations";

/**
 * The exact reach a permission approval grants (permission profiles, "Exact scope display"), the
 * same in the conversation and the inbox: every read-write directory, read-only directory and
 * host as plain wrapping text (never clipped, never summarized, never a link), each directory
 * including its descendants; the target file is a separate, informational line, not a grant.
 * Nothing is inferred: no parent, sibling or root is added.
 */
export function PermissionScopeDetail({
  scope,
  targetPath,
}: {
  scope: PermissionScope;
  targetPath?: string | undefined;
}) {
  const t = useTranslations("approval.permissionScope");
  const groups: { key: string; label: string; values: string[] }[] = [
    { key: "write", label: t("write"), values: scope.writeDirectories },
    { key: "read", label: t("read"), values: scope.readDirectories },
    { key: "hosts", label: t("hosts"), values: scope.hosts },
  ];
  return (
    <div data-role="permission-scope">
      <Stack gap={8}>
        <Text variant="prose" tone="muted">
          {t("intro")}
        </Text>
        {groups
          .filter((g) => g.values.length > 0)
          .map((g) => (
            <div key={g.key} data-scope={g.key}>
              <Stack gap={4}>
                <Text variant="small" tone="muted">
                  {g.label}
                </Text>
                {g.values.map((v) => (
                  <Text key={v} variant="small" pre>
                    {v}
                  </Text>
                ))}
              </Stack>
            </div>
          ))}
        {targetPath !== undefined && (
          <div data-scope="target">
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {t("target")}
              </Text>
              <Text variant="small" pre>
                {targetPath}
              </Text>
            </Stack>
          </div>
        )}
      </Stack>
    </div>
  );
}
