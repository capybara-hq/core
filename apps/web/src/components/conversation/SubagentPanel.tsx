"use client";

import {
  Button,
  formatDuration,
  RightPanel,
  Spinner,
  StatusBar,
  SubagentTask,
  subagentWaitingLabel,
  ThreadHistory,
  useNow,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import type { ConversationEvent, ModelRef } from "../../lib/conversations";
import { conversationQuery } from "../../lib/query/conversation";
import { useWhoWaits } from "../../lib/query/who-waits";
import { subagentToolKeys, toolsLine } from "../../lib/subagents";
import {
  buildTimeline,
  latestModel,
  latestUsage,
  runStats,
  toolKeysOf,
  usedTokens,
  workedMsAt,
} from "../../lib/timeline";
import { useToolInfo } from "../../lib/tool-info";
import { Thread } from "./Thread";
import { useConversation } from "./useConversation";

type Started = Extract<ConversationEvent, { type: "subagent_started" }>["payload"];

export type SubagentPanelProps = {
  orgId: string;
  /** The conversation the panel opens in: only its own sub-agents are shown. */
  parentId: string;
  subagentId: string;
  /** The task name from the parent (dispatch or list); the panel's title. */
  description?: string;
  contextWindowOf(m: ModelRef): number | undefined;
  reasoningOf(m: ModelRef): boolean | undefined;
  /**
   * Opens an agent in the agent map (the record's own `Agent` calls: its sub-agents, and a
   * nested wait's transcript); absent: those calls have no open action.
   */
  onOpenAgent?(id: string, transcript?: boolean): void;
  /** Opens the agent map (the record's sub-agent groups' header link); absent: no link. */
  onOpenAgentMap?(): void;
  /** Back: what the right area showed before (e.g. the properties panel), else close. */
  onBack(): void;
  onClose(): void;
  onFullscreen(): void;
};

/**
 * A sub-agent opened on the right (`#subagent=<id>`, spec §5.6): its record read-only. The id comes
 * from the address bar, so it opens only a sub-agent of this conversation (the kernel authorizes
 * every read; this keeps another conversation from showing here with Stop).
 */
export function SubagentPanel(p: SubagentPanelProps) {
  const t = useTranslations("subagents.view");
  // The child's row (the record shares it): only a child of this conversation opens.
  const row = useQuery({ ...conversationQuery(p.orgId, p.subagentId), retry: false });
  const check: "pending" | "ok" | "failed" =
    row.data !== undefined
      ? row.data.parentConversationId === p.parentId
        ? "ok"
        : "failed"
      : row.error !== null
        ? "failed"
        : "pending";
  if (check === "ok") return <ChildRecord {...p} />;
  return (
    <RightPanel
      title={p.description || t("title")}
      label={check === "failed" ? t("title") : p.description || t("title")}
      onBack={p.onBack}
      onClose={p.onClose}
      onFullscreen={p.onFullscreen}
      state={check === "failed" ? "failed" : "loading"}
      failure={{ name: t("title"), reason: t("loadFailed") }}
    />
  );
}

/**
 * The child's record: header (back, task name, spinner and time, Stop while it runs), the task and
 * the "agent · subagent · model · tools" line, its own thread through the same events, stream and
 * timeline as any conversation, no composer, and a status bar saying it is read-only.
 */
function ChildRecord({
  orgId,
  subagentId,
  description,
  contextWindowOf,
  reasoningOf,
  onOpenAgent,
  onOpenAgentMap,
  onBack,
  onClose,
  onFullscreen,
}: SubagentPanelProps) {
  const t = useTranslations("subagents.view");
  const tc = useTranslations("chat");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const child = useConversation(orgId, subagentId);
  const keys = useMemo(() => toolKeysOf(child.events), [child.events]);
  const info = useToolInfo(orgId, subagentId, keys);
  const whoWaits = useWhoWaits(orgId, child.events);
  const entries = useMemo(
    () => buildTimeline(child.events, child.state.drafts, info, locale, { whoWaits }),
    [child.events, child.state.drafts, info, locale, whoWaits],
  );
  const started = child.events.find(
    (e): e is Extract<ConversationEvent, { type: "subagent_started" }> =>
      e.type === "subagent_started",
  )?.payload as Started | undefined;
  const model = latestModel(child.events);
  const active = child.running || child.waiting;
  // the latest run's working time (waits for a person left out, as the status bar counts it):
  // it ticks each second only while the child works and stops at a wait
  const stats = useMemo(() => runStats(child.events), [child.events]);
  const now = useNow(stats.resumedAt !== null ? 1000 : 0);
  const ms = workedMsAt(stats, now) ?? undefined;
  const duration =
    ms === undefined ? "" : formatDuration(ms, locale, { live: stats.endedAt === null });
  const waitingFor = child.waiting ? stats.waitingFor : null;
  const usage = latestUsage(child.events);
  const window_ = usage
    ? contextWindowOf({ provider: usage.provider, model: usage.model })
    : undefined;
  const pct =
    usage && window_ && window_ > 0 ? Math.round((usedTokens(usage) / window_) * 100) : null;
  const title = description || started?.agentType || t("title");
  // an org agent (not a template): its name links to the agent's page
  const orgAgentId = started?.template.source === "agent" ? started.template.id : undefined;
  return (
    <RightPanel
      title={title}
      onBack={onBack}
      meta={
        ms === undefined ? undefined : waitingFor !== null ? (
          // waiting for a person: the waiting word instead of the spinner, the time stopped
          `${subagentWaitingLabel(waitingFor, locale)} · ${duration}`
        ) : (
          <>
            {child.running ? <Spinner /> : null}
            {duration}
          </>
        )
      }
      actions={
        active ? (
          <Button aria-label={t("stop")} onClick={child.stop} disabled={child.stopping}>
            {tc("stop")}
          </Button>
        ) : undefined
      }
      onClose={onClose}
      onFullscreen={onFullscreen}
      body="subagent"
      footer={
        <StatusBar
          // no read-only copy (AC1): the missing composer says it
          context=""
          version=""
          system={pct === null ? [] : [tc("contextPct", { n: pct })]}
        />
      }
    >
      {child.history ? (
        <ThreadHistory state={child.history.state} onLoadEarlier={child.history.loadEarlier} />
      ) : null}
      <Thread
        live={false}
        orgId={orgId}
        conversationId={subagentId}
        entries={entries}
        info={info}
        reasoningOf={reasoningOf}
        {...(onOpenAgent ? { onOpenAgent } : {})}
        {...(onOpenAgentMap ? { onOpenAgentMap } : {})}
        renderTask={(e) => (
          <SubagentTask
            text={e.text}
            agent={started?.definition.name ?? ""}
            {...(orgAgentId ? { agentHref: `/agents/${encodeURIComponent(orgAgentId)}` } : {})}
            model={model?.model ?? ""}
            tools={toolsLine(subagentToolKeys(child.events), t("toolsNone"))}
          />
        )}
      />
    </RightPanel>
  );
}
