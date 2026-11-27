"use client";

import { Card, CopyField, Stack, StatusMark, Text, TextLink } from "@capybara-hq/design";
import { useTranslations } from "next-intl";

/**
 * A `gh auth login --web` device code (auto mode spec §6, P-D13): the GitHub device-login URL as a
 * link and the one-time code as a CopyField (the code line whose copy button reads "Copied" for two
 * seconds). The login runs inside the device's container; the kernel only echoes the prompt,
 * never the token. `ended` (its call ended: the code was used, or it expired or failed) draws the
 * one line the process block's rail keeps (#926), without the spent code.
 */
export function DeviceCodeCard({
  url,
  code,
  ended,
}: {
  url: string;
  code: string;
  ended?: "used" | "expired";
}) {
  const t = useTranslations("chat.deviceCode");
  if (ended !== undefined) {
    return (
      <div data-role="device-code" data-state={ended}>
        <Stack direction="row" gap={12} align="center" wrap>
          <Text variant="small">{t("title")}</Text>
          <StatusMark
            status={ended === "used" ? "success" : "cancelled"}
            label={t(ended === "used" ? "used" : "expired")}
          />
        </Stack>
      </div>
    );
  }
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
