"use client";

import { BackgroundTasks, PropertySection, subagentDuration } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { SubagentView } from "../../lib/conversations";
import { isActiveStatus } from "../../lib/subagents";

/**
 * The "Background tasks" properties section (spec §5.3, §5.6): the running sub-agents with their
 * time, each stoppable and openable, then "N completed ›" opening the newest finished one. Shown
 * only once the conversation has sub-agents.
 */
export function BackgroundSection({
  views,
  onStop,
  onOpen,
}: {
  /** `GET …/subagents`, newest first. */
  views: readonly SubagentView[];
  onStop(id: string): void;
  onOpen(id: string): void;
}) {
  const t = useTranslations("subagents");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const running = views.filter((v) => isActiveStatus(v.status));
  const done = views.filter((v) => !isActiveStatus(v.status));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (running.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running.length]);
  return (
    <PropertySection title={t("background")}>
      <BackgroundTasks
        running={running.map((v) => ({
          id: v.id,
          name: v.description || v.agentType,
          elapsed: subagentDuration(now - Date.parse(v.startedAt), locale),
        }))}
        completed={done.length}
        onStop={onStop}
        onOpen={onOpen}
        onCompleted={() => {
          const newest = done[0];
          if (newest) onOpen(newest.id);
        }}
      />
    </PropertySection>
  );
}
