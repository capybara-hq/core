"use client";

import {
  type ConversationPageProps,
  elapsed,
  type PickerProps,
  RenameDialog,
  Stack,
  type TitleBarMenuItem,
  untitledLabel,
  useNow,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { avatarValue } from "../../lib/agents";
import type { ModelRef } from "../../lib/conversations";
import { agentsQuery } from "../../lib/query/agents";
import { retryOnMountOf } from "../../lib/query/client";
import { modelsQuery, renameWithRow, sentHereOf } from "../../lib/query/conversation";
import { keys as queryKeys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { useWhoWaits } from "../../lib/query/who-waits";
import { runParts } from "../../lib/run-row";
import { usageTotal, useSubagents, useUsageWithSubagents } from "../../lib/subagents";
import {
  AWAIT_RUN_MS,
  awaitedMessage,
  awaitingRun,
  buildEventTimeline,
  type FailedRun,
  latestModel,
  latestUsage,
  runStats,
  toolKeysOf,
  usedTokens,
  withDrafts,
  workingLineVisible,
} from "../../lib/timeline";
import { useToolInfo } from "../../lib/tool-info";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";
import { statusPrompt } from "../shell/nav";
import { usePagePath } from "../shell/path";
import { useSession } from "../shell/session";
import { ComposerBar, type ComposerMessage, newClientMessageId } from "./ComposerBar";
import { PendingBubbles, usePendingSends } from "./PendingBubbles";
import { useRightAreaSlot } from "./RightArea";
import { Thread, type ThreadProps } from "./Thread";
import { type SendResult, useConversation } from "./useConversation";
import { QueueList, useQueue } from "./useQueue";
import { useSelection } from "./useSelection";

/**
 * The conversation status bar's prompt and time zone, signed like every page's
 * (`<login>@<slug>:~/chat/<id>`, spec §4.4): `path` is the page's path.
 */
export function useStatusSignature(path: string): { context: string; timeZone?: string } {
  const { me, timeZone } = useSession();
  const slug = me.memberships.find((m) => m.orgId === me.currentOrgId)?.slug ?? null;
  return {
    context: statusPrompt(me.account.displayName, slug, path),
    ...(timeZone !== undefined ? { timeZone } : {}),
  };
}

/**
 * "第 N 轮 · 已用 <elapsed>" in the status bar. It ticks each second on its own, only while a run
 * is going (not while it waits for a person), so the page does not re-render each second (I3).
 */
function RunStatsText({
  turns,
  startedAt,
  endedAt,
  ticking,
}: {
  turns: number;
  startedAt: number | null;
  endedAt: number | null;
  ticking: boolean;
}) {
  const t = useTranslations("chat");
  const locale = useLocale() === "zh" ? "zh" : "en";
  // the server's time while hydrating (a running run's elapsed time then matches its render)
  const now = useNow(ticking ? 1000 : 0);
  const ms = startedAt === null ? null : (endedAt ?? now) - startedAt;
  return <>{t("stats", { n: turns, elapsed: ms === null ? "—" : elapsed(ms, locale) })}</>;
}

/**
 * The time `awaitingRun` reads, re-rendering once when the awaited message's run is overdue
 * ({@link AWAIT_RUN_MS} after it): the working line and the running mode then follow the log.
 */
function useAwaitBackstop(sentAt: number | undefined): number {
  const [, setTick] = useState(0);
  const due = sentAt === undefined ? null : sentAt + AWAIT_RUN_MS + 1;
  useEffect(() => {
    if (due === null) return;
    const wait = due - Date.now();
    if (wait <= 0) return;
    const id = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(id);
  }, [due]);
  return Date.now();
}

/** What Task 20 adds around the thread: the right area (title-bar panels, properties, panel). */
export type RightAreaSlot = {
  titleBarPanels: ConversationPageProps["titleBar"]["panels"];
  properties: { pressed: boolean; onToggle(): void };
  right: "none" | "properties" | "panel";
  propertiesNode?: ReactNode;
  panelNode?: ReactNode;
  /** The agent map dialog while the hash names it (agent map spec §9). */
  agentMap?: ReactNode;
  onCloseRight(): void;
  /** The open area's read is on its way (its loading state; `title`: the open panel's). */
  loading?: true | { title: string };
  thread: Pick<
    ThreadProps,
    | "onOpenFile"
    | "onMoreFiles"
    | "onOpenOutput"
    | "selectedFile"
    | "removedFiles"
    | "filePaths"
    | "renderCard"
    | "openSubagent"
    | "onOpenSubagent"
    | "onOpenAgentMap"
    | "onOpenTask"
  >;
};

/**
 * The conversation page (`/chat/<id>`, spec §5) as `ConversationPage` props: the title bar (title,
 * rename, properties, panels), the thread built by `lib/timeline.ts`, the queue, the composer
 * (pickers, ↵ / ⌘↵) and the status bar; `dialogs` go next to the page. Use it in a component keyed
 * by the conversation id: everything here (drafts, queue, picks, the right area) belongs to one
 * conversation and never shows under another. Everything comes from the query cache (the
 * layout's prefetch on a first load); what is not cached yet draws the template's loading state
 * (spec §7.1): the thread while the log loads (the composer stays, only send waits), the title
 * while the row loads, the open right area while its read is on its way.
 */
export function useConversationPage(
  orgId: string,
  conversationId: string,
): { page: ConversationPageProps; dialogs: ReactNode } {
  const t = useTranslations("chat");
  const ts = useTranslations("subagents");
  const tp = useTranslations("chatPanel");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const session = useSession();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const signature = useStatusSignature(`/chat/${conversationId.slice(0, 8)}`);
  const conv = useConversation(orgId, conversationId);
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data
    ?.agents;
  const agent = agents?.find((a) => a.id === conv.conversation?.agentId);
  // The title bar path `<org slug> / <agent> /` before the title (spec §3.5).
  const path = usePagePath(
    "org",
    ...(agent ? [{ label: agent.definition.name, href: `/agents/${agent.id}` }] : []),
  );
  // The agent's segment leads with its avatar (16, spec §6.30), from the cached agents.
  const titlePath = agent
    ? path.map((seg, i) =>
        i === path.length - 1 ? { ...seg, avatar: avatarValue(agent, orgId) } : seg,
      )
    : path;
  const modelsQ = modelsQuery(orgId);
  const providers = useQuery({ ...modelsQ, retryOnMount: retryOnMountOf(modelsQ.queryKey) }).data
    ?.providers;
  const selection = useSelection(providers, agent, conv.conversation?.selection);
  const keys = useMemo(() => toolKeysOf(conv.events), [conv.events]);
  const info = useToolInfo(orgId, conversationId, keys);
  const subagents = useSubagents(
    orgId,
    conversationId,
    conv.events,
    conv.state.progress,
    conv.seedProgress,
  );
  const usageAll = useUsageWithSubagents(orgId, conversationId, conv.events);
  const views = useMemo(
    () => (subagents.views ? new Map(subagents.views.map((v) => [v.id, v])) : undefined),
    [subagents.views],
  );
  const whoWaits = useWhoWaits(orgId, conv.events);
  // The log's timeline is rebuilt when the log changes; a delta frame only adds the drafts (I3).
  const base = useMemo(
    () =>
      buildEventTimeline(conv.events, info, locale, {
        progress: conv.state.progress,
        ...(views ? { views } : {}),
        whoWaits,
      }),
    [conv.events, info, locale, conv.state.progress, views, whoWaits],
  );
  const entries = useMemo(() => withDrafts(base, conv.state.drafts), [base, conv.state.drafts]);
  const queue = useQueue(orgId, conversationId, conv.merge, conv.events);
  const pending = usePendingSends(conv.events);
  const [renaming, setRenaming] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const qc = useQueryClient();
  const sentHere = sentHereOf(qc, orgId, conversationId);
  // One source for the composer's mode, the status bar and the working line (review fix L1, L2):
  // a pending send of this view, a message this tab sent that waits for its run, or a run per the
  // log. While any holds, ↵ queues.
  // (not memoized: the set changes with this view's sends, each of which re-renders it)
  const awaited = awaitedMessage(conv.events, sentHere);
  const awaitAt = useAwaitBackstop(
    awaited?.type === "user_message" && awaited.payload.clientMessageId !== undefined
      ? sentHere.get(awaited.payload.clientMessageId)
      : undefined,
  );
  const awaiting = awaitingRun(conv.events, sentHere, { paused: queue.paused, now: awaitAt });
  const busy = conv.running || pending.shown.length > 0 || awaiting;
  const active = busy || conv.waiting;
  const stats = useMemo(() => runStats(conv.events), [conv.events]);

  // The message shows at once as a pending bubble, until the log has it (spec §2.1).
  const send = async (m: ComposerMessage): Promise<SendResult> => {
    const pick = selection.pending;
    sentHere.set(m.clientMessageId, Date.now());
    pending.add(m);
    const r = await conv.send({ ...m, ...pick });
    // on success the log already holds it; on failure the text goes back to the composer (and a
    // message the kernel wrote but could not deliver waits for no run here)
    if (!r.ok) sentHere.delete(m.clientMessageId);
    pending.drop(m.clientMessageId);
    if (r.ok) selection.sent(pick);
    return r;
  };

  // ↵ while running: the queued message carries the pick, applied when it is sent (final review I1).
  const enqueue = async (m: ComposerMessage): Promise<SendResult> => {
    const pick = selection.pending;
    // sent after the turn: its run is this tab's to wait for too
    sentHere.set(m.clientMessageId, Date.now());
    const r = await queue.add({ ...m, ...pick });
    if (r.ok) selection.sent(pick);
    else sentHere.delete(m.clientMessageId);
    return r;
  };

  const retry = (d: FailedRun) => {
    if (d.retry === null) return;
    const pick = selection.pending;
    const clientMessageId = newClientMessageId();
    sentHere.set(clientMessageId, Date.now());
    void conv
      .send({
        text: d.retry.text,
        clientMessageId,
        files: d.retry.files.map((f) => f.attachmentId),
        retryOf: d.retry.seq,
        ...(d.retry.skill !== undefined ? { skill: { name: d.retry.skill } } : {}),
        ...pick,
      })
      .then((r) => {
        if (r.ok) selection.sent(pick);
        else sentHere.delete(clientMessageId);
      });
  };

  // The answer is the new row; the sidebar shows the title too. The row takes the title before
  // the kernel answers, so the stream's `changed: title` for this rename finds it unchanged and
  // reads the sidebar's groups no second time (the invalidation below is the one read).
  const renameMutation = useAppMutation({
    fn: (title: string) => renameWithRow(qc, orgId, conversationId, title),
    invalidates: () => [queryKeys.org(orgId).conversationGroupsAll()],
  });
  const rename = async (title: string) => {
    setRenameBusy(true);
    try {
      await renameMutation.mutateAsync(title);
      setRenaming(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRenameBusy(false);
    }
  };

  const menu: TitleBarMenuItem[] = [
    { id: "rename", label: t("rename"), icon: "square-pen", onSelect: () => setRenaming(true) },
    {
      id: "copy-link",
      label: t("copyLink"),
      icon: "link",
      onSelect: () =>
        navigator.clipboard?.writeText(window.location.href).then(
          () => toast.success(t("copied")),
          () => {},
        ),
    },
  ];

  // Context: the latest step call's usage against its model's window.
  const usage = useMemo(() => latestUsage(conv.events), [conv.events]);
  const lastModel = useMemo(() => latestModel(conv.events), [conv.events]);
  const usageModel: ModelRef | null = useMemo(
    () => (usage ? { provider: usage.provider, model: usage.model } : lastModel),
    [usage, lastModel],
  );
  const window_ = usageModel ? selection.contextWindowOf(usageModel) : undefined;
  const contextPct =
    usage && window_ && window_ > 0 ? Math.round((usedTokens(usage) / window_) * 100) : null;
  const statusText = conv.running
    ? t("status.running")
    : conv.waiting
      ? t("status.waiting")
      : busy
        ? t("status.running")
        : stats.last === "aborted"
          ? t("status.stopped")
          : stats.last === "failed"
            ? t("status.failed")
            : t("status.idle");
  const statusFailed = !active && stats.last === "failed";
  // The properties panel's last-run line (spec §6.16.17): the newest run row's parts.
  const lastRun = useMemo(() => {
    const r = base.entries.findLast((e) => e.kind === "run");
    if (r?.kind !== "run") return undefined;
    const parts = runParts(r, locale, (n) => t("run.tokens", { n }));
    return parts.length > 0 ? tp("lastRun", { parts: parts.join(" · ") }) : undefined;
  }, [base, locale, t, tp]);

  const now = useNow(0);
  const timeZone = useTimeZone();
  const createdAt = conv.conversation ? new Date(conv.conversation.createdAt) : new Date(now);
  const untitled = untitledLabel(createdAt, locale, timeZone);
  const slot: RightAreaSlot | undefined = useRightAreaSlot({
    orgId,
    conversationId,
    events: conv.events,
    entries,
    model: usageModel,
    contextPct,
    lastRun,
    subagents: subagents.views,
    total:
      usageAll === undefined
        ? undefined
        : ts("contextTotal", { n: usageTotal(usageAll).toLocaleString(locale) }),
    progress: conv.state.progress,
    untitled,
    eventsLoaded: !conv.loading,
    contextWindowOf: selection.contextWindowOf,
    reasoningOf: selection.reasoningOf,
  });

  const agentPicker: PickerProps = {
    label: t("pickAgent"),
    value: agent?.definition.name ?? "—",
    locked: { hint: t("agentLocked") },
    groups: [],
    onPick: () => {},
  };

  const page: ConversationPageProps = {
    titleBar: {
      path: titlePath,
      title: conv.conversation?.title ?? null,
      untitled,
      menu,
      properties: slot?.properties ?? { pressed: false, onToggle: () => {} },
      panels: slot?.titleBarPanels ?? [],
    },
    thread: (
      <>
        <Thread
          orgId={orgId}
          conversationId={conversationId}
          entries={entries}
          info={info}
          reasoningOf={selection.reasoningOf}
          runLinks={{
            agentOwnerId: agent?.ownerAccountId,
            // a sub-agent conversation's trajectory is gated on the parent's agent: no link
            trajectory: !conv.conversation?.parentConversationId,
          }}
          {...(active ? {} : { onRetry: retry })}
          {...(slot?.thread ?? {})}
        />
        <PendingBubbles items={pending.shown} />
      </>
    ),
    queue: <QueueList queue={queue} />,
    // decided from the log and this view's pending bubbles (spec §2.2)
    working: workingLineVisible(conv.events, conv.state.drafts, {
      waiting: conv.waiting,
      pending: pending.shown.length,
      sentHere,
      paused: queue.paused,
      now: awaitAt,
    }),
    composer: ({ sendDisabled }) => (
      <Stack gap={8}>
        {conv.error !== undefined && <FormError message={conv.error} />}
        <ComposerBar
          orgId={orgId}
          sendDisabled={sendDisabled}
          agentId={conv.conversation?.agentId}
          conversationId={
            conv.conversation === undefined ||
            (conv.conversation.accountId !== undefined &&
              conv.conversation.accountId !== session.me.account.id)
              ? undefined
              : conversationId
          }
          running={active}
          stop={{ onStop: conv.stop, stopping: conv.stopping }}
          onSend={send}
          onQueue={enqueue}
          pickers={{
            agent: agentPicker,
            model: selection.modelPicker,
            ...(selection.effortPicker ? { effort: selection.effortPicker } : {}),
          }}
          placeholder={t("placeholder")}
        />
      </Stack>
    ),
    status: {
      ...signature,
      ...(stats.turns > 0
        ? {
            stats: (
              <RunStatsText
                turns={stats.turns}
                startedAt={stats.startedAt}
                endedAt={stats.endedAt}
                ticking={conv.running}
              />
            ),
          }
        : {}),
      right: [statusText, ...(contextPct !== null ? [t("contextPct", { n: contextPct })] : [])],
      ...(statusFailed ? { tone: "fail" as const } : {}),
      version: session.version ?? "",
    },
    right: slot?.right ?? "none",
    ...(slot?.propertiesNode !== undefined ? { properties: slot.propertiesNode } : {}),
    ...(slot?.panelNode !== undefined ? { panel: slot.panelNode } : {}),
    onCloseRight: slot?.onCloseRight ?? (() => {}),
  };
  const loading = {
    ...(conv.loading ? { thread: true } : {}),
    ...(conv.conversation === undefined ? { title: true } : {}),
    ...(slot.loading !== undefined ? { rightArea: slot.loading } : {}),
  };
  if (Object.keys(loading).length > 0) page.loading = loading;
  const dialogs = (
    <>
      {renaming ? (
        <RenameDialog
          value={conv.conversation?.title ?? ""}
          busy={renameBusy}
          onSave={(v) => void rename(v)}
          onCancel={() => setRenaming(false)}
        />
      ) : null}
      {slot.agentMap}
    </>
  );
  return { page, dialogs };
}
