"use client";

import {
  type BubbleAttachment,
  BubbleAttachments,
  Disclosure,
  FileOutputs,
  formatBytes,
  type IconName,
  ImageOutput,
  ImagePlaceholder,
  ImageViewer,
  MAX_PROCESS_CHIPS,
  type PendingAction,
  PendingActions,
  ProcessBlock,
  type ProcessBlockProps,
  Prose,
  RailStep,
  type RailStepProps,
  RailText,
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
  useNow,
  useTimeZone,
  useToast,
  waitingText,
} from "@capybara-hq/design";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiClientError, ensureSession } from "../../lib/api";
import { artifactDownloadUrl } from "../../lib/artifacts";
import { attachmentDownloadUrl } from "../../lib/attachments";
import { orgIconUrl } from "../../lib/catalog";
import type { ModelRef, ToolInfo } from "../../lib/conversations";
import { type ModelConfigViewer, modelConfigViewer } from "../../lib/model-config";
import { withNode } from "../../lib/node-slot";
import { PeopleContext, type PeopleMap, usePersonLookup } from "../../lib/people";
import type { PendingEntry, ProcessEntry, ProcessStep, ThreadEntry } from "../../lib/process";
import { toolOutputSizeQuery } from "../../lib/query/conversation";
import { uiViewQuery } from "../../lib/query/ui";
import { canViewTrajectory, configureModelsHref, runParts } from "../../lib/run-row";
import type { CompactionProgress } from "../../lib/stream";
import { shortTime } from "../../lib/time";
import {
  type FailedRun,
  isCallKey,
  type TimelineEntry,
  type TimelineSubagent,
  type TimelineTool,
} from "../../lib/timeline";
import { uiLocale } from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import { ApprovalCard } from "../ApprovalCard";
import { ConnectCard, useConnectConnector } from "../ConnectCard";
import { DeviceCodeCard } from "../DeviceCodeCard";
import { useSlotContributions } from "../extension-ui/ExtensionSlot";
import { InitialPasswordReveal } from "../InitialPasswordReveal";
import { InvitationLinkReveal } from "../InvitationLinkReveal";
import { Person } from "../Person";
import { QuestionCard, type QuestionPanel } from "../QuestionCard";
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

/** The people map of a thread given none (a record without a log read). */
const NO_PEOPLE: PeopleMap = {};

const modelName = (m: ModelRef | null) => (m === null ? "—" : m.model);

export type ThreadProps = {
  orgId: string;
  conversationId: string;
  /** The timeline after `groupProcess` (lib/process.ts): a run's process is one `process` entry. */
  entries: ThreadEntry[];
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
  /**
   * Ids of the files the right panel can open (every listed file's id and version ids): a sent
   * attachment opens there once listed, and downloads until then.
   */
  listedFiles?: ReadonlySet<string>;
  /** Paths (and names) of the conversation's files: prose chips for them. */
  filePaths?: ReadonlyMap<string, string>;
  /** Renders an inline card (Task 20's extension slot); rendered after the thread items. */
  renderCard?(e: Extract<TimelineEntry, { kind: "card" }>): ReactNode;
  /** The panel a question names (`InputRequired.open`) as its card's action. */
  questionPanel?: QuestionPanel;
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
  /**
   * The accounts the log names, by id (the events response's `people`): who stopped a run, decided
   * or answered a card, wrote a message. The cards inside the thread read it from its context.
   */
  people?: PeopleMap;
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
    | "questionPanel"
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
  /** The person's choices per process block (by its key): open or closed, steps drawn. */
  blockUi: ReadonlyMap<string, BlockUi>;
  setBlockUi(key: string, f: (u: BlockUi) => BlockUi): void;
  retried: ReadonlySet<string>;
  onImageError(id: string): void;
  lastFailed: string | null;
  paths: ReadonlySet<string>;
  filePaths: ReadonlyMap<string, string> | undefined;
  selectedFile: string | undefined;
  removedFiles: ReadonlySet<string> | undefined;
  listedFiles: ReadonlySet<string> | undefined;
  openSubagent: string | undefined;
  /** The accounts the log names (who stopped a run, who wrote a message). */
  people: PeopleMap;
  /** The run rows' links this reader may follow. */
  /** `configureModels`: who reads, for the model-setup fix of a failed run (null: no run links). */
  links: { trajectory: boolean; configureModels: ModelConfigViewer | null };
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
  listedFiles,
  filePaths,
  renderCard,
  questionPanel,
  openSubagent,
  onOpenSubagent,
  onOpenAgent,
  onOpenAgentMap,
  onOpenTask,
  live = true,
  renderTask,
  runLinks,
  compaction,
  people = NO_PEOPLE,
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
  const [blockUi, setBlockUiMap] = useState<ReadonlyMap<string, BlockUi>>(new Map());
  const setBlockUi = useCallback(
    (key: string, f: (u: BlockUi) => BlockUi) =>
      setBlockUiMap((m) => new Map(m).set(key, f(m.get(key) ?? {}))),
    [],
  );
  const archived = useMemo(
    () =>
      entries.flatMap((e) =>
        e.kind === "process"
          ? e.steps.flatMap((s) =>
              s.kind === "tools" ? s.rows.flatMap((r) => (r.outputId ? [r.outputId] : [])) : [],
            )
          : [],
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
    questionPanel,
    renderTask,
  };
  const trajectory =
    runLinks !== undefined &&
    runLinks.trajectory !== false &&
    canViewTrajectory(me, runLinks.agentOwnerId);
  const { superAdmin, orgAdmin } = modelConfigViewer(me);
  const hasRunLinks = runLinks !== undefined;
  const configureModels = useMemo(
    () => (hasRunLinks ? { superAdmin, orgAdmin } : null),
    [hasRunLinks, superAdmin, orgAdmin],
  );
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
      blockUi,
      setBlockUi,
      retried,
      onImageError,
      lastFailed,
      paths,
      filePaths,
      selectedFile,
      removedFiles,
      listedFiles,
      openSubagent,
      people,
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
      blockUi,
      setBlockUi,
      retried,
      onImageError,
      lastFailed,
      paths,
      filePaths,
      selectedFile,
      removedFiles,
      listedFiles,
      openSubagent,
      people,
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
    <PeopleContext.Provider value={people}>
      <div role="log" aria-live={live ? "polite" : "off"} aria-label={t("timeline")}>
        <Stack gap={12}>
          {entries.map((e) => (
            <EntryView key={e.key} e={e} c={ctx} />
          ))}
          {compaction ? <CompactingRow progress={compaction} /> : null}
        </Stack>
      </div>
    </PeopleContext.Provider>
  );
}

/**
 * One entry and its `data-entry` wrapper. Re-renders only when its entry object or the shared
 * context changes; inline cards and task lines render from the page's state, so they always do. A
 * process block is rebuilt by every pass of `groupProcess`: it re-renders when what it draws
 * changed ({@link sameBlock}), so a delta frame re-renders only the block that streams.
 */
const EntryView = memo(
  function EntryView({ e, c }: { e: ThreadEntry; c: EntryContext }) {
    const node = <EntryNode e={e} c={c} />;
    const rows =
      e.kind === "process" ? e.steps.flatMap((s) => (s.kind === "tools" ? s.rows : [])) : [];
    return (
      <div
        data-entry={e.kind}
        {...(e.kind === "divider" ? { "data-divider": e.divider } : {})}
        {...(e.kind === "run" ? { "data-run-status": e.status } : {})}
        {...(e.kind === "prose" && e.streaming
          ? // busy until it settles: the live thread announces the reply once, not per token
            { "data-streaming": "true", "aria-busy": true }
          : {})}
        {...(e.kind === "process"
          ? {
              "data-state": e.state,
              // the rail is not announced; the block's head is its own live region (spec §7)
              "aria-live": "off" as const,
              "data-tool-keys": rows.map((r) => r.toolKey).join(" "),
              "data-tool-status": rows.map((r) => r.row.status).join(" "),
              // per call, in log order, for tests and e2e: the block may be closed
              "data-tool-calls": rows.map((r) => `${r.toolKey}:${r.row.status}`).join(" "),
            }
          : {})}
      >
        {node}
      </div>
    );
  },
  (a, b) =>
    a.c === b.c &&
    (a.e === b.e || sameBlock(a.e, b.e)) &&
    a.e.kind !== "card" &&
    a.e.kind !== "task" &&
    // the pinned cards and process cards inside a block render from the page's state too
    !(a.e.kind === "process" && hasCards(a.e)),
);

/**
 * Two passes' blocks (or pending lists) that draw the same: the same steps and pinned cards. The
 * timeline's entries are reused between passes; the steps `groupProcess` wraps are compared by
 * what they hold.
 */
function sameBlock(a: ThreadEntry, b: ThreadEntry): boolean {
  if (a.kind === "pending" && b.kind === "pending")
    return (
      a.key === b.key &&
      a.items.length === b.items.length &&
      a.items.every((x, i) => x === b.items[i])
    );
  if (a.kind !== "process" || b.kind !== "process") return false;
  return (
    a.key === b.key &&
    a.state === b.state &&
    a.runId === b.runId &&
    a.durationMs === b.durationMs &&
    a.backgroundRunning === b.backgroundRunning &&
    a.steps.length === b.steps.length &&
    a.steps.every((x, i) => sameStep(x, b.steps[i])) &&
    a.pinned.length === b.pinned.length &&
    a.pinned.every((x, i) => x === b.pinned[i])
  );
}

function sameStep(x: ProcessStep, y: ProcessStep | undefined): boolean {
  if (x === y) return true;
  if (y === undefined || x.kind !== y.kind || x.key !== y.key) return false;
  switch (x.kind) {
    case "narration":
      return y.kind === "narration" && x.text === y.text && x.streaming === y.streaming;
    case "subagent":
      return y.kind === "subagent" && x.row === y.row;
    case "decided":
      return y.kind === "decided" && x.entry === y.entry;
    case "note":
      // a note's divider is copied from the same timeline entry: its key says which
      return true;
    default:
      return false;
  }
}

const hasCards = (b: ProcessEntry) => b.pinned.length > 0 || b.steps.some((s) => s.kind === "card");

function EntryNode({ e, c }: { e: ThreadEntry; c: EntryContext }): ReactNode {
  const t = useTranslations("chat");
  const tb = useTranslations("background");
  const te = useTranslations("errors");
  const tp = useTranslations("people");
  const locale = useLocale();
  const timeZone = useTimeZone();
  const { me } = useSession();
  const errorMessage = useErrorMessage();
  const openDownload = useOpenDownload();
  const {
    orgId,
    conversationId,
    info,
    retried,
    onImageError,
    lastFailed,
    paths,
    filePaths,
    selectedFile,
    removedFiles,
    listedFiles,
  } = c;
  /** The image this entry's viewer shows (§5.6): a thumbnail click sets it, closing clears it. */
  const [zoomId, setZoomId] = useState<string | null>(null);
  // Callbacks go through the ref at call time: a memoized entry never calls a stale one.
  const cb = c.cb;
  const onRetry = c.has.retry ? (d: FailedRun) => cb.current.onRetry?.(d) : undefined;
  const onOpenFile = c.has.openFile ? (id: string) => cb.current.onOpenFile?.(id) : undefined;
  const onMoreFiles = c.has.moreFiles ? () => cb.current.onMoreFiles?.() : undefined;
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
  const { renderCard, renderTask, questionPanel } = cb.current;

  const person = usePersonLookup(c.people);
  // who stopped a run: the system, or a person with their avatar (the viewer reads "You")
  const whoStopped = (id: string | null): ReactNode =>
    id === null ? t("system") : <Person person={person(id)} size={16} viewerId={me.account.id} />;

  const imageSrc = (id: string) => imageSrcOf(c, id);

  const run = (e: Extract<TimelineEntry, { kind: "run" }>): ReactNode => {
    const n = (v: number) => v.toLocaleString(locale);
    const parts = runParts(e, locale, (v) => t("run.tokens", { n: v }));
    // a manual compaction's row says so instead of naming an ordinary step run
    const label = e.compact === true ? t("compactionRun") : undefined;
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
    if (e.status === "ok")
      return (
        <RunRow
          status="ok"
          {...(label !== undefined ? { label } : {})}
          parts={parts}
          facts={facts}
          links={links}
        />
      );
    if (e.status === "stopped") {
      return (
        <RunRow
          status="stopped"
          {...(label !== undefined ? { label } : {})}
          parts={parts}
          statusText={withNode(
            (who) => t("run.stopped", { who, time: shortTime(e.at, locale, timeZone) }),
            whoStopped(e.byAccountId),
          )}
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
    const fixHref =
      c.links.configureModels !== null
        ? configureModelsHref(c.links.configureModels, e.code)
        : null;
    const fix = fixHref !== null ? [{ label: t("run.configureModels"), href: fixHref }] : [];
    return (
      <RunRow
        status="failed"
        {...(label !== undefined ? { label } : {})}
        parts={parts}
        {...(e.retried ? { statusText: t("run.failedRetried"), defaultOpen: false } : {})}
        error={{ summary, ...(detail !== "" ? { detail } : {}) }}
        facts={facts}
        {...(canRetry ? { onRetry: () => onRetry(e) } : {})}
        links={[...fix, ...links]}
      />
    );
  };

  const files = (e: Extract<TimelineEntry, { kind: "files" }>): ReactNode => {
    const rest = e.others;
    const open = (id: string) => onOpenFile?.(id);
    return (
      <Stack gap={8}>
        {e.images.map((slot) =>
          slot.kind === "image" ? (
            <ImageOutput
              key={slot.file.id}
              src={artifactDownloadUrl(orgId, conversationId, slot.file.id, { inline: true })}
              name={slot.file.name}
              size={slot.file.size}
              {...(slot.ratio !== null ? { ratio: slot.ratio } : {})}
              onOpen={() => open(slot.file.id)}
              onDownload={() =>
                openDownload(artifactDownloadUrl(orgId, conversationId, slot.file.id))
              }
            />
          ) : (
            <ImagePlaceholder
              key={slot.key}
              ratio={slot.ratio}
              index={slot.index}
              count={slot.count}
            />
          ),
        )}
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

  const entry = (e: ThreadEntry): ReactNode => {
    switch (e.kind) {
      case "user": {
        const srcOf = imageSrc;
        const atts: BubbleAttachment[] = [
          ...e.files.map(
            (f): BubbleAttachment => ({
              id: f.attachmentId,
              kind: f.kind === "image" ? "image" : "file",
              name: f.name,
              type: typeBadge(f.name, f.mediaType),
              ...(f.size !== undefined ? { size: formatBytes(f.size) } : {}),
              ...(f.kind === "image" ? { src: srcOf(f.attachmentId) } : {}),
            }),
          ),
          ...e.attachments.map(
            (a): BubbleAttachment => ({
              id: `@${a.appId}:${a.uri}`,
              kind: "file",
              name: `@${a.name} · ${a.appName}`,
              downloadable: false,
            }),
          ),
        ];
        // The message's images, all navigable in the viewer; the one it shows is `zoomId`.
        const pictures = e.files.filter((f) => f.kind === "image");
        const zoomIndex = pictures.findIndex((f) => f.attachmentId === zoomId);
        const shown = pictures[zoomIndex];
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
        // The circle names who wrote it: the viewer's own messages need none; an author who left
        // gets the departed avatar (the initial of "Former member").
        const writer =
          e.authorAccountId === undefined || e.authorAccountId === me.account.id
            ? undefined
            : person(e.authorAccountId);
        const author =
          writer === undefined
            ? undefined
            : { name: writer?.name ?? tp("departed"), avatarUrl: writer?.avatarUrl ?? null };
        return (
          <>
            <UserBubble
              text={e.text}
              {...(author !== undefined ? { author } : {})}
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
                          const file = e.files.find((f) => f.attachmentId === id);
                          // An image zooms in the page; another upload opens in the right panel
                          // once the files list has it (downloads otherwise: before the list is
                          // read again, past its cap, or with no panel); a resource mention does
                          // nothing.
                          if (file?.kind === "image") setZoomId(id);
                          else if (!id.startsWith("@")) {
                            if (onOpenFile && listedFiles?.has(id)) onOpenFile(id);
                            else openDownload(attachmentDownloadUrl(orgId, id));
                          }
                        }}
                        onDownload={(id) => {
                          if (!id.startsWith("@")) openDownload(attachmentDownloadUrl(orgId, id));
                        }}
                      />
                    ),
                  }
                : {})}
            />
            {pictures.length > 0 ? (
              <ImageViewer
                open={zoomIndex >= 0}
                onOpenChange={(open) => {
                  if (!open) setZoomId(null);
                }}
                images={pictures.map((f) => ({
                  src: srcOf(f.attachmentId),
                  name: f.name,
                  ...(f.size !== undefined ? { size: formatBytes(f.size) } : {}),
                }))}
                index={Math.max(zoomIndex, 0)}
                onIndexChange={(i) => {
                  const next = pictures[i];
                  if (next) setZoomId(next.attachmentId);
                }}
                onDownload={(i) => {
                  const p = pictures[i];
                  if (p) openDownload(attachmentDownloadUrl(orgId, p.attachmentId));
                }}
                // The kernel serves an attachment's image inline at its download URL.
                onOpenInNewTab={(i) => {
                  const p = pictures[i];
                  if (p) openDownload(attachmentDownloadUrl(orgId, p.attachmentId));
                }}
                // One retry per image (a session refresh, then its retry token): none left, no button
                {...(shown !== undefined && !retried.has(shown.attachmentId)
                  ? { onRetry: () => onImageError(shown.attachmentId) }
                  : {})}
              />
            ) : null}
          </>
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
        return e.skills === undefined ? (
          (renderTask?.(e) ?? null)
        ) : (
          <>
            {renderTask?.(e) ?? null}
            {e.skills.map((s) => (
              <Disclosure key={s.label} summary={t("templateSkill", { skill: s.label })}>
                <Text variant="small" tone="muted" pre>
                  {s.instructions}
                </Text>
              </Disclosure>
            ))}
          </>
        );
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
        return (
          <QuestionCard
            orgId={orgId}
            item={e.item}
            {...(questionPanel !== undefined ? { panel: questionPanel } : {})}
          />
        );
      case "connect":
        return <ConnectCard orgId={orgId} item={e.item} />;
      case "card":
        return renderCard?.(e) ?? null;
      case "device-code":
        return <DeviceCodeCard url={e.url} code={e.code} />;
      case "files":
        return files(e);
      case "divider":
        return <DividerView e={e} c={c} />;
      case "process":
        return <ProcessView b={e} c={c} />;
      case "pending":
        return <PendingView e={e} c={c} />;
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

/** A fallback or compaction divider (a thread entry, or a note step in a process block's rail). */
function DividerView({
  e,
  c,
}: {
  e: Extract<TimelineEntry, { kind: "divider" }>;
  c: EntryContext;
}): ReactNode {
  const t = useTranslations("chat");
  switch (e.divider) {
    case "compacted": {
      const open = c.openSummaries.has(e.key);
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
            onClick: () => c.toggleSummary(e.key),
          }}
        >
          {open ? e.summary : undefined}
        </RunDivider>
      );
    }
    case "compact-failed":
      // The raw reason (the kernel's English) stays the panel's detail, as a run row's does.
      return (
        <RunDivider kind="failed" text={t("divider.compactFailed")}>
          {e.reason}
        </RunDivider>
      );
    case "fallback":
      return (
        <RunDivider
          kind="fallback"
          text={t("divider.fallback", { from: modelName(e.from), to: modelName(e.to) })}
        />
      );
  }
}

/** An attachment's image as the thread loads it (a retry after a failed load asks again). */
const imageSrcOf = (c: EntryContext, id: string) =>
  `${attachmentDownloadUrl(c.orgId, id)}${c.retried.has(id) ? "?retry=1" : ""}`;

/** A tool row as the thread draws it: its line range or background label, images, output size. */
function rowOf(
  r: TimelineTool,
  c: EntryContext,
  t: ReturnType<typeof useTranslations<"chat">>,
  tb: ReturnType<typeof useTranslations<"background">>,
): ToolRowData {
  const cb = c.cb;
  const taskId = r.background?.taskId;
  const base = r.lines
    ? { ...r.row, extra: t("toolLines", r.lines) }
    : r.background
      ? {
          ...r.row,
          extra: tb("inBackground"),
          ...(taskId && c.has.openTask
            ? {
                link: {
                  label: tb("openTask", { name: r.row.description ?? taskId }),
                  onOpen: () => cb.current.onOpenTask?.(taskId),
                },
              }
            : {}),
        }
      : r.row;
  // the images the call's result carried (shown to the agent): thumbnails on the row
  const withImages: ToolRowData =
    r.images !== undefined && r.images.length > 0
      ? {
          ...base,
          detail: {
            ...base.detail,
            images: r.images.map((m) => ({
              id: m.attachmentId,
              name: m.name,
              src: imageSrcOf(c, m.attachmentId),
            })),
          },
        }
      : base;
  const total = r.outputId ? c.sizes.get(r.outputId) : undefined;
  const out = withImages.detail?.output;
  if (total === undefined || out === undefined) return withImages;
  return {
    ...withImages,
    detail: { ...withImages.detail, outputBytes: total, outputShownBytes: out.length },
  };
}

/**
 * One model step's tool calls (a rail step's row, spec §1.2–§1.3): one call as a single tool
 * line, a parallel burst as a tool group; their result images are navigable in one viewer.
 */
function ToolStep({ tools, c }: { tools: TimelineTool[]; c: EntryContext }): ReactNode {
  const t = useTranslations("chat");
  const tb = useTranslations("background");
  const toast = useToast();
  const openDownload = useOpenDownload();
  const [zoomId, setZoomId] = useState<string | null>(null);
  const cb = c.cb;
  const byRow = (rowId: string) => tools.find((x) => x.row.id === rowId);
  const pictures = tools.flatMap((r) => r.images ?? []);
  const zoomIndex = pictures.findIndex((m) => m.attachmentId === zoomId);
  const shown = pictures[zoomIndex];
  return (
    <div
      // the step's calls for tests and e2e (the block's own attributes list all of its calls)
      data-tool-step-keys={tools.map((r) => r.toolKey).join(" ")}
      data-tool-step-status={tools.map((r) => r.row.status).join(" ")}
    >
      <ToolGroup
        rows={tools.map((r) => rowOf(r, c, t, tb))}
        onViewAll={(rowId) => {
          const r = byRow(rowId);
          if (r) cb.current.onOpenOutput?.(r.callId);
        }}
        onCopy={(rowId) => {
          const text = byRow(rowId)?.row.detail?.output;
          if (text === undefined) return;
          navigator.clipboard?.writeText(text).then(
            () => toast.success(t("copied")),
            () => {},
          );
        }}
        onOpenImage={(rowId, i) => {
          const m = byRow(rowId)?.images?.[i];
          if (m) setZoomId(m.attachmentId);
        }}
        onImageError={c.onImageError}
      />
      {pictures.length > 0 ? (
        <ImageViewer
          open={zoomIndex >= 0}
          onOpenChange={(open) => {
            if (!open) setZoomId(null);
          }}
          images={pictures.map((m) => ({
            src: imageSrcOf(c, m.attachmentId),
            name: m.name,
            size: formatBytes(m.size),
          }))}
          index={Math.max(zoomIndex, 0)}
          onIndexChange={(i) => {
            const next = pictures[i];
            if (next) setZoomId(next.attachmentId);
          }}
          onDownload={(i) => {
            const p = pictures[i];
            if (p) openDownload(attachmentDownloadUrl(c.orgId, p.attachmentId));
          }}
          onOpenInNewTab={(i) => {
            const p = pictures[i];
            if (p) openDownload(attachmentDownloadUrl(c.orgId, p.attachmentId));
          }}
          {...(shown !== undefined && !c.retried.has(shown.attachmentId)
            ? { onRetry: () => c.onImageError(shown.attachmentId) }
            : {})}
        />
      ) : null}
    </div>
  );
}

// ── Process blocks (conversation process blocks spec §1.3, §4, §7) ──────────

/** The person's choices for one process block. */
type BlockUi = {
  /** Their open toggle, kept while the block's state is the one it was made in. */
  open?: { value: boolean; state: ProcessEntry["state"] };
  /** How many of the rail's last steps are drawn (more after "N earlier steps"). */
  shown?: number;
};

/** Steps a running, waiting, stopped or failed block draws before its fold row (spec §1.3). */
const LIVE_STEPS = 4;
/** The rail draws at most this many steps at a time; the fold row adds as many again. */
const RAIL_PAGE = 200;
/** How often at most the running head announces a new step (spec §7, accessibility). */
const ANNOUNCE_MS = 3000;
/** While the current call still streams its input, its label (path, description) follows sooner. */
const STREAM_ANNOUNCE_MS = 300;

type Extra = Extract<ProcessStep, { kind: "network-facts" | "card" }>;

/** One rail row: a step, with the process cards and network facts of its calls under it. */
type RailItem =
  | { kind: "thinking"; key: string; e: Extract<ProcessStep, { kind: "thinking" }> }
  | { kind: "narration"; key: string; text: string }
  | { kind: "tool"; key: string; tools: TimelineTool[]; extras: Extra[] }
  | { kind: "subagent"; key: string; row: TimelineSubagent }
  | { kind: "note"; key: string; step: Extract<ProcessStep, { kind: "note" }> }
  | { kind: "decided"; key: string; e: Extract<ProcessStep, { kind: "decided" }>["entry"] }
  | { kind: "extra"; key: string; extra: Extra };

/**
 * A block's steps as rail rows: one per model step's tool calls (a `tools` entry runs on across
 * steps, so it is split where the step changes; the row's key is its first call's); a process
 * card or a network fact goes under the step of the call that made it; thinking the model does
 * not show is left out.
 */
function railItems(b: ProcessEntry, reasoningOf: (m: ModelRef) => boolean | undefined) {
  const items: RailItem[] = [];
  const byCall = new Map<string, Extract<RailItem, { kind: "tool" }>>();
  for (const s of b.steps) {
    switch (s.kind) {
      case "thinking":
        if (s.model === null || reasoningOf(s.model) !== false)
          items.push({ kind: "thinking", key: s.key, e: s });
        break;
      case "narration":
        items.push({ kind: "narration", key: s.key, text: s.text });
        break;
      case "tools": {
        let item: Extract<RailItem, { kind: "tool" }> | null = null;
        let at: string | null = null;
        for (const r of s.rows) {
          const step = r.step === undefined ? `call:${r.callId}` : `${r.step.runId}:${r.step.step}`;
          if (item === null || step !== at) {
            item = { kind: "tool", key: `${s.key}:${r.callId}`, tools: [], extras: [] };
            at = step;
            items.push(item);
          }
          item.tools.push(r);
          byCall.set(r.callId, item);
        }
        break;
      }
      case "network-facts":
      case "card": {
        const at = byCall.get(s.callId);
        if (at !== undefined) at.extras.push(s);
        else items.push({ kind: "extra", key: s.key, extra: s });
        break;
      }
      case "subagent":
        items.push({ kind: "subagent", key: s.key, row: s.row });
        break;
      case "note":
        items.push({ kind: "note", key: s.key, step: s });
        break;
      case "decided":
        items.push({ kind: "decided", key: s.key, e: s.entry });
        break;
    }
  }
  return { items, byCall };
}

/** The kind icon of a tool row whose info is not read yet (the tools read is on its way). */
const ROW_KIND_ICON: Record<ToolRowData["kind"], IconName> = {
  command: "terminal",
  read: "file-text",
  edit: "square-pen",
  search: "search",
  connector: "connector",
  meta: "extension",
  task: "agent",
  tool: "extension",
  question: "extension",
};

type Kind = ProcessBlockProps["kinds"][number];

/** A tool's mark (`ToolInfo.icon`, spec §2): a named icon, or its catalog item's icon. */
function toolKind(
  info: ToolInfo | undefined,
  rowKind: ToolRowData["kind"],
  orgId: string,
  label: (name: IconName) => string,
  locale: "zh" | "en",
): Kind {
  const icon = info?.icon;
  if (icon?.kind === "catalog") {
    const src = info?.source;
    return {
      key: `catalog:${icon.itemId}`,
      icon: { src: orgIconUrl(orgId, icon.itemId) },
      label:
        src?.kind === "extension"
          ? src.displayName[locale]
          : src?.kind === "connector"
            ? src.name
            : (info?.title ?? info?.key ?? icon.itemId),
    };
  }
  const name: IconName = icon?.kind === "name" ? icon.name : ROW_KIND_ICON[rowKind];
  return { key: name, icon: { name }, label: label(name) };
}

/** A live call: running, pending, or still streaming its input (its gutter shows the spinner). */
const isLiveRow = (r: ToolRowData) =>
  r.status === "running" || r.status === "pending" || r.status === "streaming";

/**
 * A value that follows `value` at most every `ms`: the first change shows at once, later ones
 * wait out the interval since the last shown change. The running head's step label, so the live
 * region does not chatter (spec §7).
 */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  // 0: no change shown yet, so the first one is not held back
  const last = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const show = () => {
      last.current = Date.now();
      setShown(value);
    };
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      show();
      return;
    }
    const id = setTimeout(show, wait);
    return () => clearTimeout(id);
  }, [value, shown, ms]);
  return shown;
}

/**
 * The head's pinned summary (spec §1.3: "Todos 4/4"): the first pinned card's title (its
 * contribution's) and badge, from its view in the query cache. Read only when the card has been
 * drawn: a finished run read after a reload says nothing rather than reading every old card.
 */
function usePinnedSummary(
  orgId: string,
  conversationId: string,
  card: Extract<TimelineEntry, { kind: "card" }> | undefined,
): { title: string; badge?: string } | undefined {
  const locale = uiLocale(useLocale());
  const { items } = useSlotContributions(
    orgId,
    "conversation.tool-result.card",
    card !== undefined,
  );
  const q = uiViewQuery(
    orgId,
    {
      plugin: card?.plugin ?? "",
      id: card?.view ?? "",
      card: {
        callId: card?.callId ?? "",
        ...(card?.cardKey !== undefined ? { key: card.cardKey } : {}),
      },
    },
    { conversationId, locale },
  );
  const view = useQuery({ ...q, enabled: false }).data;
  if (card === undefined) return undefined;
  const c = items.find((x) => x.plugin === card.plugin && x.id === card.view);
  if (c === undefined || view === undefined) return undefined;
  return { title: c.title[locale], ...(view.badge !== undefined ? { badge: view.badge } : {}) };
}

/**
 * A run's process as one block (spec §1.3): open while running or waiting (only its last four
 * steps, the earlier ones behind the fold row), closed once finished, open on its last steps when
 * stopped or failed; a person's toggle holds until the block's state changes. The pinned cards sit
 * under the head while the run goes; finished, the first one's title and badge join the summary.
 */
function ProcessView({ b, c }: { b: ProcessEntry; c: EntryContext }): ReactNode {
  const t = useTranslations("chat");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const live = b.state === "running" || b.state === "waiting";
  const now = useNow(live ? 1000 : 0);
  const ui = c.blockUi.get(b.key);
  const open =
    ui?.open !== undefined && ui.open.state === b.state ? ui.open.value : b.state !== "finished";
  const cb = c.cb;
  const { renderCard } = cb.current;

  const { items, byCall } = useMemo(() => railItems(b, c.reasoningOf), [b, c.reasoningOf]);
  const kindLabel = (name: IconName) =>
    (
      ({
        terminal: t("process.kind.terminal"),
        "file-text": t("process.kind.file-text"),
        "square-pen": t("process.kind.square-pen"),
        search: t("process.kind.search"),
        globe: t("process.kind.globe"),
        skills: t("process.kind.skills"),
        agent: t("process.kind.agent"),
        "list-checks": t("process.kind.list-checks"),
        connector: t("process.kind.connector"),
      }) as Partial<Record<IconName, string>>
    )[name] ?? t("process.kind.extension");
  const kindOf = (r: TimelineTool) =>
    toolKind(c.info.get(r.toolKey), r.row.kind, c.orgId, kindLabel, locale);

  // the head: kinds in first-use order, counts, the latest step's label
  const kinds: Kind[] = [];
  const seen = new Set<string>();
  const addKind = (k: Kind) => {
    if (seen.has(k.key)) return;
    seen.add(k.key);
    kinds.push(k);
  };
  let thoughts = 0;
  let tools = 0;
  let errors = 0;
  let current: string | null = null;
  let currentStreaming = false;
  let waitingWords: string | null = null;
  let startedAt: number | null = null;
  const started = (ms: number | undefined) => {
    if (ms !== undefined && (startedAt === null || ms < startedAt)) startedAt = ms;
  };
  for (const it of items) {
    if (it.kind === "thinking") {
      thoughts++;
      addKind({ key: "thinking", icon: { name: "lightbulb" }, label: t("process.kind.thinking") });
      current = t("process.thinking");
      currentStreaming = false;
    } else if (it.kind === "tool") {
      for (const tool of it.tools) {
        const r = tool.row;
        tools++;
        if (r.status === "failed") errors++;
        addKind(kindOf(tool));
        // the label the row itself draws: a description replaces the command only for a command
        const arg = r.kind === "command" ? (r.description ?? r.keyArg) : r.keyArg;
        current = [r.name, arg?.split("\n")[0]].filter(Boolean).join(" ");
        currentStreaming = r.status === "streaming";
        started(r.startedAt);
        if (isLiveRow(r) && r.waiting !== undefined)
          waitingWords ??= waitingText(r.waiting, r.waitingFor, locale);
      }
    } else if (it.kind === "subagent") {
      const r = it.row.row;
      tools++;
      if (r.status === "failed") errors++;
      addKind({ key: "agent", icon: { name: "agent" }, label: t("process.kind.agent") });
      current = `${t("process.subagent")} ${r.description}`;
      currentStreaming = false;
      started(r.startedAt);
      if (r.status === "waiting")
        waitingWords ??= waitingText(r.waiting ?? "approval", undefined, locale);
    }
  }
  const label = useThrottled(current, currentStreaming ? STREAM_ANNOUNCE_MS : ANNOUNCE_MS);
  const pinnedSummary = usePinnedSummary(c.orgId, c.conversationId, b.pinned[0]);

  // what the rail draws: the last steps, more behind the fold row
  const base = b.state === "finished" ? RAIL_PAGE : LIVE_STEPS;
  const shown = ui?.shown ?? base;
  const from = Math.max(0, items.length - shown);

  const stepIcon = (it: RailItem): RailStepProps["icon"] => {
    switch (it.kind) {
      case "thinking":
        return live && it.e.live ? "spinner" : { name: "lightbulb" };
      case "narration":
        return "dot";
      case "tool": {
        const rows = it.tools.map((x) => x.row);
        if (live && rows.some((r) => isLiveRow(r) && r.waiting === undefined)) return "spinner";
        if (live && rows.some((r) => isLiveRow(r) && r.waiting !== undefined)) return "hand";
        return it.tools[0] !== undefined ? kindOf(it.tools[0]).icon : { name: "extension" };
      }
      case "subagent": {
        const s = it.row.row.status;
        if (live && s === "waiting") return "hand";
        if (live && (s === "running" || s === "queued")) return "spinner";
        return { name: "agent" };
      }
      case "note":
        return { name: it.step.note === "compacted" ? "archive" : "refresh" };
      case "decided": {
        const call = byCall.get(it.e.item.callId)?.tools.find((x) => x.callId === it.e.item.callId);
        return call !== undefined ? kindOf(call).icon : { name: "check" };
      }
      case "extra":
        return { name: it.extra.kind === "card" ? "extension" : "globe" };
    }
  };

  const extra = (x: Extra): ReactNode =>
    x.kind === "card" ? (
      (renderCard?.(x) ?? null)
    ) : (
      <NetworkFacts orgId={c.orgId} conversationId={c.conversationId} hosts={x.hosts} />
    );

  const stepBody = (it: RailItem): ReactNode => {
    switch (it.kind) {
      case "thinking":
        return <ThinkingRow seconds={it.e.seconds} text={it.e.text} live={it.e.live} inRail />;
      case "narration":
        return <RailText>{it.text}</RailText>;
      case "tool":
        return (
          <>
            <ToolStep tools={it.tools} c={c} />
            {it.extras.map((x) => (
              <Fragment key={x.key}>{extra(x)}</Fragment>
            ))}
          </>
        );
      case "subagent":
        return <SubagentStep row={it.row} c={c} />;
      case "note":
        return <DividerView e={{ kind: "divider", key: it.key, ...it.step.divider }} c={c} />;
      case "decided":
        return <DecidedStep e={it.e} c={c} />;
      case "extra":
        return extra(it.extra);
    }
  };

  const toggle = () =>
    c.setBlockUi(b.key, (u) => ({ ...u, open: { value: !open, state: b.state } }));
  const pinned =
    live && b.pinned.length > 0 ? (
      <Stack gap={8}>
        {b.pinned.map((p) => (
          <Fragment key={p.key}>{renderCard?.(p) ?? null}</Fragment>
        ))}
      </Stack>
    ) : undefined;

  return (
    <ProcessBlock
      state={b.state}
      {...(label !== null ? { current: label } : {})}
      {...(b.state === "waiting" ? { waiting: waitingWords ?? t("process.waiting") } : {})}
      elapsedMs={live ? (startedAt === null ? null : Math.max(0, now - startedAt)) : b.durationMs}
      summary={{
        thoughts,
        tools,
        errors,
        ...(pinnedSummary !== undefined ? { pinned: pinnedSummary } : {}),
      }}
      kinds={kinds.slice(0, MAX_PROCESS_CHIPS)}
      open={open}
      onToggle={toggle}
      hiddenBefore={from}
      onShowEarlier={() =>
        c.setBlockUi(b.key, (u) => ({ ...u, shown: (u.shown ?? base) + RAIL_PAGE }))
      }
      {...(pinned !== undefined ? { pinned } : {})}
      backgroundRunning={b.backgroundRunning}
    >
      {/* the steps are the rail's direct children: its rule's ends come from their positions */}
      {items.slice(from).map((it) => (
        <RailStep key={it.key} icon={stepIcon(it)}>
          {stepBody(it)}
        </RailStep>
      ))}
    </ProcessBlock>
  );
}

/**
 * A single synchronous sub-agent in the rail (spec §10.3): one tool line, "Sub-agent · <task> ·
 * N tools", whose link opens it in the agent panel.
 */
function SubagentStep({ row, c }: { row: TimelineSubagent; c: EntryContext }): ReactNode {
  const t = useTranslations("chat");
  const r = row.row;
  const cb = c.cb;
  // A call refused before any dispatch keeps its call key as id: no agent to open.
  const openable = r.openable !== false && !isCallKey(r.id);
  const onOpen = !openable
    ? undefined
    : c.has.openSubagent
      ? () => cb.current.onOpenSubagent?.(r.id)
      : c.has.openAgent
        ? () => cb.current.onOpenAgent?.(r.id)
        : undefined;
  const status: ToolRowData["status"] =
    r.status === "running" || r.status === "waiting"
      ? "running"
      : r.status === "queued"
        ? "pending"
        : r.status === "failed"
          ? "failed"
          : r.status === "aborted"
            ? "cancelled"
            : "done";
  const line: ToolRowData = {
    id: r.id,
    kind: "task",
    name: t("process.subagent"),
    keyArg: r.description,
    extra: t("process.subagentTools", { n: r.toolCalls }),
    status,
    ...(r.status === "waiting" && r.waiting !== undefined ? { waiting: r.waiting } : {}),
    ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
    ...(r.startedAt !== undefined && r.finishedAt !== undefined
      ? { durationMs: r.finishedAt - r.startedAt }
      : {}),
    ...(onOpen !== undefined ? { link: { label: t("process.openSubagent"), onOpen } } : {}),
  };
  return <ToolGroup rows={[line]} />;
}

/** A decided approval, question or connect in the rail: the card's one-line decided form. */
function DecidedStep({
  e,
  c,
}: {
  e: Extract<ProcessStep, { kind: "decided" }>["entry"];
  c: EntryContext;
}): ReactNode {
  const questionPanel = c.cb.current.questionPanel;
  switch (e.kind) {
    case "approval":
      return <ApprovalCard orgId={c.orgId} item={e.item} info={c.info.get(e.item.toolKey)} />;
    case "question":
      return (
        <QuestionCard
          orgId={c.orgId}
          item={e.item}
          {...(questionPanel !== undefined ? { panel: questionPanel } : {})}
        />
      );
    case "connect":
      return <ConnectCard orgId={c.orgId} item={e.item} />;
  }
}

/**
 * A turn's handoffs and reveals (spec §4, must see, non-blocking): the handoffs as one list (a
 * link opens its page; a connector's connection starts here, as its connect card does), then what
 * a call shows the run's person once.
 */
function PendingView({ e, c }: { e: PendingEntry; c: EntryContext }): ReactNode {
  const t = useTranslations("chat.handoff");
  const { connect, busy } = useConnectConnector(c.orgId);
  const actions: PendingAction[] = [];
  const reveals: Extract<TimelineEntry, { kind: "reveal" }>[] = [];
  for (const it of e.items) {
    if (it.kind === "reveal") {
      reveals.push(it);
      continue;
    }
    const target = it.target;
    actions.push(
      target.type === "link"
        ? {
            key: it.key,
            icon: { name: "external-link" },
            title: it.title,
            description: t("linkBody"),
            action: { label: t("open"), href: target.url },
          }
        : {
            key: it.key,
            icon: { name: "connector" },
            title: it.title,
            description: t("connectBody"),
            action: {
              label: t("connect"),
              onClick: () => void connect(target.connectorId),
              busy: busy === target.connectorId,
            },
          },
    );
  }
  return (
    <Stack gap={8}>
      <PendingActions items={actions} />
      {reveals.map((r) => (
        <RevealEntry key={r.key} orgId={c.orgId} conversationId={c.conversationId} entry={r} />
      ))}
    </Stack>
  );
}

/**
 * What a call's result shows its run's person once (the initial password, the invitation link),
 * read by call. Anyone else sees nothing: the kernel refuses them anyway.
 */
export function RevealEntry({
  orgId,
  conversationId,
  entry,
}: {
  orgId: string;
  conversationId: string;
  entry: Extract<TimelineEntry, { kind: "reveal" }>;
}): ReactNode {
  const { me } = useSession();
  if (entry.starterAccountId !== me.account.id) return null;
  const call = { conversationId, runId: entry.runId, callId: entry.callId };
  return entry.reveal === "initial_password" ? (
    <InitialPasswordReveal orgId={orgId} call={call} />
  ) : (
    <InvitationLinkReveal orgId={orgId} call={call} />
  );
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
