"use client";

import {
  type BubbleAttachment,
  BubbleAttachments,
  FileOutputs,
  ImageOutput,
  isInlineImageType,
  Prose,
  RunDivider,
  Stack,
  SubagentGroup,
  ThinkingRow,
  ToolGroup,
  type ToolRowData,
  typeBadge,
  UserBubble,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, ensureSession } from "../../lib/api";
import { artifactDownloadUrl } from "../../lib/artifacts";
import { attachmentDownloadUrl } from "../../lib/attachments";
import { type ModelRef, type ToolInfo, toolOutputSize } from "../../lib/conversations";
import {
  type DividerData,
  type FileRef,
  isCallKey,
  type TimelineEntry,
  type TimelineTool,
} from "../../lib/timeline";
import { useErrorMessage } from "../../lib/use-error-message";
import { ApprovalCard } from "../ApprovalCard";
import { ConnectCard } from "../ConnectCard";
import { QuestionCard } from "../QuestionCard";
import { useOpenDownload } from "../SessionFilePreview";
import { useSession } from "../shell/session";
import { SubagentWait } from "./SubagentWait";

/** Sizes of archived outputs (`outputId` → characters), fetched once each for "View all". */
function useOutputSizes(
  orgId: string,
  conversationId: string,
  ids: readonly string[],
): ReadonlyMap<string, number> {
  const [sizes, setSizes] = useState<ReadonlyMap<string, number>>(new Map());
  const key = ids.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: ids are represented by key
  useEffect(() => {
    let live = true;
    for (const id of ids) {
      if (sizes.has(id)) continue;
      toolOutputSize(orgId, conversationId, id).then(
        (n) => {
          if (live) setSizes((m) => new Map(m).set(id, n));
        },
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [orgId, conversationId, key]);
  return sizes;
}

const shortTime = (iso: string, locale: string) =>
  new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

const modelName = (m: ModelRef | null) => (m === null ? "—" : m.model);

export type ThreadProps = {
  orgId: string;
  conversationId: string;
  entries: TimelineEntry[];
  info: ReadonlyMap<string, ToolInfo>;
  reasoningOf(m: ModelRef): boolean | undefined;
  /** Retry on the failed divider (the last failure only, while no run is going). */
  onRetry?(d: Extract<DividerData, { divider: "failed" }>): void;
  /** Opens a file output in the right panel. */
  onOpenFile?(id: string): void;
  /** Opens the Files section (the "N more files" card). */
  onMoreFiles?(): void;
  /** Opens a call's full archived output in the right panel. */
  onOpenOutput?(callId: string): void;
  /** The file open in the right panel. */
  selectedFile?: string;
  /** Files whose object is gone (decision 8). */
  removedFiles?: ReadonlySet<string>;
  /** Paths (and names) of the conversation's files: prose chips for them. */
  filePaths?: ReadonlyMap<string, string>;
  /** Renders an inline card (Task 20's extension slot); rendered after the thread items. */
  renderCard?(e: Extract<TimelineEntry, { kind: "card" }>): ReactNode;
  /** The sub-agent open in the right panel. */
  openSubagent?: string;
  /** Opens a sub-agent in the right panel (`#subagent=`). */
  onOpenSubagent?(id: string): void;
  /** Renders a sub-agent's task message (the sub-agent panel); nothing without it. */
  renderTask?(e: Extract<TimelineEntry, { kind: "task" }>): ReactNode;
  /**
   * Whether the thread announces new entries (default true). The sub-agent panel's record passes
   * false, so the page has one live thread (I2).
   */
  live?: boolean;
};

/** The callbacks an entry calls, read through a ref so they never re-render the entries. */
type EntryCallbacks = {
  [K in
    | "onRetry"
    | "onOpenFile"
    | "onMoreFiles"
    | "onOpenOutput"
    | "onOpenSubagent"
    | "renderCard"
    | "renderTask"]?: ThreadProps[K] | undefined;
};

/** What every entry reads besides itself; a new object only when one of these changes. */
type EntryContext = {
  orgId: string;
  conversationId: string;
  info: ReadonlyMap<string, ToolInfo>;
  reasoningOf(m: ModelRef): boolean | undefined;
  sizes: ReadonlyMap<string, number>;
  openSummaries: ReadonlySet<string>;
  toggleSummary(key: string): void;
  retried: ReadonlySet<string>;
  onImageError(id: string): void;
  lastFailed: string | null;
  paths: ReadonlySet<string>;
  filePaths: ReadonlyMap<string, string> | undefined;
  selectedFile: string | undefined;
  removedFiles: ReadonlySet<string> | undefined;
  openSubagent: string | undefined;
  /** Which callbacks are given (an absent one hides its control). */
  has: { retry: boolean; openFile: boolean; moreFiles: boolean; openSubagent: boolean };
  cb: { readonly current: EntryCallbacks };
};

/**
 * The conversation thread (spec §5.5–§5.8): plain data from `lib/timeline.ts` into the design
 * blocks. Human-in-the-loop entries keep their containers (they call the API). Each entry is a
 * `data-entry` element for tests and e2e. Entries are memoized (final review I3): a delta frame
 * re-renders only the streaming entry, since the log's entry objects stay the same between frames.
 */
export function Thread({
  orgId,
  conversationId,
  entries,
  info,
  reasoningOf,
  onRetry,
  onOpenFile,
  onMoreFiles,
  onOpenOutput,
  selectedFile,
  removedFiles,
  filePaths,
  renderCard,
  openSubagent,
  onOpenSubagent,
  live = true,
  renderTask,
}: ThreadProps) {
  const t = useTranslations("chat");
  const [openSummaries, setOpenSummaries] = useState<ReadonlySet<string>>(new Set());
  /** Thumbnails reloaded once after a failed load (the session may have expired). */
  const [retried, setRetried] = useState<ReadonlySet<string>>(new Set());
  const tried = useRef(new Set<string>());
  const onImageError = useCallback((id: string) => {
    if (tried.current.has(id)) return;
    tried.current.add(id);
    ensureSession().then(
      () => setRetried((s) => new Set(s).add(id)),
      () => {
        // Signed out for real: the broken thumbnail stays.
      },
    );
  }, []);
  const toggleSummary = useCallback(
    (key: string) =>
      setOpenSummaries((s) => {
        const next = new Set(s);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const archived = useMemo(
    () =>
      entries.flatMap((e) =>
        e.kind === "tools" ? e.rows.flatMap((r) => (r.outputId ? [r.outputId] : [])) : [],
      ),
    [entries],
  );
  const sizes = useOutputSizes(orgId, conversationId, archived);
  const lastFailed = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.kind === "user") return null;
      if (e?.kind === "divider" && e.divider === "failed") return e.key;
    }
    return null;
  }, [entries]);
  const paths = useMemo(() => new Set(filePaths?.keys() ?? []), [filePaths]);
  const cb = useRef<EntryCallbacks>({});
  cb.current = {
    onRetry,
    onOpenFile,
    onMoreFiles,
    onOpenOutput,
    onOpenSubagent,
    renderCard,
    renderTask,
  };
  const hasRetry = onRetry !== undefined;
  const hasOpenFile = onOpenFile !== undefined;
  const hasMoreFiles = onMoreFiles !== undefined;
  const hasOpenSubagent = onOpenSubagent !== undefined;
  const ctx = useMemo<EntryContext>(
    () => ({
      orgId,
      conversationId,
      info,
      reasoningOf,
      sizes,
      openSummaries,
      toggleSummary,
      retried,
      onImageError,
      lastFailed,
      paths,
      filePaths,
      selectedFile,
      removedFiles,
      openSubagent,
      has: {
        retry: hasRetry,
        openFile: hasOpenFile,
        moreFiles: hasMoreFiles,
        openSubagent: hasOpenSubagent,
      },
      cb,
    }),
    [
      orgId,
      conversationId,
      info,
      reasoningOf,
      sizes,
      openSummaries,
      toggleSummary,
      retried,
      onImageError,
      lastFailed,
      paths,
      filePaths,
      selectedFile,
      removedFiles,
      openSubagent,
      hasRetry,
      hasOpenFile,
      hasMoreFiles,
      hasOpenSubagent,
    ],
  );

  if (entries.length === 0) return null;

  return (
    <div role="log" aria-live={live ? "polite" : "off"} aria-label={t("timeline")}>
      <Stack gap={12}>
        {entries.map((e) => (
          <EntryView key={e.key} e={e} c={ctx} />
        ))}
      </Stack>
    </div>
  );
}

/**
 * One entry and its `data-entry` wrapper. Re-renders only when its entry object or the shared
 * context changes; inline cards and task lines render from the page's state, so they always do.
 */
const EntryView = memo(
  function EntryView({ e, c }: { e: TimelineEntry; c: EntryContext }) {
    const node = <EntryNode e={e} c={c} />;
    return (
      <div
        data-entry={e.kind}
        {...(e.kind === "divider" ? { "data-divider": e.divider } : {})}
        {...(e.kind === "prose" && e.streaming
          ? // busy until it settles: the live thread announces the reply once, not per token
            { "data-streaming": "true", "aria-busy": true }
          : {})}
        {...(e.kind === "tools"
          ? {
              "data-tool-keys": e.rows.map((r) => r.toolKey).join(" "),
              "data-tool-status": e.rows.map((r) => r.row.status).join(" "),
            }
          : {})}
      >
        {node}
      </div>
    );
  },
  (a, b) => a.e === b.e && a.c === b.c && a.e.kind !== "card" && a.e.kind !== "task",
);

function EntryNode({ e, c }: { e: TimelineEntry; c: EntryContext }): ReactNode {
  const t = useTranslations("chat");
  const te = useTranslations("errors");
  const locale = useLocale();
  const { me } = useSession();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const openDownload = useOpenDownload();
  const {
    orgId,
    conversationId,
    info,
    reasoningOf,
    sizes,
    openSummaries,
    toggleSummary,
    retried,
    onImageError,
    lastFailed,
    paths,
    filePaths,
    selectedFile,
    removedFiles,
    openSubagent,
  } = c;
  // Callbacks go through the ref at call time: a memoized entry never calls a stale one.
  const cb = c.cb;
  const onRetry = c.has.retry
    ? (d: Extract<DividerData, { divider: "failed" }>) => cb.current.onRetry?.(d)
    : undefined;
  const onOpenFile = c.has.openFile ? (id: string) => cb.current.onOpenFile?.(id) : undefined;
  const onMoreFiles = c.has.moreFiles ? () => cb.current.onMoreFiles?.() : undefined;
  const onOpenOutput = (callId: string) => cb.current.onOpenOutput?.(callId);
  const onOpenSubagent = c.has.openSubagent
    ? (id: string) => cb.current.onOpenSubagent?.(id)
    : undefined;
  const { renderCard, renderTask } = cb.current;

  const who = (id: string | null) =>
    id === null ? t("system") : id === me.account.id ? t("you") : id;

  const rowWithSize = (r: TimelineTool): ToolRowData => {
    const total = r.outputId ? sizes.get(r.outputId) : undefined;
    const out = r.row.detail?.output;
    if (total === undefined || out === undefined) return r.row;
    return {
      ...r.row,
      detail: { ...r.row.detail, outputBytes: total, outputShownBytes: out.length },
    };
  };

  const divider = (e: Extract<TimelineEntry, { kind: "divider" }>): ReactNode => {
    switch (e.divider) {
      case "stopped":
        return (
          <RunDivider
            kind="stopped"
            text={t("divider.stopped", { who: who(e.byAccountId), time: shortTime(e.at, locale) })}
          />
        );
      case "hook-denied":
        return (
          <RunDivider
            kind="hook-denied"
            text={
              e.plugin !== null
                ? te("run.hook_denied", { plugin: e.plugin })
                : te("run.hook_denied_unknown")
            }
          />
        );
      case "compacted": {
        const open = openSummaries.has(e.key);
        return (
          <RunDivider
            kind="compacted"
            text={
              e.savedTokens !== null
                ? t("divider.compactedSaved", { n: e.savedTokens })
                : t("divider.compacted")
            }
            action={{
              expanded: open,
              onClick: () => toggleSummary(e.key),
            }}
          >
            {open ? e.summary : undefined}
          </RunDivider>
        );
      }
      case "fallback":
        return (
          <RunDivider
            kind="fallback"
            text={t("divider.fallback", { from: modelName(e.from), to: modelName(e.to) })}
          />
        );
      case "failed": {
        // A run fails with these two codes only at start, reading the pinned skills.
        const reason =
          e.code === "storage.unavailable"
            ? `${te("run.pinned_unavailable")}${e.message ? ` ${e.message}` : ""}`
            : e.code === "conflict"
              ? te("run.pinned_conflict")
              : errorMessage(new ApiClientError(0, e.code, e.code));
        const text = e.retried
          ? t("divider.failedRetried", { reason })
          : t("divider.failed", { reason });
        const canRetry = !e.retried && e.retry !== null && e.key === lastFailed && onRetry;
        return (
          <RunDivider
            kind="failed"
            text={text}
            {...(canRetry ? { action: { onClick: () => onRetry(e) } } : {})}
          />
        );
      }
    }
  };

  const files = (list: FileRef[]): ReactNode => {
    const images = list.filter((f) => isInlineImageType(f.contentType));
    const rest = list.filter((f) => !isInlineImageType(f.contentType));
    const open = (id: string) => onOpenFile?.(id);
    return (
      <Stack gap={8}>
        {images.map((f) => (
          <ImageOutput
            key={f.id}
            src={artifactDownloadUrl(orgId, conversationId, f.id, { inline: true })}
            name={f.name}
            size={f.size}
            onOpen={() => open(f.id)}
            onDownload={() => openDownload(artifactDownloadUrl(orgId, conversationId, f.id))}
          />
        ))}
        {rest.length > 0 ? (
          <FileOutputs
            files={rest.map((f) => ({
              id: f.id,
              name: f.name,
              contentType: f.contentType,
              size: f.size,
              ...(removedFiles?.has(f.id) ? { removed: { reason: t("fileRemoved") } } : {}),
            }))}
            {...(selectedFile !== undefined ? { selected: selectedFile } : {})}
            onOpen={open}
            {...(onMoreFiles ? { onMore: onMoreFiles } : {})}
          />
        ) : null}
      </Stack>
    );
  };

  const entry = (e: TimelineEntry): ReactNode => {
    switch (e.kind) {
      case "user": {
        const atts: BubbleAttachment[] = [
          ...e.files.map(
            (f): BubbleAttachment => ({
              id: f.attachmentId,
              kind: f.kind === "image" ? "image" : "file",
              name: f.name,
              type: typeBadge(f.name, f.mediaType),
              ...(f.kind === "image"
                ? {
                    src: `${attachmentDownloadUrl(orgId, f.attachmentId)}${retried.has(f.attachmentId) ? "?retry=1" : ""}`,
                  }
                : {}),
            }),
          ),
          ...e.attachments.map(
            (a): BubbleAttachment => ({
              id: `@${a.appId}:${a.uri}`,
              kind: "file",
              name: `@${a.name} · ${a.appName}`,
            }),
          ),
        ];
        return (
          <UserBubble
            text={e.text}
            {...(atts.length > 0
              ? {
                  attachments: (
                    <BubbleAttachments
                      items={atts}
                      onImageError={onImageError}
                      onOpen={(id) => {
                        if (!id.startsWith("@")) openDownload(attachmentDownloadUrl(orgId, id));
                      }}
                    />
                  ),
                }
              : {})}
          />
        );
      }
      case "prose":
        return (
          <Prose
            markdown={e.text}
            streaming={e.streaming}
            {...(paths.size > 0 ? { paths } : {})}
            {...(onOpenFile && filePaths
              ? {
                  onOpenPath: (p: string) => {
                    const id = filePaths.get(p);
                    if (id !== undefined) onOpenFile(id);
                  },
                }
              : {})}
          />
        );
      case "thinking":
        if (e.model !== null && reasoningOf(e.model) === false) return null;
        return <ThinkingRow seconds={e.seconds} text={e.text} live={e.live} />;
      case "tools":
        return (
          <ToolGroup
            rows={e.rows.map(rowWithSize)}
            onViewAll={(rowId) => {
              const r = e.rows.find((x) => x.row.id === rowId);
              if (r) onOpenOutput?.(r.callId);
            }}
            onCopy={(rowId) => {
              const r = e.rows.find((x) => x.row.id === rowId);
              const text = r?.row.detail?.output;
              if (text === undefined) return;
              navigator.clipboard?.writeText(text).then(
                () => toast.success(t("copied")),
                () => {},
              );
            }}
          />
        );
      case "subagents":
        return (
          <SubagentGroup
            rows={e.rows.map((r) => r.row)}
            {...(openSubagent !== undefined ? { openId: openSubagent } : {})}
            onOpen={(id) => {
              // A call refused before any dispatch keeps its call key as id: no record to open.
              if (!isCallKey(id)) onOpenSubagent?.(id);
            }}
          />
        );
      case "subagent-wait":
        return (
          <SubagentWait
            orgId={orgId}
            wait={e}
            info={info}
            {...(onOpenSubagent ? { onOpen: onOpenSubagent } : {})}
          />
        );
      case "task":
        return renderTask?.(e) ?? null;
      case "approval":
        return <ApprovalCard orgId={orgId} item={e.item} info={info.get(e.item.toolKey)} />;
      case "question":
        return <QuestionCard orgId={orgId} item={e.item} />;
      case "connect":
        return <ConnectCard orgId={orgId} item={e.item} />;
      case "card":
        return renderCard?.(e) ?? null;
      case "files":
        return files(e.files);
      case "divider":
        return divider(e);
    }
  };

  return entry(e);
}
