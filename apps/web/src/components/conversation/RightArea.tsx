"use client";

import { RightPanel, type RightPanelSwitcher, TextPreview } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  abortRun,
  type ConversationEvent,
  type ModelRef,
  type SubagentView,
} from "../../lib/conversations";
import type { FileOutput } from "../../lib/files";
import { retryOnMountOf } from "../../lib/query/client";
import { contributionsQuery, filesQuery, toolOutputQuery } from "../../lib/query/conversation";
import { useAppMutation } from "../../lib/query/mutation";
import { formatRightHash, parseRightHash, type RightTarget } from "../../lib/right-area";
import type { TimelineEntry, TimelineTool } from "../../lib/timeline";
import { type UiContributionItem, type UiOpen, uiKey, uiLocale } from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import type { RightAreaSlot } from "./ConversationView";
import { type BlockContext, ExtensionCard, ExtensionPanel, ICON_OF } from "./ExtensionBlocks";
import { FilePanel } from "./FilePanel";
import { PropertiesSections } from "./PropertiesSections";
import { SubagentPanel } from "./SubagentPanel";

/**
 * The right area's target, kept in the URL hash (a reload keeps it; another conversation's URL has
 * none, so nothing carries over). Opening one thing closes the other (spec §5.1). `back` leaves a
 * sub-agent for what was open before it (e.g. the properties panel it was opened from), else closes.
 */
export function useRightArea(): {
  target: RightTarget | null;
  open(t: RightTarget | null): void;
  back(): void;
} {
  const [target, setTarget] = useState<RightTarget | null>(null);
  const current = useRef<RightTarget | null>(null);
  /** What was open before the sub-agent now shown (opening another sub-agent keeps it). */
  const previous = useRef<RightTarget | null>(null);
  useEffect(() => {
    // Inbox and IM links name a sub-agent as `?subagent=<id>`: it becomes the hash.
    const url = new URL(window.location.href);
    const legacy = url.searchParams.get("subagent");
    if (legacy) {
      url.searchParams.delete("subagent");
      url.hash = formatRightHash({ kind: "subagent", id: legacy });
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    const read = () => {
      const t = parseRightHash(window.location.hash);
      current.current = t;
      previous.current = null;
      setTarget(t);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const open = useCallback((t: RightTarget | null) => {
    if (t?.kind === "subagent") {
      if (current.current?.kind !== "subagent") previous.current = current.current;
    } else previous.current = null;
    current.current = t;
    setTarget(t);
    const { pathname, search } = window.location;
    window.history.replaceState(
      window.history.state,
      "",
      `${pathname}${search}${formatRightHash(t)}`,
    );
  }, []);
  const back = useCallback(() => open(previous.current), [open]);
  return { target, open, back };
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
      meta={tool.toolKey}
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

const NONE_CONTRIBUTIONS: UiContributionItem[] = [];
const NO_FILES: FileOutput[] = [];

const fullscreen = () => {
  const el = document.querySelector('[data-part="right-panel"]');
  if (el && typeof (el as HTMLElement).requestFullscreen === "function")
    void (el as HTMLElement).requestFullscreen().catch(() => {});
};

/**
 * The right area of the conversation page (Task 20): the title-bar panel icons (Files, then the
 * extensions' panels), the properties panel (Context, Files, the extensions' sections) or one right
 * panel (an extension panel, a file, a call's full output), inline cards for the thread, and the
 * file wiring of the thread (chips, cards, "View all").
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
  contextWindowOf(m: ModelRef): number | undefined;
  reasoningOf(m: ModelRef): boolean | undefined;
}): RightAreaSlot {
  const t = useTranslations("chat");
  const locale = uiLocale(useLocale());
  const { target, open, back } = useRightArea();
  // The extensions' contributions (enabled and loaded only) and the conversation's file outputs.
  // A failed read (R5: not read again on mount) shows none: no extension blocks, no files.
  // Sub-agents cannot deliver files (`sandbox_deliver` is removed for children), so their lists
  // are not read (Task 22 ruling, final review I5).
  const contributionsQ = contributionsQuery(p.orgId);
  const contributionsR = useQuery({
    ...contributionsQ,
    retryOnMount: retryOnMountOf(contributionsQ.queryKey),
  });
  const filesQ = filesQuery(p.orgId, p.conversationId);
  const filesR = useQuery({ ...filesQ, retryOnMount: retryOnMountOf(filesQ.queryKey) });
  const contributions = contributionsR.data ?? NONE_CONTRIBUTIONS;
  const files = filesR.data ?? NO_FILES;
  const panels = useMemo(() => contributions.filter((c) => c.place === "panel"), [contributions]);
  const sections = useMemo(
    () => contributions.filter((c) => c.place === "section"),
    [contributions],
  );
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
  const ctx: BlockContext = {
    orgId: p.orgId,
    conversationId: p.conversationId,
    onOpen: onOpenTarget,
  };
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
        <ExtensionPanel
          key={`${uiKey(c.plugin, c.id)}/${target.item ?? ""}`}
          ctx={ctx}
          c={c}
          item={target.item}
          {...(switcher ? { switcher } : {})}
          onClose={close}
          onFullscreen={fullscreen}
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
        onBack={back}
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
      : target?.kind === "panel" && pending(contributionsR)
        ? true
        : target?.kind === "properties" && (pending(contributionsR) || pending(filesR))
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
        ctx={ctx}
        events={p.events}
        model={p.model}
        contextPct={p.contextPct}
        lastRun={p.lastRun}
        files={files}
        sections={sections}
        onOpenFile={openFile}
        subagents={
          p.subagents
            ? {
                views: p.subagents,
                onStop: (id) => stopSubagent(id),
                onOpen: (id) => open({ kind: "subagent", id }),
              }
            : undefined
        }
        total={p.total}
      />
    ),
    ...(panelNode ? { panelNode } : {}),
    ...(loading !== undefined ? { loading } : {}),
    onCloseRight: close,
    thread: {
      onOpenFile: openFile,
      onMoreFiles: () => open({ kind: "properties" }),
      onOpenOutput: (callId) => open({ kind: "output", callId }),
      ...(target?.kind === "file" ? { selectedFile: target.id } : {}),
      removedFiles: removed,
      filePaths,
      ...(target?.kind === "subagent" ? { openSubagent: target.id } : {}),
      onOpenSubagent: (id) => open({ kind: "subagent", id }),
      renderCard: (e) => (
        <ExtensionCard
          ctx={ctx}
          contributions={contributions}
          plugin={e.plugin}
          view={e.view}
          callId={e.callId}
          {...(e.cardKey !== undefined ? { cardKey: e.cardKey } : {})}
        />
      ),
    },
  };
}
