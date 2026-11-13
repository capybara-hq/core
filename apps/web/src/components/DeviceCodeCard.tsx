"use client";

import { Button, Card, Icon, Kbd, Stack, Text, TextLink } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

/**
 * A `gh auth login --web` device code (auto mode spec §6, P-D13): the GitHub device-login URL as a
 * link, the one-time code in mono, and a copy button that reads 已复制 for two seconds. The login
 * runs inside the device's container; the kernel only echoes the prompt, never the token.
 */
export function DeviceCodeCard({ url, code }: { url: string; code: string }) {
  const t = useTranslations("chat.deviceCode");
  const codeRef = useRef<HTMLSpanElement>(null);
  const [copied, setCopied] = useState<"no" | "yes" | "manual">("no");
  useEffect(() => {
    if (copied !== "yes") return;
    const timer = setTimeout(() => setCopied("no"), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
        throw new Error("no clipboard");
      }
      await navigator.clipboard.writeText(code);
      setCopied("yes");
    } catch {
      // Without a usable clipboard, select the code so it can be copied by hand.
      const node = codeRef.current;
      const selection = typeof window === "undefined" ? null : window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopied("manual");
    }
  };
  return (
    <Card title={t("title")} tone="accent">
      <Stack gap={8}>
        <Text variant="prose">{t("body")}</Text>
        <Stack gap={8} direction="row" align="center" wrap>
          <Text variant="small" tone="muted" as="span">
            {t("codeLabel")}
          </Text>
          <span ref={codeRef}>
            <Kbd>{code}</Kbd>
          </span>
          <Button density="dense" onClick={() => void copy()}>
            <Icon name={copied === "yes" ? "check" : "copy"} size={14} />
            {copied === "yes" ? t("copied") : copied === "manual" ? t("copyManual") : t("copy")}
          </Button>
        </Stack>
        <TextLink href={url}>{url}</TextLink>
      </Stack>
    </Card>
  );
}
