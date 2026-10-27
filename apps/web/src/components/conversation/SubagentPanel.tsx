"use client";

import {
  Button,
  RightPanel,
  Spinner,
  StatusBar,
  SubagentTask,
  subagentDuration,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { type ConversationEvent, getConversation, type ModelRef } from "../../lib/conversations";
import { toolsLine } from "../../lib/subagents";
import {
  buildTimeline,
  latestModel,
  latestUsage,
  toolKeysOf,
  usedTokens,
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
  onClose(): void;
  onFullscreen(): void;
};

/** Re-renders every second while `active` (the header's running time). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * A sub-agent opened on the right (`#subagent=<id>`, spec §5.6): its record read-only. The id comes
 * from the address bar, so it opens only a sub-agent of this conversation (the kernel authorizes
 * every read; this keeps another conversation from showing here with Stop).
 */
export function SubagentPanel(p: SubagentPanelProps) {
  const t = useTranslations("subagents.view");
  const [check, setCheck] = useState<"pending" | "ok" | "failed">("pending");
  useEffect(() => {
    let live = true;
    getConversation(p.orgId, p.subagentId).then(
      ({ conversation }) => {
        if (live) setCheck(conversation.parentConversationId === p.parentId ? "ok" : "failed");
      },
      () => {
        if (live) setCheck("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [p.orgId, p.subagentId, p.parentId]);
  if (check === "ok") return <ChildRecord {...p} />;
  return (
    <RightPanel
      title={p.description || t("title")}
      label={check === "failed" ? t("title") : p.description || t("title")}
      onBack={p.onClose}
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
  onClose,
  onFullscreen,
}: SubagentPanelProps) {
  const t = useTranslations("subagents.view");
  const tc = useTranslations("chat");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const child = useConversation(orgId, subagentId);
  const keys = useMemo(() => toolKeysOf(child.events), [child.events]);
  const info = useToolInfo(orgId, subagentId, keys);
  const entries = useMemo(
    () => buildTimeline(child.events, child.state.drafts, info, locale),
    [child.events, child.state.drafts, info, locale],
  );
  const started = child.events.find(
    (e): e is Extract<ConversationEvent, { type: "subagent_started" }> =>
      e.type === "subagent_started",
  )?.payload as Started | undefined;
  const model = latestModel(child.events);
  const active = child.running || child.waiting;
  const now = useNow(active);
  // the latest run: its start, and its end once it is over
  let runStart: number | undefined;
  let runEnd: number | undefined;
  for (const e of child.events) {
    if (e.type === "run_started") {
      runStart = Date.parse(e.createdAt);
      runEnd = undefined;
    } else if (e.type === "run_finished" || e.type === "run_failed" || e.type === "run_aborted") {
      runEnd = Date.parse(e.createdAt);
    }
  }
  const ms = runStart === undefined ? undefined : (active ? now : (runEnd ?? now)) - runStart;
  const usage = latestUsage(child.events);
  const window_ = usage
    ? contextWindowOf({ provider: usage.provider, model: usage.model })
    : undefined;
  const pct =
    usage && window_ && window_ > 0 ? Math.round((usedTokens(usage) / window_) * 100) : null;
  const title = description || started?.agentType || t("title");
  return (
    <RightPanel
      title={title}
      onBack={onClose}
      meta={
        ms === undefined ? undefined : (
          <>
            {active ? <Spinner /> : null}
            {subagentDuration(ms, locale)}
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
          context={t("readOnly")}
          version=""
          system={pct === null ? [] : [tc("contextPct", { n: pct })]}
        />
      }
    >
      <Thread
        orgId={orgId}
        conversationId={subagentId}
        entries={entries}
        info={info}
        reasoningOf={reasoningOf}
        renderTask={(e) => (
          <SubagentTask
            text={e.text}
            agent={started?.definition.name ?? ""}
            model={model?.model ?? ""}
            tools={toolsLine(started?.definition.tools, t("toolsNone"))}
          />
        )}
      />
    </RightPanel>
  );
}
