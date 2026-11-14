"use client";

import { Spinner, Stack, Text, useNow } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { CompactionProgress } from "../../lib/stream";

/**
 * The compacting row (context compaction spec §4.6): shown at the end of the thread while a run
 * summarises its history, until `compaction_summary` / `compaction_failed` replaces it with the
 * saved-tokens divider. Spinner and elapsed time; `i/N` only in the chunked path (the single-call
 * path has no real fraction, so it never shows one).
 */
export function CompactingRow({ progress }: { progress: CompactionProgress }) {
  const t = useTranslations("chat");
  const now = useNow(1000);
  const seconds = Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  const elapsed = t("compactingElapsed", { seconds });
  const text =
    progress.chunk !== undefined && progress.chunks !== undefined
      ? `${t("compacting")} · ${t("compactingChunk", { chunk: progress.chunk, chunks: progress.chunks })} · ${elapsed}`
      : `${t("compacting")} · ${elapsed}`;
  return (
    <div data-role="compacting-row" role="status">
      <Stack direction="row" gap={8} align="center">
        <Spinner size={16} />
        <Text variant="small" tone="muted">
          {text}
        </Text>
      </Stack>
    </div>
  );
}
