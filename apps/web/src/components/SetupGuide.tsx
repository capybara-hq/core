"use client";

import { CodeBlock, InstructionList, Segmented, Skeleton, Stack, Text } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { labelLocale } from "../lib/extension-label";
import { setupGuideQuery } from "../lib/query/channels";
import { guideText, type SetupGuideQuery, type SetupGuideRef } from "../lib/setup-guides";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * The body of a 接入指南 section (spec `2026-11-08-plugin-setup-guides-design.md` §5): a plugin's
 * setup guide rendered by the kernel for this org: the mode switch when the guide has per-mode
 * files (长连接 / Webhook, starting at the connection's mode), the steps, each template file in a
 * CodeBlock with its title and 复制, and one muted line naming the variables that have no value
 * yet (shown as written). Plugin text is only ever text. Drawn inside the section's box (a form
 * card or a Card), so the code blocks are unframed by themselves.
 */
export function SetupGuideBody({
  orgId,
  guide,
  query,
}: {
  orgId: string;
  guide: SetupGuideRef;
  /** The connection (its name, webhook URL and mode) or the name typed so far on 新建渠道. */
  query: Omit<SetupGuideQuery, "mode">;
}) {
  const t = useTranslations("channels");
  const lang = labelLocale(useLocale());
  const errorMessage = useErrorMessage();
  // Undefined: the kernel's default (the connection's mode, else the guide's first)
  const [mode, setMode] = useState<string>();
  const read = useQuery(setupGuideQuery(orgId, guide, { ...query, ...(mode && { mode }) }));
  if (read.data === undefined) {
    if (read.error !== null) return <FormError message={errorMessage(read.error)} />;
    return <Skeleton rows={4} />;
  }
  const g = read.data;
  const known = new Set(["long_connection", "webhook"]);
  return (
    <Stack gap={16}>
      <Text variant="h3">{guideText(g.title, lang)}</Text>
      {g.modes.length > 1 && (
        <Segmented
          label={t("guide.modeLabel")}
          value={g.mode ?? g.modes[0] ?? ""}
          onChange={setMode}
          options={g.modes.map((m) => ({
            value: m,
            label: known.has(m) ? t(`inboundMode.${m as "long_connection" | "webhook"}`) : m,
          }))}
        />
      )}
      {g.steps.length > 0 && (
        <InstructionList
          label={t("guide.stepsLabel")}
          items={g.steps.map((s) => guideText(s, lang))}
        />
      )}
      {g.files.map((f) => (
        <CodeBlock
          key={f.fileName}
          title={`${guideText(f.title, lang)} · ${f.fileName}`}
          language={f.language}
          text={f.content}
          copyable
        />
      ))}
      {g.unresolved.length > 0 && (
        <Text variant="small" tone="muted">
          {t("guide.unresolved", { names: g.unresolved.map((n) => `{{${n}}}`).join(", ") })}
        </Text>
      )}
    </Stack>
  );
}
