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

type UnresolvedHint =
  | "unresolvedOnSave"
  | "unresolvedPublicUrl"
  | "unresolvedWebhookBase"
  | "unresolved";

/**
 * Why each unresolved variable has no value, as one muted line per reason: on 新建渠道 saving the
 * channel fills the connection's name and webhook URL; the public URLs need `http.publicUrl` and a
 * saved connection's webhook URL needs `channels.webhookBaseUrl`, both deployment settings only a
 * super admin can change.
 */
function unresolvedHints(names: string[], saved: boolean): [UnresolvedHint, string[]][] {
  const reason = (n: string): UnresolvedHint => {
    if (!saved && (n === "connectionName" || n === "webhookUrl")) return "unresolvedOnSave";
    if (n === "publicUrl" || n === "signInCallbackUrl") return "unresolvedPublicUrl";
    if (n === "webhookUrl") return "unresolvedWebhookBase";
    return "unresolved";
  };
  const groups = new Map<UnresolvedHint, string[]>();
  for (const n of names) groups.set(reason(n), [...(groups.get(reason(n)) ?? []), n]);
  return [...groups];
}

/**
 * The body of a 接入指南 section (spec `2026-11-08-plugin-setup-guides-design.md` §5): a plugin's
 * setup guide rendered by the kernel for this org: the mode switch when the guide has per-mode
 * files (长连接 / Webhook, starting at the connection's mode), the steps, each template file in a
 * CodeBlock with its title and 复制, and muted lines naming the variables that have no value yet
 * (shown as written) and what fills them in. Plugin text is only ever text. Drawn inside the section's box (a form
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
      {unresolvedHints(g.unresolved, query.connectionId !== undefined).map(([key, names]) => (
        <Text key={key} variant="small" tone="muted">
          {t(`guide.${key}`, { names: names.map((n) => `{{${n}}}`).join(", ") })}
        </Text>
      ))}
    </Stack>
  );
}
