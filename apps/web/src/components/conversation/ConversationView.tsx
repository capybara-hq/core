"use client";

import {
  AgentsChip,
  type ConversationPageProps,
  formatDuration,
  QuickActions,
  RenameDialog,
  RunRow,
  Stack,
  Text,
  type TitleBarMenuItem,
  untitledLabel,
  useNow,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "../../i18n/navigation";
import { avatarValue } from "../../lib/agents";
import { COMPACTION_DEFAULTS } from "../../lib/compaction";
import { compactConversation, type ModelRef, type ProjectState } from "../../lib/conversations";
import { canEditAgent } from "../../lib/org-settings";
import { groupProcess } from "../../lib/process";
import { agentsQuery } from "../../lib/query/agents";
import { automationQuery } from "../../lib/query/automations";
import { retryOnMountOf } from "../../lib/query/client";
import {
  conversationDeviceQuery,
  modelsQuery,
  renameWithRow,
  sentHereOf,
} from "../../lib/query/conversation";
import { keys as queryKeys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { useWhoWaits } from "../../lib/query/who-waits";
import { runParts } from "../../lib/run-row";
import { browserShare, shareOrCopy } from "../../lib/share";
import { useShareCapability } from "../../lib/shell";
import {
  type AgentsSummary,
  dispatchedAny,
  usageTotal,
  useSubagents,
  useTreeLookup,
  useUsageWithSubagents,
} from "../../lib/subagents";
import {
  AWAIT_RUN_MS,
  awaitedMessage,
  awaitingRun,
  buildEventTimeline,
  composerWait,
  type FailedRun,
  isIdleCompactRun,
  latestModel,
  latestUsage,
  type RunStats,
  runStats,
  streamedToolKeys,
  toolKeysOf,
  usedTokens,
  withDrafts,
  workedMsAt,
  workingLineVisible,
} from "../../lib/timeline";
import { useToolInfo } from "../../lib/tool-info";
import { useErrorMessage } from "../../lib/use-error-message";
import { useClientEventFeed } from "../client-ext/events";
import { usePublishRunState } from "../client-ext/run-state";
import { FormError } from "../form-error";
import { usePagePath } from "../shell/path";
import { useSession } from "../shell/session";
import { useDeviceName } from "../use-device-name";
import {
  ComposerBar,
  type ComposerControl,
  type ComposerMessage,
  newClientMessageId,
} from "./ComposerBar";
import { LeftoverBubbles, PendingBubbles, usePendingSends } from "./PendingBubbles";
import { useConversationPermission } from "./PermissionPicker";
import { useDeviceRefresh } from "./PropertiesSections";
import { useRightAreaSlot } from "./RightArea";
import { PlanningBlock, Thread, type ThreadProps } from "./Thread";
import { useBackgroundLive } from "./useBackgroundLive";
import { type SendResult, useConversation } from "./useConversation";
import { useRootPermissionSubscription } from "./useRootPermissionSubscription";
import { lockedDevicePicker, lockedProjectPicker, useSelection } from "./useSelection";

/**
 * "Turn N · <elapsed> elapsed" in the properties panel's Context section (layered shell spec §6):
 * the run's working time. It ticks each second on its
 * own only while the run works, so the page does not re-render each second (I3); while the run
 * waits for a person it stops at the wait's start and reads the log alone (the status says
 * 等待处理), and it counts on from there once the run continues.
 */
function RunStatsText({ stats }: { stats: RunStats }) {
  const t = useTranslations("chat");
  const locale = useLocale() === "zh" ? "zh" : "en";
  // the server's time while hydrating (a running run's elapsed time then matches its render)
  const now = useNow(stats.resumedAt !== null ? 1000 : 0);
  const ms = workedMsAt(stats, now);
  // the one duration format (F29): a counter while the run is active, the run row's figure after
  const shown = ms === null ? "—" : formatDuration(ms, locale, { live: stats.endedAt === null });
  return <>{t("stats", { n: stats.turns, elapsed: shown })}</>;
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
  /**
   * The composer's agents chip (design spec §6.16.29, AC3): every sub-agent of the tree, how many
   * run and wait, and the map's opener; absent until the conversation has a sub-agent.
   */
  agents?: AgentsSummary & { onOpen(): void };
  onCloseRight(): void;
  /** The open panel is maximised inside the page (its full-screen button; Esc restores). */
  rightFull?: boolean;
  onRightFullChange?(full: boolean): void;
  /** The open area's read is on its way (its loading state; `title`: the open panel's). */
  loading?: true | { title: string };
  thread: Pick<
    ThreadProps,
    | "onOpenFile"
    | "onMoreFiles"
    | "onOpenOutput"
    | "selectedFile"
    | "removedFiles"
    | "listedFiles"
    | "filePaths"
    | "renderCard"
    | "questionPanel"
    | "openSubagent"
    | "onOpenSubagent"
    | "onOpenAgent"
    | "onOpenAgentMap"
    | "onOpenTask"
  >;
};

/**
 * The conversation page (`/chat/<id>`, spec §5) as `ConversationPage` props: the title bar (title,
 * rename, properties, panels), the thread built by `lib/timeline.ts`, the leftover queued messages
 * (pending bubbles), the composer (pickers; ↵ interjects while a run goes) and the run state;
 * `dialogs` go next to the page. Use it in a component keyed by the conversation id: everything
 * here (drafts, picks, the right area) belongs to one
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
  const locale = useLocale() === "zh" ? "zh" : "en";
  const session = useSession();
  const toast = useToast();
  const shareCap = useShareCapability();
  const errorMessage = useErrorMessage();
  const conv = useConversation(orgId, conversationId);
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data
    ?.agents;
  const agent = agents?.find((a) => a.id === conv.conversation?.agentId);
  const composer = useRef<ComposerControl>(null);
  const quickActions = agent?.profile.quickActions ?? [];
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
  const deviceQ = conversationDeviceQuery(orgId, conversationId);
  const device = useQuery({
    ...deviceQ,
    retryOnMount: retryOnMountOf(deviceQ.queryKey),
  });
  const deviceName = useDeviceName();
  const [projectOpen, setProjectOpen] = useState(true);
  const projectNotice = useRef<HTMLDivElement>(null);
  const projectScrollFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (projectScrollFrame.current !== null) cancelAnimationFrame(projectScrollFrame.current);
    },
    [],
  );
  const inspectProject = () => {
    setProjectOpen(true);
    if (projectScrollFrame.current !== null) cancelAnimationFrame(projectScrollFrame.current);
    // Let disclosure layout and follow-bottom observers settle before moving the viewport.
    projectScrollFrame.current = requestAnimationFrame(() => {
      projectScrollFrame.current = requestAnimationFrame(() => {
        projectScrollFrame.current = null;
        projectNotice.current?.scrollIntoView?.({ block: "nearest" });
      });
    });
  };
  const devicePicker = lockedDevicePicker(
    {
      label: t("pickDevice"),
      hint: t("deviceLocked"),
      deleted: t("deviceDeleted"),
    },
    // a row read before the first tool call bound the conversation says none; the device
    // query (read again after sandbox tool results) knows better
    conv.conversation?.deviceId ?? device.data?.id,
    device.data,
    deviceName,
  );
  // the project it is bound to, after the device in the top strip (composer menus spec §6)
  const projectPicker = devicePicker
    ? lockedProjectPicker(
        { label: t("projectGroup"), hint: t("projectLocked") },
        conv.conversation?.project?.name,
      )
    : undefined;
  if (
    projectPicker?.locked &&
    conv.conversation?.projectState &&
    "unavailable" in conv.conversation.projectState
  ) {
    projectPicker.locked.warning = {
      label: t("project.composerUnavailable"),
      onInspect: inspectProject,
    };
  }
  // The permission profile (owner only; a shared viewer reads and sees nothing): editable on an
  // interactive root once confirmed, locked on a child (inherited) or an automation's.
  const permission = useConversationPermission({
    orgId,
    conversationId,
    row: conv.conversation,
    events: conv.events,
    // unknown while the bound device is read (Full waits for it)
    deviceLabel: device.data ? deviceName(device.data) : undefined,
  });
  const permissionPicker = permission.picker;
  // an owner's child follows its root's profile live through the root's stream
  useRootPermissionSubscription({
    orgId,
    accountId: session.me.account.id,
    viewedId: conversationId,
    rootId: permission.inheritedRootId,
  });
  // a streaming call's tool too: its row shows what the tool's `inputView` declares (spec §6.4)
  const logKeys = useMemo(() => toolKeysOf(conv.events), [conv.events]);
  const streamed = useMemo(() => streamedToolKeys(conv.state.drafts), [conv.state.drafts]);
  const keys = useMemo(
    () => (streamed.length === 0 ? logKeys : [...new Set([...logKeys, ...streamed])]),
    [logKeys, streamed],
  );
  const info = useToolInfo(orgId, conversationId, keys);
  useDeviceRefresh(orgId, conversationId, conv.events);
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
  const whoWaits = useWhoWaits(conv.people);
  const backgroundTasks = useBackgroundLive(orgId, conversationId, conv.events);
  // the tree is a root's (a sub-agent's page, or one still loading, reads none)
  const isRoot = conv.conversation !== undefined && !conv.conversation.parentConversationId;
  const tree = useTreeLookup(orgId, conversationId, conv.events, isRoot);
  // The log's timeline is rebuilt when the log changes; a delta frame only adds the drafts (I3).
  const base = useMemo(
    () =>
      buildEventTimeline(conv.events, info, locale, {
        progress: conv.state.progress,
        ...(views ? { views } : {}),
        whoWaits,
        ...(tree ?? {}),
        ...(backgroundTasks ? { backgroundTasks } : {}),
      }),
    [conv.events, info, locale, conv.state.progress, views, whoWaits, tree, backgroundTasks],
  );
  const entries = useMemo(() => withDrafts(base, conv.state.drafts), [base, conv.state.drafts]);
  // the thread draws a run's process as one block (process blocks spec §1); the right area reads
  // the timeline itself
  // the window's runs after those started above it (history paging spec §5)
  const windowStats = useMemo(() => runStats(conv.events), [conv.events]);
  const pending = usePendingSends(conv.events);
  const [renaming, setRenaming] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const qc = useQueryClient();
  const sentHere = sentHereOf(qc, orgId, conversationId);
  // One source for the composer's mode, the run state and the working line (review fix L1, L2):
  // a pending send of this view, a message this tab sent that waits for its run, or a run per the
  // log. While any holds, a message is an interjection (run input spec D1).
  // (not memoized: the set changes with this view's sends, each of which re-renders it)
  const awaited = awaitedMessage(conv.events, sentHere);
  const awaitAt = useAwaitBackstop(
    awaited?.type === "user_message" && awaited.payload.clientMessageId !== undefined
      ? sentHere.get(awaited.payload.clientMessageId)
      : undefined,
  );
  const awaiting = awaitingRun(conv.events, sentHere, awaitAt);
  // The model plans the next step (decided from the log and this view's pending bubbles, spec
  // §2.2): the planning row (the capybara) ends the run's latest block in the thread; a message
  // only this view knows of (no run yet) gets a planning block of its own after its bubble.
  const planning = workingLineVisible(conv.events, conv.state.drafts, {
    waiting: conv.waiting,
    pending: pending.shown.length,
    sentHere,
    now: awaitAt,
  });
  const planningAfterPending = planning && windowStats.runId === null && pending.shown.length > 0;
  const planningInThread = planning && !planningAfterPending;
  // the going run's clock times its latest block's head from the run's start (spec §1.3)
  const threadEntries = useMemo(
    () => groupProcess(entries, windowStats, planningInThread),
    [entries, windowStats, planningInThread],
  );
  const busy = conv.running || pending.shown.length > 0 || awaiting;
  const active = busy || conv.waiting;
  // what a message does while the run waits for a person: skips the viewer's question, or waits
  const viewerId = session.me.account.id;
  const waitHint = useMemo(
    () => (conv.waiting ? composerWait(conv.events, viewerId) : null),
    [conv.waiting, conv.events, viewerId],
  );
  const stats = useMemo(
    () =>
      windowStats.turns > 0 || conv.turnsBefore > 0
        ? { ...windowStats, turns: windowStats.turns + conv.turnsBefore }
        : windowStats,
    [windowStats, conv.turnsBefore],
  );

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
        ...(d.retry.tokens !== undefined ? { tokens: d.retry.tokens } : {}),
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

  // Manual compaction (context compaction spec §4.10): the title menu's entry and the composer's
  // /compact share one request. Its progress and its end come from the stream (`compaction`
  // frames, then the run's events).
  const compactMutation = useAppMutation({
    fn: () => compactConversation(orgId, conversationId),
    invalidates: () => [],
  });
  // Throws on failure so the composer keeps its draft; the title menu reports it itself.
  const compact = async () => {
    await compactMutation.mutateAsync();
  };
  // Where compaction is possible: an eval conversation never renders this page (the kernel answers
  // 404; the trajectory viewer shows it), and a sub-agent's is refused (conversation.read_only).
  const canCompact = conv.conversation !== undefined && !conv.conversation.parentConversationId;
  const compactItem: TitleBarMenuItem[] = canCompact
    ? [
        {
          id: "compact",
          label: t("compact"),
          icon: "chevrons-up-down",
          disabled: active,
          onSelect: () => {
            void compact().catch((e: unknown) => toast.error(errorMessage(e)));
          },
        },
      ]
    : [];

  const menu: TitleBarMenuItem[] = [
    { id: "rename", label: t("rename"), icon: "square-pen", onSelect: () => setRenaming(true) },
    {
      id: "copy-link",
      label: t("copyLink"),
      icon: "link",
      onSelect: () =>
        void shareOrCopy(
          { url: window.location.href },
          {
            share: shareCap,
            webShare: browserShare(),
            copy: (text) => navigator.clipboard.writeText(text),
          },
        ).then(
          (done) => {
            if (done === "copied") toast.success(t("copied"));
          },
          () => {},
        ),
    },
    ...compactItem,
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
  // The shell's `run=` token and the client events (client extensions spec §7.3, §7.5).
  usePublishRunState(
    conversationId,
    conv.waiting ? "waiting" : busy ? "running" : statusFailed ? "failed" : "idle",
  );
  useClientEventFeed(conversationId, conv.events, !conv.loading);
  // The properties panel's last-run row (spec §6.16.17): the newest run row's parts, its model
  // only when it differs from the Model row's.
  const lastRun = useMemo(() => {
    const r = base.entries.findLast((e) => e.kind === "run");
    if (r?.kind !== "run") return undefined;
    const sameModel = r.model !== null && r.model.model === usageModel?.model;
    const parts = runParts(sameModel ? { ...r, model: null } : r, locale, (n) =>
      t("run.tokens", { n }),
    );
    return parts.length > 0 ? parts : undefined;
  }, [base, locale, t, usageModel]);

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
    ...(stats.turns > 0 ? { rounds: <RunStatsText stats={stats} /> } : {}),
    subagents: subagents.views,
    // read also for a window that may hide a dispatch: shown once there is a sub-agent
    total:
      usageAll === undefined || !(dispatchedAny(conv.events) || (subagents.views?.length ?? 0) > 0)
        ? undefined
        : ts("contextTotal", { n: usageTotal(usageAll).toLocaleString(locale) }),
    progress: conv.state.progress,
    untitled,
    eventsLoaded: !conv.loading,
    root: conv.conversation === undefined ? undefined : !conv.conversation.parentConversationId,
    contextWindowOf: selection.contextWindowOf,
    reasoningOf: selection.reasoningOf,
  });

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
        <StartedBy orgId={orgId} taskId={conv.conversation?.automationId ?? null} />
        <div ref={projectNotice}>
          <ProjectLine
            project={conv.conversation?.project ?? null}
            state={conv.conversation?.projectState ?? null}
            deviceId={conv.conversation?.deviceId ?? device.data?.id}
            agentId={conv.conversation?.agentId}
            open={projectOpen}
            onOpenChange={setProjectOpen}
          />
        </div>
        <Thread
          orgId={orgId}
          conversationId={conversationId}
          entries={threadEntries}
          info={info}
          reasoningOf={selection.reasoningOf}
          compaction={conv.compaction}
          compactionIdle={isIdleCompactRun(conv.events, conv.compaction?.runId)}
          people={conv.people}
          runLinks={{
            agentOwnerId: agent?.ownerAccountId,
            // a sub-agent conversation's trajectory is gated on the parent's agent: no link
            trajectory: !conv.conversation?.parentConversationId,
          }}
          {...(active ? {} : { onRetry: retry })}
          {...(slot?.thread ?? {})}
        />
        <PendingBubbles items={pending.shown} />
        {planningAfterPending ? <PlanningBlock /> : null}
      </>
    ),
    // messages an older version queued, until the kernel sends them (run input spec D3)
    queue: <LeftoverBubbles orgId={orgId} conversationId={conversationId} events={conv.events} />,
    composer: ({ sendDisabled }) => (
      <Stack gap={8}>
        {conv.error !== undefined && <FormError message={conv.error} />}
        {permission.notice}
        <ComposerBar
          orgId={orgId}
          sendDisabled={sendDisabled}
          agentId={conv.conversation?.agentId}
          {...(agent !== undefined && canEditAgent(session.me, agent)
            ? { skillsHref: `/agents/${encodeURIComponent(agent.id)}?s=skills` }
            : {})}
          conversationId={
            conv.conversation === undefined ||
            (conv.conversation.accountId !== undefined &&
              conv.conversation.accountId !== session.me.account.id)
              ? undefined
              : conversationId
          }
          // the project's files can be referenced by its owner (the listing is the owner's)
          {...(conv.conversation?.project &&
          conv.conversation.deviceId &&
          conv.conversation.accountId === session.me.account.id
            ? {
                project: {
                  deviceId: conv.conversation.deviceId,
                  name: conv.conversation.project.name,
                },
              }
            : {})}
          running={active}
          waiting={waitHint}
          stop={{ onStop: conv.stop, stopping: conv.stopping }}
          onSend={send}
          // no agent here: the title bar's path names it (issue U)
          {...(devicePicker
            ? {
                place: {
                  device: devicePicker,
                  ...(projectPicker ? { project: projectPicker } : {}),
                },
              }
            : {})}
          pickers={{
            ...(permissionPicker ? { permission: permissionPicker } : {}),
            model: selection.modelPicker,
            ...(selection.effortPicker ? { effort: selection.effortPicker } : {}),
          }}
          placeholder={t("placeholder")}
          // the context window used; `fail` from the default compaction threshold (members cannot
          // read the org's own setting)
          {...(contextPct !== null
            ? {
                context: {
                  pct: contextPct,
                  over: contextPct >= COMPACTION_DEFAULTS.threshold * 100,
                },
              }
            : {})}
          control={composer}
          {...(canCompact ? { onCompact: compact } : {})}
          // a prompt suggestion: a root conversation's composer only, hidden while a send is
          // pending or a run is going (the reader's rule, prompt suggestions spec §4)
          {...(isRoot && !active && conv.suggestion !== null
            ? { suggestion: conv.suggestion }
            : {})}
          // the agent's quick actions, as on a new conversation: a zap menu that fills the composer
          {...(quickActions.length > 0
            ? {
                quickActions: (
                  <QuickActions
                    items={quickActions.map((q, i) => ({ id: String(i), title: q.title }))}
                    onPick={(id) => {
                      const body = quickActions[Number(id)]?.body;
                      if (body !== undefined) composer.current?.fill(body);
                    }}
                  />
                ),
              }
            : {})}
          {...(slot?.agents
            ? {
                agents: (
                  <AgentsChip
                    count={slot.agents.count}
                    running={slot.agents.running}
                    waiting={slot.agents.waiting}
                    onOpen={slot.agents.onOpen}
                  />
                ),
              }
            : {})}
        />
      </Stack>
    ),
    // the run state for screen readers (the composer's meter shows the context, the properties
    // panel the rounds)
    announce: statusText,
    ...(conv.history !== undefined
      ? { history: { state: conv.history.state, onLoadEarlier: conv.history.loadEarlier } }
      : {}),
    right: slot?.right ?? "none",
    ...(slot?.propertiesNode !== undefined ? { properties: slot.propertiesNode } : {}),
    ...(slot?.panelNode !== undefined ? { panel: slot.panelNode } : {}),
    onCloseRight: slot?.onCloseRight ?? (() => {}),
    ...(slot?.rightFull ? { rightFull: true } : {}),
    ...(slot?.onRightFullChange ? { onRightFullChange: slot.onRightFullChange } : {}),
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
      {permission.dialog}
    </>
  );
  return { page, dialogs };
}

/**
 * The conversation's project (project root §4.6, §4.7): its name and root, and, from the view's
 * `projectState` (its latest `project_root`, wherever that lies in the log), whether its
 * `AGENTS.md` was loaded, or why the project is unavailable (this conversation then goes on in
 * free mode: the web notice for a lost project). Before the first run (no snapshot yet) the name
 * and root alone. A free conversation draws nothing.
 */
function ProjectLine({
  project,
  state,
  deviceId,
  agentId,
  open,
  onOpenChange,
}: {
  deviceId?: string | null | undefined;
  agentId?: string | undefined;
  open: boolean;
  onOpenChange(open: boolean): void;
  project: { name: string; path: string } | null;
  state: ProjectState | null;
}) {
  const t = useTranslations("chat.project");
  if (project === null) return null;
  // the file's name is not translated (a placeholder: no Latin "agent" in the Chinese text)
  const vars = { name: project.name, path: project.path, file: "AGENTS.md" };
  if (state !== null && "unavailable" in state) {
    const reason = state.unavailable;
    return (
      <RunRow
        status="warning"
        label={t("title", vars)}
        parts={[]}
        statusText={t("unloaded")}
        detailsLabel={t("details")}
        open={open}
        onOpenChange={onOpenChange}
        links={[
          ...(deviceId
            ? [{ label: t("viewDevice"), href: `/devices/${encodeURIComponent(deviceId)}` }]
            : []),
          {
            label: t("newFreeConversation"),
            href: agentId ? `/?agent=${encodeURIComponent(agentId)}` : "/",
          },
        ]}
      >
        <Text variant="prose">{t("summary")}</Text>
        <Text variant="small" tone="muted" pre>
          {project.path}
        </Text>
        <Text variant="prose" tone="muted">
          {t(`unavailable.${reason}`, vars)}
        </Text>
        <Text variant="prose" tone="muted">
          {t("snapshotHint")}
        </Text>
      </RunRow>
    );
  }
  return (
    <Text variant="small" tone="muted">
      {state === null
        ? t("bound", vars)
        : state.agentsMd
          ? t("loaded", vars)
          : t("noAgentsMd", vars)}
    </Text>
  );
}

/**
 * A conversation an automation started (`conversation.automationId`): "Started by the
 * automation <name>", linking to the task (automations spec §10); the task's name is read
 * through the cache, and a task I can no longer read (deleted) is named without a link.
 */
function StartedBy({ orgId, taskId }: { orgId: string; taskId: string | null }) {
  const t = useTranslations("automations");
  const q = automationQuery(orgId, taskId ?? "");
  const task = useQuery({
    ...q,
    enabled: taskId !== null,
    retry: false,
    retryOnMount: retryOnMountOf(q.queryKey),
  });
  if (taskId === null) return null;
  if (task.data === undefined) {
    return task.error ? (
      <Text variant="small" tone="muted">
        {t("startedByGone")}
      </Text>
    ) : null;
  }
  const name = task.data.task.name;
  return (
    <Text variant="small" tone="muted">
      {t.rich("startedBy", {
        name,
        link: (chunks) => <Link href={`/automations/${encodeURIComponent(taskId)}`}>{chunks}</Link>,
      })}
    </Text>
  );
}
