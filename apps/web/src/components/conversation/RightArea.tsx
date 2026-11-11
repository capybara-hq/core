"use client";

import {
  type AgentMapStatus,
  RightPanel,
  type RightPanelSwitcher,
  subagentStatusOfFinish,
  TextPreview,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  abortRun,
  type BackgroundTaskView,
  type ConversationEvent,
  fromStart,
  type ModelRef,
  type SubagentView,
  stopBackgroundTask,
} from "../../lib/conversations";
import type { FileOutput } from "../../lib/files";
import { retryOnMountOf } from "../../lib/query/client";
import {
  backgroundTasksQuery,
  filesQuery,
  hasBackgroundTasks,
  toolOutputQuery,
} from "../../lib/query/conversation";
import { useAppMutation } from "../../lib/query/mutation";
import { formatRightHash, parseRightHash, type RightTarget } from "../../lib/right-area";
import { agentsSummary, dispatchedAny, useAgentTree } from "../../lib/subagents";
import type { TimelineEntry, TimelineTool } from "../../lib/timeline";
import { toolLabelText } from "../../lib/tool-label";
import { type UiOpen, uiKey, uiLocale } from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import { useOfferedContributions } from "../extension-ui/ClientComponentBlock";
import { ICON_OF } from "../extension-ui/ExtensionBlocks";
import { ExtensionSlot, useSlotContributions } from "../extension-ui/ExtensionSlot";
import { AgentMap } from "./AgentMap";
import { BackgroundListPanel, BackgroundTaskPanel } from "./BackgroundSection";
import type { RightAreaSlot } from "./ConversationView";
import { FilePanel } from "./FilePanel";
import { PropertiesSections } from "./PropertiesSections";
import { SubagentPanel } from "./SubagentPanel";

/**
 * The right area's target, kept in the URL hash (a reload keeps it; another conversation's URL has
 * none, so nothing carries over). Opening one thing closes the other (spec §5.1). `back` leaves a
 * sub-agent for what was open before it (e.g. the properties panel it was opened from), else closes.
 * The agent map (`#agents…`, a dialog over the page) is kept in the hash too: what was open before
 * it stays drawn under it (`beneath`), and `closeMap` returns to it, as it was. A background
 * task's output opened from the finished list (`#bg`) goes back to it the same way.
 * `full`: the open panel is maximised inside the page (design `ConversationPage` `rightFull`); it
 * is page state, not in the hash, and ends when the panel closes or the properties open.
 */
export function useRightArea(): {
  target: RightTarget | null;
  open(t: RightTarget | null): void;
  back(): void;
  closeMap(): void;
  /** While the agent map is open: what stays open in the right area under it. */
  beneath: RightTarget | null;
  full: boolean;
  setFull(full: boolean): void;
  /** The background task now shown was opened from the finished list: its Back returns there. */
  fromList: boolean;
} {
  const [target, setTarget] = useState<RightTarget | null>(null);
  const [full, setFull] = useState(false);
  const [fromList, setFromList] = useState(false);
  const [beneath, setBeneath] = useState<RightTarget | null>(null);
  const current = useRef<RightTarget | null>(null);
  /** What was open before the sub-agent now shown (opening another sub-agent keeps it). */
  const previous = useRef<RightTarget | null>(null);
  /** What was open before the agent map (moving inside the map keeps it). */
  const beforeMap = useRef<RightTarget | null>(null);
  useEffect(() => {
    // Inbox and IM links name a sub-agent at any depth as `?subagent=<id>` (it waits for a person):
    // it opens in the agent map at its transcript, whose thread holds the approval, question or
    // connection card (the right panel takes only the conversation's own children).
    const url = new URL(window.location.href);
    const legacy = url.searchParams.get("subagent");
    if (legacy) {
      url.searchParams.delete("subagent");
      url.hash = formatRightHash({ kind: "agents", id: legacy, transcript: true });
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    const read = () => {
      const t = parseRightHash(window.location.hash);
      current.current = t;
      previous.current = null;
      beforeMap.current = null;
      setBeneath(null);
      setFull(false);
      setFromList(false);
      setTarget(t);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const show = useCallback((t: RightTarget | null) => {
    current.current = t;
    if (t === null || t.kind === "properties") setFull(false);
    setTarget(t);
    const { pathname, search } = window.location;
    window.history.replaceState(
      window.history.state,
      "",
      `${pathname}${search}${formatRightHash(t)}`,
    );
  }, []);
  const open = useCallback(
    (t: RightTarget | null) => {
      if (t?.kind === "agents") {
        // the map lies over the page: what was open stays as it was for its close
        if (current.current?.kind !== "agents") {
          beforeMap.current = current.current;
          setBeneath(current.current);
        }
      } else if (t?.kind === "subagent") {
        if (current.current?.kind !== "subagent") previous.current = current.current;
      } else if (t?.kind === "background") {
        // Back from a task's output returns to the finished list it was opened from
        previous.current = current.current?.kind === "backgroundList" ? current.current : null;
      } else previous.current = null;
      setFromList(t?.kind === "background" && previous.current !== null);
      show(t);
    },
    [show],
  );
  const back = useCallback(() => open(previous.current), [open]);
  const closeMap = useCallback(() => {
    const t = beforeMap.current;
    beforeMap.current = null;
    setBeneath(null);
    show(t);
  }, [show]);
  return { target, open, back, closeMap, beneath, full, setFull, fromList };
}

/** The full archived output of a call (replaces the old Run tab's "View full output"). */
function OutputPanel({
  orgId,
  conversationId,
  tool,
  title,
  onClose,
  onFullscreen,
}: {
  orgId: string;
  conversationId: string;
  tool: TimelineTool;
  title: string;
  onClose(): void;
  onFullscreen(): void;
}) {
  const errorMessage = useErrorMessage();
  const outputId = tool.outputId;
  // An output that was not archived is the row's own text: nothing to read.
  const q = useQuery({
    ...toolOutputQuery(orgId, conversationId, outputId ?? ""),
    enabled: outputId !== null,
  });
  const state:
    | { kind: "loading" }
    | { kind: "ready"; text: string; complete: boolean }
    | { kind: "error"; reason: string } =
    outputId === null
      ? { kind: "ready", text: tool.row.detail?.output ?? "", complete: true }
      : q.data !== undefined
        ? { kind: "ready", ...q.data }
        : q.error !== null
          ? { kind: "error", reason: errorMessage(q.error) }
          : { kind: "loading" };
  return (
    <RightPanel
      title={title}
      meta={toolLabelText({
        name: tool.row.name,
        ...(tool.row.tool !== undefined ? { tool: tool.row.tool } : {}),
      })}
      body="flush"
      onClose={onClose}
      onFullscreen={onFullscreen}
      state={state.kind === "error" ? "failed" : state.kind}
      {...(state.kind === "error" ? { failure: { reason: state.reason } } : {})}
      onRetry={() => void q.refetch()}
    >
      {state.kind === "ready" ? (
        <TextPreview text={state.text} truncated={!state.complete} />
      ) : null}
    </RightPanel>
  );
}

const NO_FILES: FileOutput[] = [];
const NO_TASKS: BackgroundTaskView[] = [];
const NO_SUBAGENTS: SubagentView[] = [];
const NONE_STOPPING: ReadonlySet<string> = new Set();

/**
 * The conversation's background tasks (background Bash spec §5), read once the log names one
 * ({@link hasBackgroundTasks}) and again on `changed: background`; and a person's stop, whose
 * answer replaces the task in the list (its final status follows with the `changed` frame).
 * `stopping` holds the tasks whose stop is on its way.
 */
function useBackgroundTasks(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[],
): {
  tasks: BackgroundTaskView[] | undefined;
  pending: boolean;
  stopping: ReadonlySet<string>;
  stop(taskId: string): void;
} {
  const qc = useQueryClient();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const enabled = useMemo(() => hasBackgroundTasks(events), [events]);
  const query = backgroundTasksQuery(orgId, conversationId);
  const r = useQuery({ ...query, enabled, retryOnMount: retryOnMountOf(query.queryKey) });
  const listKey = query.queryKey;
  /** The tasks whose stop this page sent and the kernel has not answered yet (each its own). */
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(NONE_STOPPING);
  const { mutateAsync } = useAppMutation({
    fn: (taskId: string) => stopBackgroundTask(orgId, conversationId, taskId),
    // the answer is the task now; the kernel's `changed: background` reads the list when it ends
    invalidates: () => [],
    onSuccess: ({ task }) =>
      qc.setQueryData<BackgroundTaskView[]>(listKey, (l) =>
        l?.map((x) => (x.id === task.id ? task : x)),
      ),
  });
  const stop = useCallback(
    (taskId: string) => {
      setInFlight((s) => new Set(s).add(taskId));
      // `mutateAsync` settles each call (mutate's own callbacks follow only the latest one)
      mutateAsync(taskId)
        .catch((e: unknown) => toast.error(errorMessage(e)))
        .finally(() =>
          setInFlight((s) => {
            const next = new Set(s);
            next.delete(taskId);
            return next;
          }),
        );
    },
    [mutateAsync, toast, errorMessage],
  );
  return {
    tasks: enabled ? r.data : undefined,
    pending: enabled && r.data === undefined && r.error === null,
    stopping: inFlight,
    stop,
  };
}

/**
 * The right area of the conversation page (Task 20): the title-bar panel icons (Files, then the
 * extensions' panels), the properties panel (Context, Files, the extensions' sections) or one right
 * panel (an extension panel, a file, a call's full output, a background task's output), inline
 * cards for the thread, and the file wiring of the thread (chips, cards, "View all").
 */
export function useRightAreaSlot(p: {
  orgId: string;
  conversationId: string;
  events: readonly ConversationEvent[];
  entries: readonly TimelineEntry[];
  model: ModelRef | null;
  contextPct: number | null;
  /** The Context section's last-run line (model, duration, tokens), once a run ended. */
  lastRun?: string | undefined;
  /** The conversation's sub-agents (`GET …/subagents`), once there are any. */
  subagents?: SubagentView[] | undefined;
  /** The Context section's tokens-with-sub-agents line. */
  total?: string | undefined;
  /** The stream's sub-agent progress by agent id (any depth): the agent map reads again on it. */
  progress: Readonly<Record<string, { step: number }>>;
  /** The conversation's name while it has no title (the agent map's root). */
  untitled: string;
  /** The log is loaded (`events` is the whole log, not the empty list of a pending read). */
  eventsLoaded: boolean;
  /**
   * Whether the conversation is a root (not a sub-agent's); undefined while its row loads. Only a
   * root has an agent map (`GET …/agent-tree` is 404 for a sub-agent conversation).
   */
  root: boolean | undefined;
  contextWindowOf(m: ModelRef): number | undefined;
  reasoningOf(m: ModelRef): boolean | undefined;
}): RightAreaSlot {
  const t = useTranslations("chat");
  const locale = uiLocale(useLocale());
  const {
    target: hashTarget,
    open,
    back,
    closeMap,
    beneath,
    full,
    setFull,
    fromList,
  } = useRightArea();
  /** The panel's full-screen button: maximise inside the page, or restore (never the browser's). */
  const fullscreen = useCallback(() => setFull(!full), [full, setFull]);
  // The agent map is a dialog over the page: the right area keeps showing what was open under it
  const target = hashTarget?.kind === "agents" ? beneath : hashTarget;
  // The extensions' contributions (enabled and loaded only) and the conversation's file outputs.
  // A failed read (R5: not read again on mount) shows none: no extension blocks, no files.
  // Sub-agents cannot deliver files (`Deliver` is removed for children), so their lists
  // are not read (Task 22 ruling, final review I5).
  const { items: listedPanels, pending: contributionsPending } = useSlotContributions(
    p.orgId,
    "conversation.panel",
  );
  // A component panel is offered only while the document's client code delivers it (none in safe
  // mode or under the kill switch; client extensions spec §10).
  const panels = useOfferedContributions(listedPanels);
  const filesQ = filesQuery(p.orgId, p.conversationId);
  const filesR = useQuery({ ...filesQ, retryOnMount: retryOnMountOf(filesQ.queryKey) });
  const files = filesR.data ?? NO_FILES;
  const close = useCallback(() => open(null), [open]);
  const openFile = useCallback((id: string) => open({ kind: "file", id }), [open]);
  const onOpenTarget = useCallback(
    (plugin: string, o: UiOpen) =>
      open({
        kind: "panel",
        plugin,
        contribution: o.contribution,
        ...(o.item !== undefined ? { item: o.item } : {}),
      }),
    [open],
  );
  const background = useBackgroundTasks(p.orgId, p.conversationId, p.events);
  /** The finish events' last lines by task (the panel's text when the output is unreadable). */
  const lastLines = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of p.events)
      if (e.type === "background_task_finished") m.set(e.payload.taskId, e.payload.lastLines);
    return m;
  }, [p.events]);
  const openTask = useCallback((taskId: string) => open({ kind: "background", taskId }), [open]);
  // The agent map (agent map spec §9): its entries (the sub-agent group's link and the composer's
  // agents chip, AC3) show once a root conversation dispatched a sub-agent (a sub-agent
  // conversation's page has none: the tree is its root's).
  // the log names one, or the list does (a window that does not start at the log's beginning
  // may have the dispatch above it, history paging spec §5)
  const dispatched = useMemo(() => dispatchedAny(p.events), [p.events]);
  const listed = (p.subagents?.length ?? 0) > 0;
  const hasSubagents = (dispatched || listed) && p.root === true;
  // whether there are none is known: the log starts at the beginning, or the list answered
  const subagentsKnown = dispatched || fromStart(p.events) || p.subagents !== undefined;
  const openMap = useCallback(() => open({ kind: "agents" }), [open]);
  const openAgent = useCallback(
    (id: string, transcript?: boolean) =>
      open({ kind: "agents", id, ...(transcript ? { transcript: true } : {}) }),
    [open],
  );
  const mapTarget = hashTarget?.kind === "agents" ? hashTarget : null;
  // read on a root conversation with sub-agents (the agents chip counts the whole tree), kept
  // closer while the map is open
  const tree = useAgentTree(p.orgId, p.conversationId, p.events, p.progress, {
    enabled: hasSubagents,
    open: mapTarget !== null && hasSubagents,
  });
  // `#agents…` on a conversation without sub-agents, or on a sub-agent's page (a pasted link):
  // nothing to show, drop it
  const staleMap =
    p.eventsLoaded && subagentsKnown && p.root !== undefined && mapTarget !== null && !hasSubagents;
  useEffect(() => {
    if (staleMap) closeMap();
  }, [staleMap, closeMap]);
  // how the conversation's own children's latest runs ended, as the stream words them (the tree
  // says `idle` for a run that ended on a limit)
  const finishes = useMemo(() => {
    const m = new Map<string, AgentMapStatus>();
    for (const e of p.events)
      if (e.type === "subagent_finished")
        m.set(e.payload.subagentId, subagentStatusOfFinish(e.payload.status) as AgentMapStatus);
    return m;
  }, [p.events]);
  const tools = useMemo(() => {
    const m = new Map<string, TimelineTool>();
    for (const e of p.entries) if (e.kind === "tools") for (const r of e.rows) m.set(r.callId, r);
    return m;
  }, [p.entries]);

  // The file the hash names may be any version's id: find its file.
  const fileOf = (id: string) =>
    files.find((f) => f.id === id || f.versions.some((v) => v.id === id));

  const switcher: RightPanelSwitcher | undefined =
    panels.length + files.length > 1
      ? {
          groups: [
            ...(panels.length > 0
              ? [
                  {
                    label: t("panelExtensions"),
                    items: panels.map((c) => ({
                      id: `panel:${uiKey(c.plugin, c.id)}`,
                      label: c.title[locale],
                      icon: ICON_OF[c.icon] ?? "extension",
                    })),
                  },
                ]
              : []),
            ...(files.length > 0
              ? [
                  {
                    label: t("files"),
                    items: files.map((f) => ({ id: `file:${f.id}`, label: f.name })),
                  },
                ]
              : []),
          ],
          current:
            target?.kind === "panel"
              ? `panel:${uiKey(target.plugin, target.contribution)}`
              : target?.kind === "file"
                ? // the hash may name an older version: check its file (m9)
                  `file:${fileOf(target.id)?.id ?? target.id}`
                : "",
          onSwitch: (id) => {
            if (id.startsWith("file:")) openFile(id.slice(5));
            else {
              const c = panels.find((x) => `panel:${uiKey(x.plugin, x.id)}` === id);
              if (c) open({ kind: "panel", plugin: c.plugin, contribution: c.id });
            }
          },
        }
      : undefined;

  let panelNode: ReactNode;
  if (target?.kind === "panel") {
    const c = panels.find((x) => x.plugin === target.plugin && x.id === target.contribution);
    if (c) {
      panelNode = (
        <ExtensionSlot
          key={`${uiKey(c.plugin, c.id)}/${target.item ?? ""}`}
          slot="conversation.panel"
          args={{
            orgId: p.orgId,
            conversationId: p.conversationId,
            ...(target.item !== undefined ? { item: target.item } : {}),
          }}
          select={{ plugin: c.plugin, id: c.id }}
          host={{
            ...(switcher ? { switcher } : {}),
            onClose: close,
            onFullscreen: fullscreen,
            onOpenTarget,
          }}
        />
      );
    }
  } else if (target?.kind === "file") {
    const f = fileOf(target.id);
    if (f) {
      panelNode = (
        <FilePanel
          key={f.id}
          orgId={p.orgId}
          conversationId={f.from?.conversationId ?? p.conversationId}
          file={f}
          files={files}
          onSwitch={openFile}
          onClose={close}
          onFullscreen={fullscreen}
        />
      );
    }
  } else if (target?.kind === "output") {
    const tool = tools.get(target.callId);
    if (tool) {
      panelNode = (
        <OutputPanel
          key={target.callId}
          orgId={p.orgId}
          conversationId={p.conversationId}
          tool={tool}
          title={t("fullOutput")}
          onClose={close}
          onFullscreen={fullscreen}
        />
      );
    }
  } else if (target?.kind === "subagent") {
    // The task name from the list, else from the dispatch rows.
    const description =
      p.subagents?.find((v) => v.id === target.id)?.description ??
      p.entries
        .flatMap((e) => (e.kind === "subagents" ? e.rows : []))
        .find((r) => r.row.id === target.id)?.row.description;
    panelNode = (
      <SubagentPanel
        key={target.id}
        orgId={p.orgId}
        parentId={p.conversationId}
        subagentId={target.id}
        {...(description ? { description } : {})}
        contextWindowOf={p.contextWindowOf}
        reasoningOf={p.reasoningOf}
        {...(hasSubagents ? { onOpenAgent: openAgent, onOpenAgentMap: openMap } : {})}
        onBack={back}
        onClose={close}
        onFullscreen={fullscreen}
      />
    );
  } else if (target?.kind === "backgroundList") {
    panelNode = (
      <BackgroundListPanel
        views={p.subagents ?? NO_SUBAGENTS}
        tasks={background.tasks ?? NO_TASKS}
        loading={background.pending}
        onOpen={(item) =>
          item.kind === "task" ? openTask(item.id) : open({ kind: "subagent", id: item.id })
        }
        onClose={close}
        onFullscreen={fullscreen}
      />
    );
  } else if (target?.kind === "background") {
    panelNode = (
      <BackgroundTaskPanel
        key={target.taskId}
        orgId={p.orgId}
        conversationId={p.conversationId}
        taskId={target.taskId}
        task={background.tasks?.find((x) => x.id === target.taskId)}
        loading={background.pending}
        lastLines={lastLines.get(target.taskId)}
        stopping={background.stopping.has(target.taskId)}
        onStop={() => background.stop(target.taskId)}
        {...(fromList ? { onBack: back } : {})}
        onClose={close}
        onFullscreen={fullscreen}
      />
    );
  }

  // The open area whose read is still on its way draws its own loading state (spec §7.1): a file
  // while the files load, an extension panel or the properties while the contributions do.
  const pending = (r: { data: unknown; error: unknown }) =>
    r.data === undefined && r.error === null;
  const loading: RightAreaSlot["loading"] =
    target?.kind === "file" && pending(filesR)
      ? { title: t("files") }
      : target?.kind === "panel" && contributionsPending
        ? true
        : target?.kind === "properties" && (contributionsPending || pending(filesR))
          ? true
          : undefined;
  const right: RightAreaSlot["right"] =
    target?.kind === "properties"
      ? "properties"
      : panelNode || loading !== undefined
        ? "panel"
        : "none";
  // A sub-agent's terminal event reaches the parent through its stream: nothing to invalidate.
  const { mutate: stopSubagent } = useAppMutation({
    fn: (id: string) => abortRun(p.orgId, id),
    invalidates: () => [],
  });

  const filePaths = useMemo(() => {
    const m = new Map<string, string>();
    // the parent's own files win a path a sub-agent delivered too
    for (const f of [...files].sort((a, b) => Number(!a.from) - Number(!b.from))) {
      if (f.status === "removed") continue;
      m.set(f.sourcePath, f.id);
      m.set(f.name, f.id);
    }
    return m;
  }, [files]);
  const removed = useMemo(
    () =>
      new Set(
        files.flatMap((f) =>
          f.status === "removed" ? [f.id, ...f.versions.map((v) => v.id)] : [],
        ),
      ),
    [files],
  );

  // The composer's agents chip (AC3): the whole tree (read above), the list, the log, progress.
  const agents = useMemo(
    () =>
      hasSubagents
        ? agentsSummary({
            events: p.events,
            views: p.subagents,
            progress: p.progress,
            tree: tree.root,
          })
        : undefined,
    [hasSubagents, p.events, p.subagents, p.progress, tree.root],
  );

  const agentMap =
    mapTarget !== null && hasSubagents ? (
      <AgentMap
        orgId={p.orgId}
        target={mapTarget}
        root={tree.root}
        failed={tree.failed}
        tasks={background.tasks}
        untitled={p.untitled}
        finishes={finishes}
        contextWindowOf={p.contextWindowOf}
        reasoningOf={p.reasoningOf}
        onNavigate={(t) => (t === null ? closeMap() : open(t))}
      />
    ) : undefined;

  return {
    titleBarPanels: [
      // Files opens the newest file (its panel switches to the others); without a file there is
      // no Files button: it would have to open something else (the properties panel).
      ...files.slice(0, 1).map((first) => ({
        id: "files",
        label: t("files"),
        icon: "file-text" as const,
        pressed: target?.kind === "file",
        onOpen: () => openFile(first.id),
      })),
      ...panels.map((c) => ({
        id: `panel:${uiKey(c.plugin, c.id)}`,
        label: c.title[locale],
        icon: ICON_OF[c.icon] ?? "extension",
        pressed:
          target?.kind === "panel" && target.plugin === c.plugin && target.contribution === c.id,
        onOpen: () => open({ kind: "panel", plugin: c.plugin, contribution: c.id }),
      })),
    ],
    properties: {
      pressed: target?.kind === "properties",
      onToggle: () => open(target?.kind === "properties" ? null : { kind: "properties" }),
    },
    right,
    propertiesNode: (
      <PropertiesSections
        orgId={p.orgId}
        conversationId={p.conversationId}
        onOpenTarget={onOpenTarget}
        events={p.events}
        model={p.model}
        contextPct={p.contextPct}
        lastRun={p.lastRun}
        files={files}
        onOpenFile={openFile}
        background={
          p.subagents || background.tasks
            ? {
                views: p.subagents ?? NO_SUBAGENTS,
                tasks: background.tasks ?? NO_TASKS,
                stopping: background.stopping,
                onStop: (item) =>
                  item.kind === "task" ? background.stop(item.id) : stopSubagent(item.id),
                onOpen: (item) =>
                  item.kind === "task"
                    ? openTask(item.id)
                    : open({ kind: "subagent", id: item.id }),
                onOpenCompleted: () => open({ kind: "backgroundList" }),
              }
            : undefined
        }
        total={p.total}
      />
    ),
    ...(panelNode ? { panelNode } : {}),
    ...(agentMap ? { agentMap } : {}),
    ...(agents !== undefined && agents.count > 0 ? { agents: { ...agents, onOpen: openMap } } : {}),
    ...(loading !== undefined ? { loading } : {}),
    onCloseRight: close,
    rightFull: full && right === "panel",
    onRightFullChange: setFull,
    thread: {
      onOpenFile: openFile,
      onMoreFiles: () => open({ kind: "properties" }),
      onOpenOutput: (callId) => open({ kind: "output", callId }),
      ...(target?.kind === "file" ? { selectedFile: target.id } : {}),
      removedFiles: removed,
      filePaths,
      ...(target?.kind === "subagent" ? { openSubagent: target.id } : {}),
      onOpenSubagent: (id) => open({ kind: "subagent", id }),
      ...(hasSubagents ? { onOpenAgentMap: openMap, onOpenAgent: openAgent } : {}),
      onOpenTask: openTask,
      renderCard: (e) => (
        <ExtensionSlot
          slot="conversation.tool-result.card"
          args={{
            orgId: p.orgId,
            conversationId: p.conversationId,
            card: { callId: e.callId, ...(e.cardKey !== undefined ? { key: e.cardKey } : {}) },
          }}
          select={{ plugin: e.plugin, id: e.view }}
          host={{ onOpenTarget }}
        />
      ),
    },
  };
}
