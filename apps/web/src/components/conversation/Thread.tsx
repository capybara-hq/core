"use client";

import {
  type BubbleAttachment,
  BubbleAttachments,
  Disclosure,
  FileOutputs,
  ImageOutput,
  isInlineImageType,
  Prose,
  RunDivider,
  RunRow,
  Stack,
  SubagentGroup,
  Text,
  ThinkingRow,
  ToolGroup,
  type ToolRowData,
  typeBadge,
  UserBubble,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { memo, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { ApiClientError, ensureSession } from "../../lib/api";
import { artifactDownloadUrl } from "../../lib/artifacts";
import { attachmentDownloadUrl } from "../../lib/attachments";
import type { ModelRef, ToolInfo } from "../../lib/conversations";
import { retryOnMountOf } from "../../lib/query/client";
import { toolOutputSizeQuery } from "../../lib/query/conversation";
import { membersQuery } from "../../lib/query/members";
import {
  canConfigureModels,
  canViewTrajectory,
  isModelSetupError,
  runParts,
} from "../../lib/run-row";
import type { CompactionProgress } from "../../lib/stream";
import { shortTime } from "../../lib/time";
import {
  type FailedRun,
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
import { CompactingRow } from "./CompactingRow";
import { NetworkFacts } from "./NetworkFacts";
import { SubagentWait } from "./SubagentWait";

/** Sizes of archived outputs (`outputId` → characters), read once each for "View all". */
function useOutputSizes(
  orgId: string,
  conversationId: string,
  ids: readonly string[],
): ReadonlyMap<string, number> {
  const results = useQueries({
    queries: ids.map((id) => toolOutputSizeQuery(orgId, conversationId, id)),
  });
  // One map per set of answers: the entries re-render only when one arrives.
  const answered = ids.map((id, i) => `${id}=${results[i]?.data ?? ""}`).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the answers are represented by `answered`
  return useMemo(() => {
    const sizes = new Map<string, number>();
    ids.forEach((id, i) => {
      const n = results[i]?.data;
      if (n !== undefined) sizes.set(id, n);
    });
    return sizes;
  }, [answered]);
}

/**
 * Display names of the org's members, read once the thread shows a run another account stopped
 * (m8); empty while loading or when the caller cannot list members (a guest).
 */
function useMemberNames(orgId: string, needed: boolean): ReadonlyMap<string, string> {
  const q = membersQuery(orgId);
  const { data } = useQuery({
    ...q,
    enabled: needed,
    retryOnMount: retryOnMountOf(q.queryKey),
  });
  return useMemo(
    () => new Map((data?.members ?? []).map((m) => [m.account.id, m.account.displayName])),
    [data],
  );
}

const modelName = (m: ModelRef | null) => (m === null ? "—" : m.model);

export type ThreadProps = {
  orgId: string;
  conversationId: string;
  entries: TimelineEntry[];
  info: ReadonlyMap<string, ToolInfo>;
  reasoningOf(m: ModelRef): boolean | undefined;
  /** Retry on the failed run row (the last failure only, while no run is going). */
  onRetry?(d: FailedRun): void;
  /**
   * The main thread's run rows link out (spec §6.16.23): 查看轨迹 for the roles the kernel lets
   * read the trajectory (the agent's owner decides for members), 去配置模型服务 for super
   * admins. Absent (a sub-agent's record), the rows link nowhere. `trajectory: false` (a
   * sub-agent conversation, whose trajectory the kernel gates on the parent's agent) drops 查看轨迹.
   */
  runLinks?: { agentOwnerId: string | undefined; trajectory?: boolean };
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
  /** Opens a sub-agent in the right panel (`#subagent=`): a waiting sub-agent's line. */
  onOpenSubagent?(id: string): void;
  /**
   * Opens a sub-agent in the agent map: level 2 (`#agents=<id>`) from an `Agent` call block's
   * action and a delivery row without text; its transcript (`transcript`, `#agents=<id>/transcript`,
   * where its approval, question or connection card is) from a nested agent's wait.
   */
  onOpenAgent?(id: string, transcript?: boolean): void;
  /** Opens the agent map (`#agents`): the sub-agent groups' header action. */
  onOpenAgentMap?(): void;
  /** Opens a background task's output in the right panel (`#bg-<taskId>`). */
  onOpenTask?(taskId: string): void;
  /** Renders a sub-agent's task message (the sub-agent panel); nothing without it. */
  renderTask?(e: Extract<TimelineEntry, { kind: "task" }>): ReactNode;
  /**
   * Whether the thread announces new entries (default true). The sub-agent panel's record passes
   * false, so the page has one live thread (I2).
   */
  live?: boolean;
  /**
   * The running compaction's progress (ephemeral, context compaction spec §4.6), shown as a row at
   * the end of the thread until the compaction's event replaces it.
   */
  compaction?: CompactionProgress | null;
};

/** The callbacks an entry calls, read through a ref so they never re-render the entries. */
type EntryCallbacks = {
  [K in
    | "onRetry"
    | "onOpenFile"
    | "onMoreFiles"
    | "onOpenOutput"
    | "onOpenSubagent"
    | "onOpenAgent"
    | "onOpenAgentMap"
    | "onOpenTask"
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
  /** Member display names (another member who stopped a run). */
  names: ReadonlyMap<string, string>;
  /** The run rows' links this reader may follow. */
  links: { trajectory: boolean; configureModels: boolean };
  /** Which callbacks are given (an absent one hides its control). */
  has: {
    retry: boolean;
    openFile: boolean;
    moreFiles: boolean;
    openSubagent: boolean;
    openAgent: boolean;
    openAgentMap: boolean;
    openTask: boolean;
  };
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
  onOpenAgent,
  onOpenAgentMap,
  onOpenTask,
  live = true,
  renderTask,
  runLinks,
  compaction,
}: ThreadProps) {
  const t = useTranslations("chat");
  const [openSummaries, setOpenSummaries] = useState<ReadonlySet<string>>(new Set());
  /** Thumbnails reloaded once after a failed load (the session may have expired). */
  const [retried, setRetried] = useState<ReadonlySet<string>>(new Set());
  const tried = useRef(new Set<string>());
  const onImageError = useCallback((id: string) => {
    if (tried.current.has(id)) return;
    tried.current.add(id);
    // query-exempt: a session refresh before reloading a thumbnail, not a kernel read
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
      if (e?.kind === "run" && e.status === "failed") return e.key;
    }
    return null;
  }, [entries]);
  const paths = useMemo(() => new Set(filePaths?.keys() ?? []), [filePaths]);
  const { me } = useSession();
  const stoppedByOther = entries.some(
    (e) =>
      e.kind === "run" &&
      e.status === "stopped" &&
      e.byAccountId !== null &&
      e.byAccountId !== me.account.id,
  );
  const names = useMemberNames(orgId, stoppedByOther);
  const cb = useRef<EntryCallbacks>({});
  cb.current = {
    onRetry,
    onOpenFile,
    onMoreFiles,
    onOpenOutput,
    onOpenSubagent,
    onOpenAgent,
    onOpenAgentMap,
    onOpenTask,
    renderCard,
    renderTask,
  };
  const trajectory =
    runLinks !== undefined &&
    runLinks.trajectory !== false &&
    canViewTrajectory(me, runLinks.agentOwnerId);
  const configureModels = runLinks !== undefined && canConfigureModels(me);
  const hasRetry = onRetry !== undefined;
  const hasOpenFile = onOpenFile !== undefined;
  const hasMoreFiles = onMoreFiles !== undefined;
  const hasOpenSubagent = onOpenSubagent !== undefined;
  const hasOpenAgent = onOpenAgent !== undefined;
  const hasOpenAgentMap = onOpenAgentMap !== undefined;
  const hasOpenTask = onOpenTask !== undefined;
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
      names,
      links: { trajectory, configureModels },
      has: {
        retry: hasRetry,
        openFile: hasOpenFile,
        moreFiles: hasMoreFiles,
        openSubagent: hasOpenSubagent,
        openAgent: hasOpenAgent,
        openAgentMap: hasOpenAgentMap,
        openTask: hasOpenTask,
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
      names,
      trajectory,
      configureModels,
      hasRetry,
      hasOpenFile,
      hasMoreFiles,
      hasOpenSubagent,
      hasOpenAgent,
      hasOpenAgentMap,
      hasOpenTask,
    ],
  );

  if (entries.length === 0 && !compaction) return null;

  return (
    <div role="log" aria-live={live ? "polite" : "off"} aria-label={t("timeline")}>
      <Stack gap={12}>
        {entries.map((e) => (
          <EntryView key={e.key} e={e} c={ctx} />
        ))}
        {compaction ? <CompactingRow progress={compaction} /> : null}
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
        {...(e.kind === "run" ? { "data-run-status": e.status } : {})}
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
  const tb = useTranslations("background");
  const te = useTranslations("errors");
  const locale = useLocale();
  const timeZone = useTimeZone();
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
  } = c;
  // Callbacks go through the ref at call time: a memoized entry never calls a stale one.
  const cb = c.cb;
  const onRetry = c.has.retry ? (d: FailedRun) => cb.current.onRetry?.(d) : undefined;
  const onOpenFile = c.has.openFile ? (id: string) => cb.current.onOpenFile?.(id) : undefined;
  const onMoreFiles = c.has.moreFiles ? () => cb.current.onMoreFiles?.() : undefined;
  const onOpenOutput = (callId: string) => cb.current.onOpenOutput?.(callId);
  const onOpenSubagent = c.has.openSubagent
    ? (id: string) => cb.current.onOpenSubagent?.(id)
    : undefined;
  const onOpenAgent = c.has.openAgent
    ? (id: string, transcript?: boolean) => cb.current.onOpenAgent?.(id, transcript)
    : undefined;
  const onOpenAgentMap = c.has.openAgentMap ? () => cb.current.onOpenAgentMap?.() : undefined;
  const onOpenTask = c.has.openTask
    ? (taskId: string) => cb.current.onOpenTask?.(taskId)
    : undefined;
  const { renderCard, renderTask } = cb.current;

  const who = (id: string | null) =>
    id === null
      ? t("system")
      : id === me.account.id
        ? t("you")
        : (c.names.get(id) ?? t("anotherMember"));

  const rowWithSize = (r: TimelineTool): ToolRowData => {
    const taskId = r.background?.taskId;
    const row = r.lines
      ? { ...r.row, extra: t("toolLines", r.lines) }
      : r.background
        ? {
            ...r.row,
            extra: tb("inBackground"),
            ...(taskId && onOpenTask
              ? {
                  link: {
                    label: tb("openTask", { name: r.row.description ?? taskId }),
                    onOpen: () => onOpenTask(taskId),
                  },
                }
              : {}),
          }
        : r.row;
    const total = r.outputId ? sizes.get(r.outputId) : undefined;
    const out = row.detail?.output;
    if (total === undefined || out === undefined) return row;
    return {
      ...row,
      detail: { ...row.detail, outputBytes: total, outputShownBytes: out.length },
    };
  };

  const divider = (e: Extract<TimelineEntry, { kind: "divider" }>): ReactNode => {
    switch (e.divider) {
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
    }
  };

  const run = (e: Extract<TimelineEntry, { kind: "run" }>): ReactNode => {
    const n = (v: number) => v.toLocaleString(locale);
    const parts = runParts(e, locale, (v) => t("run.tokens", { n: v }));
    const facts = e.tokens
      ? [
          t("run.tokenSplit", {
            input: n(e.tokens.input),
            output: n(e.tokens.output),
            cacheRead: n(e.tokens.cacheRead),
            cacheWrite: n(e.tokens.cacheWrite),
          }),
        ]
      : [];
    const links = c.links.trajectory
      ? [
          {
            label: t("run.trajectory"),
            href: `/trajectories/${encodeURIComponent(conversationId)}`,
          },
        ]
      : [];
    if (e.status === "ok") return <RunRow status="ok" parts={parts} facts={facts} links={links} />;
    if (e.status === "stopped") {
      return (
        <RunRow
          status="stopped"
          parts={parts}
          statusText={t("run.stopped", {
            who: who(e.byAccountId),
            time: shortTime(e.at, locale, timeZone),
          })}
          facts={facts}
          links={links}
        />
      );
    }
    const summary =
      e.hook !== null
        ? e.hook.plugin !== null
          ? te("run.hook_denied", { plugin: e.hook.plugin })
          : te("run.hook_denied_unknown")
        : errorMessage(new ApiClientError(0, e.code, e.code));
    const detail = e.hook?.reason ?? e.message;
    const canRetry =
      !e.retried && e.retry !== null && e.hook === null && e.key === lastFailed && onRetry;
    const fix =
      c.links.configureModels && isModelSetupError(e.code)
        ? [{ label: t("run.configureModels"), href: "/admin/extensions" }]
        : [];
    return (
      <RunRow
        status="failed"
        parts={parts}
        {...(e.retried ? { statusText: t("run.failedRetried"), defaultOpen: false } : {})}
        error={{ summary, ...(detail !== "" ? { detail } : {}) }}
        facts={facts}
        {...(canRetry ? { onRetry: () => onRetry(e) } : {})}
        links={[...fix, ...links]}
      />
    );
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
        const details =
          e.instructions !== undefined || e.waitsFor !== undefined || e.pending ? (
            <>
              {e.instructions !== undefined ? (
                <Disclosure summary={t("skillInstructions")}>
                  <Text variant="small" tone="muted" pre>
                    {e.instructions}
                  </Text>
                </Disclosure>
              ) : null}
              {e.waitsFor !== undefined ? (
                <Text variant="small" tone="faint">
                  {t("skillWaits", { skill: e.waitsFor })}
                </Text>
              ) : null}
              {e.pending && e.waitsFor === undefined ? (
                <Text variant="small" tone="faint">
                  {t("interjectionPending")}
                </Text>
              ) : null}
            </>
          ) : undefined;
        return (
          <UserBubble
            text={e.text}
            {...(e.pending ? { queued: true } : {})}
            {...(e.sender ? { sender: e.sender.name ?? t("parentAgent") } : {})}
            {...(e.skill ? { skill: e.skill.label } : {})}
            {...(details !== undefined ? { details } : {})}
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
          <div data-cap-part="message.assistant" aria-busy={e.streaming ? "true" : undefined}>
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
          </div>
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
            // without a way to open an agent (no agent map here) the blocks have no action
            rows={e.rows.map((r) => (onOpenAgent ? r.row : { ...r.row, openable: false }))}
            onOpen={(id) => {
              // A call refused before any dispatch keeps its call key as id: no agent to open.
              if (!isCallKey(id)) onOpenAgent?.(id);
            }}
            {...(onOpenAgentMap ? { onOpenMap: onOpenAgentMap } : {})}
          />
        );
      case "subagent-wait": {
        // an agent below the conversation's children opens in the map, never the right panel: its
        // transcript, whose thread holds the card to decide, answer or connect
        const open = e.deep
          ? onOpenAgent && ((id: string) => onOpenAgent(id, true))
          : onOpenSubagent;
        return (
          <SubagentWait orgId={orgId} wait={e} info={info} {...(open ? { onOpen: open } : {})} />
        );
      }
      case "task":
        return renderTask?.(e) ?? null;
      case "delivery":
        return <DeliveryRow e={e} onOpen={onOpenAgent} />;
      case "skill-report":
        return (
          <Disclosure summary={t("skillReport")}>
            <Prose markdown={e.text} streaming={false} />
          </Disclosure>
        );
      case "approval":
        return <ApprovalCard orgId={orgId} item={e.item} info={info.get(e.item.toolKey)} />;
      case "question":
        return <QuestionCard orgId={orgId} item={e.item} />;
      case "connect":
        return <ConnectCard orgId={orgId} item={e.item} />;
      case "card":
        return renderCard?.(e) ?? null;
      case "network-facts":
        return <NetworkFacts orgId={orgId} conversationId={conversationId} hosts={e.hosts} />;
      case "files":
        return files(e.files);
      case "divider":
        return divider(e);
      case "background":
        return (
          <RunDivider
            kind="notice"
            text={
              e.exitCode === null
                ? tb("noticeNoCode", {
                    description: e.description,
                    status: tb(`status.${e.status}`),
                  })
                : tb("notice", {
                    description: e.description,
                    status: tb(`status.${e.status}`),
                    code: e.exitCode,
                  })
            }
            {...(onOpenTask
              ? { action: { label: tb("open"), onClick: () => onOpenTask(e.taskId) } }
              : {})}
          />
        );
      case "run":
        return run(e);
    }
  };

  return entry(e);
}

/**
 * A sub-agent's delivery in its parent (agent map spec §4.5): one notice line ("Scan docs handed
 * back a report"); its text (the report, the note, a finish's reply or error) opens under it, and
 * a delivery without text opens the agent in the map.
 */
function DeliveryRow({
  e,
  onOpen,
}: {
  e: Extract<TimelineEntry, { kind: "delivery" }>;
  onOpen: ((id: string) => void) | undefined;
}): ReactNode {
  const t = useTranslations("chat.delivery");
  const [open, setOpen] = useState(false);
  const text = t(e.delivery === "finished" ? (e.status ?? "completed") : e.delivery, {
    name: e.name,
  });
  if (e.text === "") {
    return (
      <RunDivider
        kind="notice"
        text={text}
        {...(onOpen ? { action: { onClick: () => onOpen(e.subagentId) } } : {})}
      />
    );
  }
  return (
    <RunDivider
      kind="notice"
      text={text}
      action={{
        label: t(open ? "hide" : "show"),
        expanded: open,
        onClick: () => setOpen((o) => !o),
      }}
    >
      {open ? <Prose markdown={e.text} streaming={false} /> : undefined}
    </RunDivider>
  );
}
