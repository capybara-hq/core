"use client";

import { Button, Dialog, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";

/**
 * The dialog a shell shows while an authorization finishes in the system browser (spec
 * 2026-11-28-shell-external-authorization-design.md §4): what happens in the browser tab, Copy
 * link (for another browser), Done (refresh and close) and Cancel. Stateless: the external
 * authorization provider holds the link and decides when it closes.
 */
export function ExternalAuthDialog({
  open,
  onCopy,
  onDone,
  onCancel,
}: {
  open: boolean;
  onCopy(): void;
  onDone(): void;
  onCancel(): void;
}) {
  const t = useTranslations("externalAuth");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={t("title")}
      footer={
        <>
          <Button onClick={onCancel}>{t("cancel")}</Button>
          <Button onClick={onCopy}>{t("copy")}</Button>
          <Button variant="primary" onClick={onDone}>
            {t("done")}
          </Button>
        </>
      }
    >
      <Text variant="prose">{t("body")}</Text>
    </Dialog>
  );
}
