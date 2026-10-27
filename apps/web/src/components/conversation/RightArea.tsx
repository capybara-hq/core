"use client";

import { RightPanel, type RightPanelSwitcher, TextPreview } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type ConversationEvent, type ModelRef, readToolOutput } from "../../lib/conversations";
import { type FileOutput, listFiles } from "../../lib/files";
import { formatRightHash, parseRightHash, type RightTarget } from "../../lib/right-area";
import type { TimelineEntry, TimelineTool } from "../../lib/timeline";
import {
  listUiContributions,
  type UiContributionItem,
  type UiOpen,
  uiKey,
  uiLocale,
} from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import type { RightAreaSlot } from "./ConversationView";
import { type BlockContext, ExtensionCard, ExtensionPanel, ICON_OF } from "./ExtensionBlocks";
import { FilePanel } from "./FilePanel";
import { PropertiesSections } from "./PropertiesSections";

/**
 * The right area's target, kept in the URL hash (a reload keeps it; another conversation's URL has
 * none, so nothing carries over). Opening one thing closes the other (spec §5.1).
 */
export function useRightArea(): {
  target: RightTarget | null;
  open(t: RightTarget | null): void;
} {
  const [target, setTarget] = useState<RightTarget | null>(null);
  useEffect(() => {
    const read = () => setTarget(parseRightHash(window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const open = useCallback((t: RightTarget | null) => {
    setTarget(t);
    const { pathname, search } = window.location;
    window.history.replaceState(
      window.history.state,
      "",
      `${pathname}${search}${formatRightHash(t)}`,
    );
  }, []);
  return { target, open };
}

/**
 * The extensions' UI contributions for this org (enabled and loaded only). Read again after a
 * stream reconnect (`*`) and when the window gets focus: an extension disabled meanwhile loses
 * its icon, sections and cards. The last good list stays while reading.
 */
function useContributions(orgId: string, version: number): UiContributionItem[] | null {
  const [items, setItems] = useState<UiContributionItem[] | null>(null);
  const [focus, setFocus] = useState(0);
  useEffect(() => {
    const onFocus = () => setFocus((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version and focus trigger a reread
  useEffect(() => {
    let live = true;
    listUiContributions(orgId).then(
      (r) => {
        if (live) setItems(r.items);
      },
      () => {
        // Unreadable: keep what was shown (or none); the conversation carries on.
        if (live) setItems((prev) => prev ?? []);
      },
    );
    return () => {
      live = false;
    };
  }, [orgId, version, focus]);
  return items;
}

/** The conversation's file outputs, read again on `changed: files` (and reconnects). */
function useFiles(orgId: string, conversationId: string, version: number): FileOutput[] {
  const [files, setFiles] = useState<FileOutput[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version triggers a reread
  useEffect(() => {
    let live = true;
    listFiles(orgId, conversationId).then(
      (f) => {
        if (live) setFiles(f);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [orgId, conversationId, version]);
  return files;
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
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; text: string; complete: boolean }
    | { kind: "error"; reason: string }
  >({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries
  useEffect(() => {
    let live = true;
    const outputId = tool.outputId;
    if (outputId === null) {
      setState({ kind: "ready", text: tool.row.detail?.output ?? "", complete: true });
      return;
    }
    setState({ kind: "loading" });
    readToolOutput(orgId, conversationId, outputId).then(
      (r) => {
        if (live) setState({ kind: "ready", ...r });
      },
      (e: unknown) => {
        if (live) setState({ kind: "error", reason: errorMessage(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [orgId, conversationId, tool.outputId, attempt]);
  return (
    <RightPanel
      title={title}
      meta={tool.toolKey}
      body="flush"
      onClose={onClose}
      onFullscreen={onFullscreen}
      state={state.kind === "error" ? "failed" : state.kind}
      {...(state.kind === "error" ? { failure: { reason: state.reason } } : {})}
      onRetry={() => setAttempt((n) => n + 1)}
    >
      {state.kind === "ready" ? (
        <TextPreview text={state.text} truncated={!state.complete} />
      ) : null}
    </RightPanel>
  );
}

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
  uiVersions: Readonly<Record<string, number>>;
  filesVersion: number;
  model: ModelRef | null;
  contextPct: number | null;
}): RightAreaSlot {
  const t = useTranslations("chat");
  const locale = uiLocale(useLocale());
  const { target, open } = useRightArea();
  const contributions = useContributions(p.orgId, p.uiVersions["*"] ?? 0);
  const files = useFiles(p.orgId, p.conversationId, p.filesVersion);
  const panels = useMemo(
    () => (contributions ?? []).filter((c) => c.place === "panel"),
    [contributions],
  );
  const sections = useMemo(
    () => (contributions ?? []).filter((c) => c.place === "section"),
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
    versions: p.uiVersions,
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
                ? `file:${target.id}`
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
          conversationId={p.conversationId}
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
  }
  // `#subagent=` is Task 21's (phase C): until then it shows nothing.

  const right: RightAreaSlot["right"] =
    target?.kind === "properties" ? "properties" : panelNode ? "panel" : "none";

  const filePaths = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of files) {
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
      {
        id: "files",
        label: t("files"),
        icon: "file-text",
        pressed: target?.kind === "file",
        onOpen: () => {
          const first = files[0];
          if (first) openFile(first.id);
          else open({ kind: "properties" });
        },
      },
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
        files={files}
        sections={sections}
        onOpenFile={openFile}
      />
    ),
    ...(panelNode ? { panelNode } : {}),
    onCloseRight: close,
    thread: {
      onOpenFile: openFile,
      onMoreFiles: () => open({ kind: "properties" }),
      onOpenOutput: (callId) => open({ kind: "output", callId }),
      ...(target?.kind === "file" ? { selectedFile: target.id } : {}),
      removedFiles: removed,
      filePaths,
      renderCard: (e) => (
        <ExtensionCard
          ctx={ctx}
          contributions={contributions ?? []}
          plugin={e.plugin}
          view={e.view}
          callId={e.callId}
          {...(e.cardKey !== undefined ? { cardKey: e.cardKey } : {})}
        />
      ),
    },
  };
}
