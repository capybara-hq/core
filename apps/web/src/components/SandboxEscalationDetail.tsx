"use client";

import { Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";

/**
 * A per-call sandbox escalation ask (approval profiles design, "Per-call sandbox escalation"): the
 * command runs outside the OS sandbox for this call only, with full access to the device's files
 * and network. Shows that consequence, the directory the command runs in and the agent's
 * justification as plain wrapping text (the agent wrote it: never a link, never clipped). The
 * command itself is the card's command block.
 */
export function SandboxEscalationDetail({
  justification,
  workingRoot,
}: {
  justification: string;
  workingRoot?: string | undefined;
}) {
  const t = useTranslations("approval.escalation");
  return (
    <div data-role="sandbox-escalation">
      <Stack gap={8}>
        <Text variant="prose">{t("intro")}</Text>
        {workingRoot !== undefined && (
          <div data-escalation="cwd">
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {t("cwd")}
              </Text>
              <Text variant="small" pre>
                {workingRoot}
              </Text>
            </Stack>
          </div>
        )}
        <div data-escalation="justification">
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("justification")}
            </Text>
            <Text variant="small" pre>
              {justification}
            </Text>
          </Stack>
        </div>
      </Stack>
    </div>
  );
}
