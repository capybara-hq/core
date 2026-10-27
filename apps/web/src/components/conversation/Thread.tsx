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
  ThinkingRow,
  ToolGroup,
  type ToolRowData,
  typeBadge,
  UserBubble,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, ensureSession } from "../../lib/api";
import { artifactDownloadUrl } from "../../lib/artifacts";
import { attachmentDownloadUrl } from "../../lib/attachments";
import { type ModelRef, type ToolInfo, toolOutputSize } from "../../lib/conversations";
import type { DividerData, FileRef, TimelineEntry, TimelineTool } from "../../lib/timeline";
import { useErrorMessage } from "../../lib/use-error-message";
import { ApprovalCard } from "../ApprovalCard";
import { ConnectCard } from "../ConnectCard";
import { QuestionCard } from "../QuestionCard";
import { useOpenDownload } from "../SessionFilePreview";
import { useSession } from "../shell/session";

/** Re-renders every second while `active` (running rows show their elapsed time). */
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
};

/**
 * The conversation thread (spec §5.5–§5.8): plain data from `lib/timeline.ts` into the design
 * blocks. Human-in-the-loop entries keep their containers (they call the API). Each entry is a
 * `data-entry` element for tests and e2e.
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
}: ThreadProps) {
  const t = useTranslations("chat");
  const te = useTranslations("errors");
  const locale = useLocale();
  const { me } = useSession();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const openDownload = useOpenDownload();
  const [openSummaries, setOpenSummaries] = useState<ReadonlySet<string>>(new Set());
  /** Thumbnails reloaded once after a failed load (the session may have expired). */
  const [retried, setRetried] = useState<ReadonlySet<string>>(new Set());
  const tried = useRef(new Set<string>());
  const onImageError = (id: string) => {
    if (tried.current.has(id)) return;
    tried.current.add(id);
    ensureSession().then(
      () => setRetried((s) => new Set(s).add(id)),
      () => {
        // Signed out for real: the broken thumbnail stays.
      },
    );
  };
  const running = entries.some(
    (e) =>
      e.kind === "tools" &&
      e.rows.some((r) => r.row.status === "running" || r.row.status === "pending"),
  );
  const now = useNow(running);
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

  if (entries.length === 0) return null;

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
              onClick: () =>
                setOpenSummaries((s) => {
                  const next = new Set(s);
                  if (!next.delete(e.key)) next.add(e.key);
                  return next;
                }),
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
            now={now}
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

  return (
    <div role="log" aria-live="polite" aria-label={t("timeline")}>
      <Stack gap={12}>
        {entries.map((e) => {
          const node = entry(e);
          if (node === null) return null;
          return (
            <div
              key={e.key}
              data-entry={e.kind}
              {...(e.kind === "divider" ? { "data-divider": e.divider } : {})}
              {...(e.kind === "prose" && e.streaming ? { "data-streaming": "true" } : {})}
            >
              {node}
            </div>
          );
        })}
      </Stack>
    </div>
  );
}
