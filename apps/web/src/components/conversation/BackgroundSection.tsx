"use client";

import { BackgroundTasks, PropertySection, type SubagentStatus } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { SubagentView } from "../../lib/conversations";
import { isActiveStatus } from "../../lib/subagents";

const statusOf = (s: string): SubagentStatus =>
  s === "queued" || s === "running" || s === "waiting" || s === "failed" || s === "aborted"
    ? s
    : "completed";

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
  const running = views.filter((v) => isActiveStatus(v.status));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (running.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running.length]);
  return (
    <PropertySection title={t("background")}>
      <BackgroundTasks
        items={views.map((v) => ({
          kind: "subagent",
          id: v.id,
          name: v.description || v.agentType,
          status: statusOf(v.status),
          startedAt: Date.parse(v.startedAt),
          ...(v.finishedAt ? { finishedAt: Date.parse(v.finishedAt) } : {}),
        }))}
        now={now}
        onStop={onStop}
        onOpen={onOpen}
      />
    </PropertySection>
  );
}
