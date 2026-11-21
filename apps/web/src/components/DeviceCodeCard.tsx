"use client";

import { Card, CopyField, Stack, Text, TextLink } from "@capybara-hq/design";
import { useTranslations } from "next-intl";

/**
 * A `gh auth login --web` device code (auto mode spec §6, P-D13): the GitHub device-login URL as a
 * link and the one-time code as a CopyField (the code line whose copy button reads 已复制 for two
 * seconds). The login runs inside the device's container; the kernel only echoes the prompt,
 * never the token.
 */
export function DeviceCodeCard({ url, code }: { url: string; code: string }) {
  const t = useTranslations("chat.deviceCode");
  return (
    <Card title={t("title")} tone="accent">
      <Stack gap={8}>
        <Text variant="prose">{t("body")}</Text>
        <CopyField label={t("codeLabel")} value={code} />
        <TextLink href={url}>{url}</TextLink>
      </Stack>
    </Card>
  );
}
