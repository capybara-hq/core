import {
  DEFAULT_SANDBOX_ROOTS,
  DeviceProtocolError,
  isFileSystemGoneError,
  isSandboxGoneError,
  type Logger,
  type SandboxHandle,
  type SandboxRoots,
  ToolError,
  validateSandboxPath,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import type { BackgroundTaskFinisher } from "../../../background/finish.js";
import type { BackgroundTaskStopper } from "../../../background/stop.js";
import type { BackgroundTaskStore } from "../../../background/store.js";
import type { KernelConfig } from "../../../config/schema.js";
import type { AttachmentsService } from "../../../conversations/attachments.service.js";
import type { EventLog } from "../../../conversations/event-log.js";
import {
  ANONYMOUS_NO_ENVIRONMENT,
  type ConversationEnvironments,
} from "../../../environments/conversation-environments.js";
import { ApiError } from "../../../errors.js";
import type { KernelConfigService } from "../../../infra/config/kernel-config.service.js";
import { environmentPathsChange } from "../../../runtime/context/environment-paths.js";
import { SandboxPathBusyError } from "../../../sandbox/leases.js";
import {
  type HeldProvider,
  SandboxLockLostError,
  type SandboxService,
} from "../../../sandbox/sandbox.service.js";
import { SandboxProviderUnreachableError } from "../../../sandbox/unreachable.js";
import type { StorageService } from "../../../storage/storage.service.js";
import type { BuiltinCallContext, ToolListingScope } from "../../registry.js";

/** 沙箱工具的依赖（都按调用时取，多副本下无进程内状态）。 */
export interface SandboxToolDeps {
  /**
   * `pathLease` may be absent (test stubs): the kernel's own file writes then take no path lease.
   * `currentInstance` too: a background `Bash` launch records the instance it started in; and
   * `ifRunning`, which `TaskOutput` reads a task through.
   */
  sandbox: Pick<SandboxService, "cloudAvailable" | "availableFor" | "withSandbox"> &
    Partial<Pick<SandboxService, "pathLease" | "currentInstance" | "ifRunning">>;
  /**
   * The environment a call enters: the root conversation's, checked for its owner every call.
   * `usableNow` (absent in test stubs: only the cloud provider counts) tells a listing whether a
   * conversation's environment can run without a cloud provider (ruling R8).
   */
  environments: Pick<ConversationEnvironments, "forTool"> &
    Partial<Pick<ConversationEnvironments, "usableNow">>;
  /** Background `Bash` tasks; absent in test stubs, where `run_in_background` is refused. */
  background?: Pick<
    BackgroundTaskStore,
    | "reserve"
    | "markStarted"
    | "failLaunch"
    | "finishStoppedLaunch"
    | "releaseStop"
    | "get"
    | "advanceOffset"
  >;
  /**
   * What `TaskOutput` and `TaskStop` finish and stop tasks with; absent in test stubs, where both
   * answer that background tasks are not available.
   */
  tasks?: {
    finisher: Pick<BackgroundTaskFinisher, "finish">;
    stopper: Pick<BackgroundTaskStopper, "stop">;
  };
  attachments: Pick<AttachmentsService, "listForConversation" | "openForConversation">;
  storage: Pick<StorageService, "kernel" | "deployment" | "available">;
  /**
   * `publishChanged`: `Deliver` announces `changed: files` (UI refresh B). `latestOfType` reads the
   * conversation's latest `environment_paths` (absent in test stubs, which record none).
   */
  eventLog: Pick<EventLog, "append" | "latestFileState"> &
    Partial<Pick<EventLog, "publishChanged" | "latestOfType">>;
  config: Pick<KernelConfigService, "get">;
  /** Where a mapped provider failure keeps its raw error (warn); absent in test stubs. */
  log?: Pick<Logger, "warn">;
}

/**
 * The sandbox a callback gets: the instance handle, the provider (every `exec` carries the
 * holder's tag and the call's actor) and the call's signal combined with the lease's (pass it to
 * every provider call).
 */
export interface SandboxSession {
  /** The environment the call runs in (path leases are taken on it). */
  environmentId: string;
  h: SandboxHandle;
  /** The instance's roots: every path the call builds or checks is under one of them. */
  roots: SandboxRoots;
  p: HeldProvider;
  signal: AbortSignal;
}

// ---- 模型可见文案（英文） ----

/** This conversation's first use of its environment (in the instance's workspace). */
export const sandboxStartedNotice = (roots: SandboxRoots): string =>
  `Environment started (first use in this conversation); the working directory is ${roots.workspace}, shared with the environment's other conversations.`;
/** {@link sandboxStartedNotice} of an instance with the default roots. */
export const SANDBOX_STARTED_NOTICE = sandboxStartedNotice(DEFAULT_SANDBOX_ROOTS);
/** A new instance came up on the environment's kept files. */
export const SANDBOX_RESTARTED_NOTICE =
  "The environment's instance was restarted; files are kept, running processes are gone and temporary files may be gone.";
/**
 * The environment's files were reset (on request, or after they were lost) since this conversation
 * last used it.
 */
export const sandboxFilesResetNotice = (roots: SandboxRoots): string =>
  `The environment's files were reset; earlier files in ${roots.workspace} and running processes are gone and temporary files may be gone, so recreate anything you still need.`;
/** {@link sandboxFilesResetNotice} of an instance with the default roots. */
export const SANDBOX_FILES_RESET_NOTICE = sandboxFilesResetNotice(DEFAULT_SANDBOX_ROOTS);

const BUSY_TEXT =
  "The environment is busy: all its command slots are taken by commands of this or another conversation sharing it; wait for one to finish and retry.";
const NO_SANDBOX_TEXT =
  "No sandbox is configured in this deployment; ask an administrator to install a sandbox plugin, or do the task without the sandbox.";
/** 没有沙箱提供方时「工具不可用」的原因（进提醒，内核在后面补句号）：与调用时的错误同一句话。 */
export const SANDBOX_UNAVAILABLE_REASON = NO_SANDBOX_TEXT.slice(0, -1);

/** The error of a sandbox call in a deployment without a sandbox provider. */
export function noSandboxError(): ToolError {
  return new ToolError(NO_SANDBOX_TEXT);
}

const PATH_BUSY_TEXT =
  "Another sub-agent or another conversation in this environment is writing this file; wait a moment and retry.";
const ANONYMOUS_TEXT =
  "The sandbox is not available to anonymous IM senders; do the task without the sandbox, or ask the person to link their account and start a new conversation.";
const ENV_NOT_FOUND_TEXT =
  "This conversation's environment was deleted or its owner can no longer use it; ask the user to start a new conversation in another environment.";
const ENV_FORBIDDEN_TEXT =
  "This conversation's owner may no longer use its environment; ask the user to start a new conversation in an environment they can use.";
const ENV_UNAVAILABLE_TEXT =
  "This conversation's environment is kept by a sandbox provider that is not active in this deployment; ask the user to start a new conversation in another environment, or an administrator to re-enable that provider.";
const ENV_FILES_LOST_TEXT =
  "This environment's files are gone. Ask the user to reset its files on the environments page, then retry.";
/**
 * A provider call that never connected (refused, unknown host, unreachable network): the request
 * did not reach the provider, so the call did nothing in the sandbox.
 */
export const SANDBOX_UNREACHABLE_TEXT =
  "The sandbox provider can't be reached (the connection failed), so this call did nothing in the sandbox; retrying won't help until a super admin checks the sandbox extension's configuration (Admin console → Extensions). Continue without the sandbox, or ask the person to have a super admin check it.";
/** A provider connection that broke during the call: the provider may have acted before it broke. */
export const SANDBOX_CONNECTION_DROPPED_TEXT =
  "The connection to the sandbox provider broke during this call, so it may or may not have taken effect; check the sandbox state before retrying. If it fails again, continue without the sandbox and ask the person to have a super admin check the sandbox extension's configuration (Admin console → Extensions).";
const DEVICE_FILES_LOST_TEXT =
  "This environment's directory is gone from its connected machine. Ask the person to run capybara-device logout, then capybara-device login into this environment, on that machine, then retry.";
const FILES_GONE_TEXT =
  "This environment's files are gone. Ask the user to reset its files on the environments page (for a connected machine: to run capybara-device logout, then capybara-device login, on it), then retry.";
const DEVICE_OFFLINE_TEXT =
  "The connected machine is offline. Ask the person to start capybara-device on it.";
const DEVICE_OUTDATED_TEXT =
  "The connected machine runs an outdated capybara-device. Ask the person to update it on that machine and start it again.";
const DEVICE_REVOKED_TEXT =
  "The connected machine of this environment was disconnected. Ask the person to run capybara-device logout, then capybara-device login on it, or to start a new conversation in another environment.";
const deviceProtocolText = (detail: string): string =>
  `The connected machine sent an answer the platform cannot read (${detail}). Ask the person to update capybara-device on that machine, then retry.`;
const LOCK_LOST_TEXT =
  "The sandbox operation was interrupted because the sandbox lock was lost; check the sandbox state and retry.";

/** The directory of attachments in the environment (each conversation has a subdirectory). */
export const attachmentsRoot = (roots: SandboxRoots): string => `${roots.workspace}/attachments`;
/** {@link attachmentsRoot} of an instance with the default roots. */
export const ATTACHMENTS_ROOT = attachmentsRoot(DEFAULT_SANDBOX_ROOTS);
/**
 * One conversation's attachment directory: the first 12 hex digits of the root conversation's
 * UUID, so conversations sharing an environment do not overwrite each other's files.
 */
export const attachmentsDir = (roots: SandboxRoots, rootConversationId: string): string =>
  `${attachmentsRoot(roots)}/${rootConversationId.replaceAll("-", "").slice(0, 12)}`;
/** The conversation's marker of synced attachments: `{ <attachment id>: <file name> }`. */
export const syncMarkerPath = (roots: SandboxRoots, rootConversationId: string): string =>
  `${attachmentsDir(roots, rootConversationId)}/.capybara-sync.json`;
const SYNC_MARKER_NAME = ".capybara-sync.json";
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Whether a path, or a Grep output line starting with one, belongs to a sync marker of the
 * instance with `roots` (hidden from Glob / Grep). Build it once per call and test every entry.
 */
export function syncMarkerMatcher(
  roots: SandboxRoots = DEFAULT_SANDBOX_ROOTS,
): (pathOrLine: string) => boolean {
  const re = new RegExp(
    `^${escapeRe(attachmentsRoot(roots))}/[^/]+/${escapeRe(SYNC_MARKER_NAME)}(?=$|[:-])`,
  );
  return (pathOrLine) => re.test(pathOrLine);
}
const MARKER_MAX_BYTES = 1024 * 1024;
/** 附件文件名的上限（UTF-8 字节，常见文件系统单个文件名上限 255 字节，留出 `-N` 后缀的余量）。 */
export const ATTACHMENT_NAME_MAX_BYTES = 200;

/**
 * Extra margin (ms) on top of a sandbox tool's time limit: creating / resuming the sandbox, and the
 * fallback for stopping a command after its timeout (when the E2B kill script does not finish, the
 * sandbox is restarted: up to about 20 s to kill, plus pause and a cold connect of up to 120 s, about
 * 160 s). Pulling the image on first creation is not included (deployments pre-pull
 * `sandbox.image`; see the sandbox-docker plugin's README in capybara-hq/plugins).
 */
export const SANDBOX_SETUP_MARGIN_MS = 180_000;

/**
 * 沙箱工具的基本执行时限：`tools.timeoutMs` + 等锁（`sandbox.lockWaitSeconds`）+ {@link SANDBOX_SETUP_MARGIN_MS}。
 */
export const sandboxBaseTimeoutMs = (cfg: KernelConfig): number =>
  cfg.tools.timeoutMs + cfg.sandbox.lockWaitSeconds * 1000 + SANDBOX_SETUP_MARGIN_MS;

/**
 * 运行截止前给沙箱命令留的余量（毫秒）：命令超时后停命令、写工具结果的时间（Ruling M20）。
 */
export const RUN_DEADLINE_MARGIN_MS = 30_000;

/**
 * 运行还允许沙箱命令跑多久（毫秒）：截止时间减去 {@link RUN_DEADLINE_MARGIN_MS}；没有截止时间为 Infinity。
 * 可能为负（快到截止了），调用方自己取下限。
 */
export function runTimeLeftMs(runDeadline: number | undefined, now = Date.now()): number {
  return runDeadline === undefined ? Infinity : runDeadline - RUN_DEADLINE_MARGIN_MS - now;
}

/**
 * glob / grep 的命令超时：不超过 `tools.timeoutMs`，且放得进本次调用剩下的时间（基本时限从 `startedAt` 起算，
 * 扣掉 {@link SANDBOX_SETUP_MARGIN_MS}，留给超时后停命令的兜底）与运行剩下的时间（{@link runTimeLeftMs}）——
 * 等锁或恢复沙箱用掉的时间从这里扣，命令自己先超时、给模型可执行的说明，而不是被管线的时限或运行截止打断。
 * 至少 1 秒。
 */
export function searchTimeoutMs(
  cfg: KernelConfig,
  startedAt: number,
  now = Date.now(),
  runDeadline?: number,
): number {
  const left = startedAt + sandboxBaseTimeoutMs(cfg) - SANDBOX_SETUP_MARGIN_MS - now;
  return Math.max(1000, Math.min(cfg.tools.timeoutMs, left, runTimeLeftMs(runDeadline, now)));
}

/** 运行时限收紧了命令超时时给模型的说明（英文）。 */
export const runBudgetNote = (seconds: number): string =>
  `This run's time budget limits commands to ${seconds} seconds (configurable via runtime.maxRunSeconds).`;

/** 显示摘要（中英文，各截到 200 码点以内；只给界面看）。 */
export function display(zh: string, en: string): { summary: { zh: string; en: string } } {
  return { summary: { zh: clip(zh, 200), en: clip(en, 200) } };
}

/** 折叠空白并按码点截断（显示摘要与错误里引用用户 / 模型给的文本）。 */
export function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const cps = [...flat];
  return cps.length <= max ? flat : `${cps.slice(0, max - 1).join("")}…`;
}

/** 结果正文前加上沙箱状态说明。 */
export function withNotices(notices: readonly string[], text: string): string {
  return [...notices, text].join("\n\n");
}

/**
 * The root-independent checks of a path (`validateSandboxPathShape`: non-empty, absolute, no
 * control characters, no empty or `..` segments), run before the call enters its environment, so
 * a malformed path never creates or resumes an instance; root membership is checked inside
 * ({@link checkPath}).
 */
export function checkPathShape(path: string, field = "path"): void {
  const errors = validateSandboxPathShape(path);
  if (errors.length > 0) {
    throw new ToolError(
      `Invalid ${field} "${clip(path, 200)}": ${errors.join("; ")}. Pass an absolute path under the workspace, skills or temporary files directory.`,
    );
  }
}

/**
 * Checks a path inside the instance with `roots` (`validateSandboxPath`: absolute, under one of its
 * roots); an invalid one throws an error the model can act on, naming the instance's roots.
 */
export function checkPath(path: string, roots: SandboxRoots, field = "path"): string {
  const errors = validateSandboxPath(path, roots);
  if (errors.length > 0) {
    throw new ToolError(
      `Invalid ${field} "${clip(path, 200)}": ${errors.join("; ")}. Pass an absolute path under ${roots.workspace}, ${roots.skills} or ${roots.tmp}.`,
    );
  }
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** A writing tool's `file_path`: the skills root is the read-only copy of the skill files. */
export function checkWritable(path: string, roots: SandboxRoots): string {
  const p = checkPath(path, roots, "file_path");
  if (p === roots.skills || p.startsWith(`${roots.skills}/`)) {
    throw new ToolError(
      `Path ${clip(p, 200)} is read-only (${roots.skills} holds skill files); pass a path under ${roots.workspace} or ${roots.tmp} instead.`,
    );
  }
  return p;
}

/** POSIX shell 单引号转义。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const utf8 = new TextEncoder();

const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

/** 拆成主名与扩展名（扩展名不超过 20 字节，`.` 开头的隐藏文件没有扩展名）。 */
function splitExt(n: string): [string, string] {
  const dot = n.lastIndexOf(".");
  return dot > 0 && byteLength(n.slice(dot)) <= 20 ? [n.slice(0, dot), n.slice(dot)] : [n, ""];
}

/** `stem + suffix + ext` 不超过 {@link ATTACHMENT_NAME_MAX_BYTES} 字节：按码点截短主名，保留后缀与扩展名。 */
function fitName(stem: string, suffix: string, ext: string): string {
  const room = ATTACHMENT_NAME_MAX_BYTES - byteLength(suffix + ext);
  let out = "";
  let used = 0;
  for (const cp of stem) {
    const b = byteLength(cp);
    if (used + b > room) break;
    out += cp;
    used += b;
  }
  return out + suffix + ext;
}

/** 把一个文件名清理成单个安全的路径段（控制字符、`/`、`\` 换成 `_`），过长时保留扩展名按字节截断。 */
function sanitizeName(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要换掉控制字符
  const n = raw.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim();
  if (n === "" || n === "." || n === "..") return "attachment";
  if (byteLength(n) <= ATTACHMENT_NAME_MAX_BYTES) return n;
  const [stem, ext] = splitExt(n);
  return fitName(stem, "", ext);
}

/**
 * 给附件分配沙箱里的文件名（按给定顺序，确定性）：清理成安全的路径段（≤ {@link ATTACHMENT_NAME_MAX_BYTES}
 * 字节），与 `used`（已同步的）及彼此不重名，重名时加 `-2`、`-3`……（加在扩展名之前）。
 * 清理后仍不是合法沙箱路径的用 `attachment-<id 前 8 位>`。
 */
export function assignAttachmentNames(
  items: readonly { id: string; name: string }[],
  used: ReadonlySet<string>,
): Map<string, string> {
  const taken = new Set(used);
  taken.add(SYNC_MARKER_NAME);
  const out = new Map<string, string>();
  for (const a of items) {
    let base = sanitizeName(a.name);
    if (validateSandboxPath(`${ATTACHMENTS_ROOT}/${base}`).length > 0) {
      base = `attachment-${a.id.slice(0, 8)}`;
    }
    let name = base;
    if (taken.has(name)) {
      const [stem, ext] = splitExt(base);
      for (let i = 2; taken.has(name); i++) name = fitName(stem, `-${i}`, ext);
    }
    taken.add(name);
    out.set(a.id, name);
  }
  return out;
}

/** 解析标记文件；坏的按空处理（重新同步，同名文件被覆盖）。 */
function parseMarker(data: Uint8Array): Record<string, string> {
  try {
    const v = JSON.parse(new TextDecoder().decode(data)) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** 一个附件复制失败时给模型的原因（不带内部细节）。 */
function copyFailureReason(e: unknown): string {
  if (e instanceof ApiError && e.code === "storage.unavailable") {
    return "file storage is unavailable";
  }
  return "a temporary error occurred; it will be retried on the next sandbox call";
}

/**
 * 把本对话已 ready 的附件复制到 `<workspace>/attachments/<conversation>/<name>`（{@link attachmentsDir}），
 * 标记文件记下已复制的（不重复复制）。对象已不在的附件跳过（下次再试）。
 * 每复制一个就更新标记文件：中途超时 / 中止，下次从停下的地方继续。
 * 单个附件失败（存储故障等）只跳过它并给出说明，不让工具调用失败；signal 已中止或实例已不在时照常抛出。
 * 返回本次复制的沙箱路径与失败说明。
 */
async function syncAttachments(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  s: SandboxSession,
): Promise<{ copied: string[]; failures: string[] }> {
  const none = { copied: [], failures: [] };
  const conv = sandboxConversationOf(ctx);
  const list = await deps.attachments.listForConversation(ctx.orgId, conv);
  if (list.length === 0) return none;
  // nothing to copy (the usual case): no path lease, so calls do not queue on the marker
  const marker = await readSyncMarker(s, conv);
  if (list.every((a) => Object.hasOwn(marker, a.id))) return none;
  // the sync marker is read, changed and written: one holder at a time
  return withPathLease(deps, s, syncMarkerPath(s.roots, conv), s.signal, (signal) =>
    copyAttachments(deps, ctx, { ...s, signal }, conv, list),
  );
}

/** The sync marker's entries (`{}` when it is missing, too large or unreadable). */
async function readSyncMarker(s: SandboxSession, conv: string): Promise<Record<string, string>> {
  const m = await s.p.readFile(s.h, syncMarkerPath(s.roots, conv), {
    maxBytes: MARKER_MAX_BYTES,
    signal: s.signal,
  });
  return m && !m.truncated ? parseMarker(m.data) : {};
}

async function copyAttachments(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  s: SandboxSession,
  conv: string,
  list: Awaited<ReturnType<SandboxToolDeps["attachments"]["listForConversation"]>>,
): Promise<{ copied: string[]; failures: string[] }> {
  const none = { copied: [], failures: [] };
  let marker: Record<string, string> = await readSyncMarker(s, conv);
  const pending = list.filter((a) => !Object.hasOwn(marker, a.id));
  if (pending.length === 0) return none;
  const names = assignAttachmentNames(pending, new Set(Object.values(marker)));
  const copied: string[] = [];
  const failures: string[] = [];
  for (const a of pending) {
    const name = names.get(a.id) as string;
    const path = `${attachmentsDir(s.roots, conv)}/${name}`;
    try {
      const opened = await deps.attachments.openForConversation(ctx.orgId, conv, a.id);
      if (!opened) continue;
      const bytes = new Uint8Array(await new Response(opened.body).arrayBuffer());
      await s.p.writeFile(s.h, path, bytes, s.signal);
    } catch (e) {
      // 中止（超时 / 锁丢失 / 运行停止）与实例已不在（withSandbox 据此重建）不吞
      if (s.signal.aborted || isSandboxGoneError(e)) throw e;
      failures.push(`Attachment ${name} could not be copied: ${copyFailureReason(e)}.`);
      continue;
    }
    // 文件已复制：本次算复制成功。标记写成功后才记进内存里的标记（之后的写入不带上未落盘的项）；
    // 标记写失败只意味着下次会重新复制这个文件
    copied.push(path);
    const next = { ...marker, [a.id]: name };
    try {
      await s.p.writeFile(
        s.h,
        syncMarkerPath(s.roots, conv),
        utf8.encode(JSON.stringify(next)),
        s.signal,
      );
      marker = next;
    } catch (e) {
      if (s.signal.aborted || isSandboxGoneError(e)) throw e;
    }
  }
  return { copied, failures };
}

/**
 * Sandbox service errors → actionable text for the model; anything else is returned unchanged
 * (the pipeline reports a generic tool failure). A provider that cannot be reached becomes a
 * fixed text (providers never write model-visible text) with `kind: "unavailable"`, and its raw
 * error is logged to `log` as a warning (the pipeline logs only errors it did not get as a
 * `ToolError`).
 */
export function mapSandboxError(e: unknown, log: Pick<Logger, "warn"> | undefined): unknown {
  if (e instanceof SandboxProviderUnreachableError) {
    log?.warn("sandbox provider unreachable", { failure: e.failure, err: e.cause });
    if (e.failure === "connect") {
      return new ToolError(SANDBOX_UNREACHABLE_TEXT, { kind: "unavailable" });
    }
    return new ToolError(SANDBOX_CONNECTION_DROPPED_TEXT, { kind: "unavailable" });
  }
  if (e instanceof ApiError) {
    if (e.code === "sandbox.busy") return new ToolError(BUSY_TEXT);
    if (e.code === "sandbox.unavailable") {
      const reason = (e.details?.[0] as { reason?: unknown } | undefined)?.reason;
      if (reason === ANONYMOUS_NO_ENVIRONMENT) return new ToolError(ANONYMOUS_TEXT);
      return new ToolError(NO_SANDBOX_TEXT);
    }
    const detail = e.details?.[0] as { reason?: unknown; source?: unknown } | undefined;
    if (e.code === "environment.not_found") return new ToolError(ENV_NOT_FOUND_TEXT);
    if (e.code === "environment.forbidden" && detail?.reason === "machine_revoked") {
      return new ToolError(DEVICE_REVOKED_TEXT);
    }
    if (e.code === "environment.forbidden") return new ToolError(ENV_FORBIDDEN_TEXT);
    if (e.code === "environment.unavailable") return new ToolError(ENV_UNAVAILABLE_TEXT);
    if (e.code === "environment.files_lost" && detail?.source === "device") {
      return new ToolError(DEVICE_FILES_LOST_TEXT);
    }
    if (e.code === "environment.files_lost") return new ToolError(ENV_FILES_LOST_TEXT);
    if (e.code === "environment.offline") return new ToolError(DEVICE_OFFLINE_TEXT);
    if (e.code === "environment.program_outdated") return new ToolError(DEVICE_OUTDATED_TEXT);
  }
  // an operation outside withSandbox's own mapping (it records lost files itself)
  if (isFileSystemGoneError(e)) return new ToolError(FILES_GONE_TEXT);
  if (e instanceof DeviceProtocolError) return new ToolError(deviceProtocolText(e.message));
  if (e instanceof SandboxLockLostError) return new ToolError(LOCK_LOST_TEXT);
  if (e instanceof SandboxPathBusyError) return new ToolError(PATH_BUSY_TEXT);
  return e;
}

/**
 * Runs `fn` in the environment of the call's conversation (a sub-agent: its root's): resolves and
 * checks the environment for the conversation's owner (binding an unbound conversation to the
 * owner's default first), then `SandboxService.withSandbox` (the instance created, resumed or
 * rebuilt on the kept files as needed, every `exec` carrying the call's actor). Attachments are
 * synced first. Returns the value and the notices to put before the result (first use, a new
 * instance, newly copied attachments). When `withSandbox` rebuilds a gone instance and calls
 * `fn` again, the notices are the last call's. The instance's roots are recorded for the model
 * on the conversation's first call and whenever they change ({@link recordEnvironmentPaths}).
 */
export async function inSandbox<T>(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  fn: (s: SandboxSession) => Promise<T>,
): Promise<{ value: T; notices: string[] }> {
  try {
    const environmentId = await deps.environments.forTool(ctx.orgId, sandboxConversationOf(ctx));
    return await deps.sandbox.withSandbox(
      {
        orgId: ctx.orgId,
        environmentId,
        // a sub-agent is told when another holder rebuilt the shared instance (final review m5)
        holderConversationId: ctx.conversationId,
        actor: { accountId: ctx.accountId, conversationId: ctx.conversationId },
      },
      async (h, p, info, signal) => {
        const s: SandboxSession = { environmentId, h, roots: info.roots, p, signal };
        await recordEnvironmentPaths(deps, ctx, info.roots);
        const notices: string[] = [];
        if (info.filesReset) notices.push(sandboxFilesResetNotice(info.roots));
        else if (info.restarted) notices.push(SANDBOX_RESTARTED_NOTICE);
        else if (info.fresh) notices.push(sandboxStartedNotice(info.roots));
        const { copied, failures } = await syncAttachments(deps, ctx, s);
        if (copied.length > 0) {
          notices.push(`Attachments copied into the sandbox: ${copied.join(", ")}.`);
        }
        notices.push(...failures);
        return { value: await fn(s), notices };
      },
      ctx.signal,
    );
  } catch (e) {
    throw mapSandboxError(e, deps.log);
  }
}

/**
 * Environments spec §13.1, ruling R22: the calling conversation's log (the log its model reads; a
 * sub-agent's own too) gets an `environment_paths` event on its first sandbox call, the default
 * roots included, and again whenever the held instance's roots differ from the latest recorded
 * ones; always before the call's result. One indexed read per call (migration 0094); parallel
 * calls that saw the same latest event write one event (its idempotency key).
 */
async function recordEnvironmentPaths(
  deps: Pick<SandboxToolDeps, "eventLog">,
  ctx: BuiltinCallContext,
  roots: SandboxRoots,
): Promise<void> {
  if (!deps.eventLog.latestOfType) return;
  const latest = await deps.eventLog.latestOfType(ctx.conversationId, "environment_paths");
  const change = environmentPathsChange(latest, roots, ctx.runId);
  if (change) await deps.eventLog.append(ctx.conversationId, [change]);
}

/** The conversation whose environment a call uses (the root conversation's for a sub-agent). */
export const sandboxConversationOf = (ctx: BuiltinCallContext): string =>
  ctx.sandboxConversationId ?? ctx.conversationId;

/**
 * Runs `fn` under the per-path lease of `path` in the session's environment (spec §10.4: the
 * kernel's own read-modify-write of one file never loses another holder's update, from any
 * conversation sharing the environment). `fn` gets `signal` combined with the path lease's: pass
 * it to every provider call, so a lost path lease stops the write. Without `pathLease` (test
 * stubs) it just runs `fn` with `signal`.
 */
export async function withPathLease<T>(
  deps: Pick<SandboxToolDeps, "sandbox">,
  s: Pick<SandboxSession, "environmentId">,
  path: string,
  signal: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!deps.sandbox.pathLease) return fn(signal);
  const lease = await deps.sandbox.pathLease(s.environmentId, path, signal);
  try {
    return await fn(AbortSignal.any([signal, lease.signal]));
  } finally {
    await lease.release().catch(() => {});
  }
}

/**
 * Whether a sandbox tool call of the conversation tree rooted at `conversationId` can run: a
 * cloud provider is loaded, or (ruling R8) the conversation's environment runs on a registered
 * kernel provider (`@device`). Without a conversation only the cloud provider counts.
 */
export async function sandboxUsable(
  deps: Pick<SandboxToolDeps, "sandbox" | "environments">,
  orgId: string,
  conversationId: string | undefined,
): Promise<boolean> {
  if (deps.sandbox.cloudAvailable) return true;
  if (conversationId === undefined || !deps.environments.usableNow) return false;
  return deps.environments.usableNow(orgId, conversationId);
}

/**
 * The reason the registry reports the sandbox tools unavailable with, or null when they can run
 * ({@link sandboxUsable}; the listing passes the root conversation of the run). An eval replay
 * lists them as available (`replay`: its calls are never executed). `memo` (one per listing)
 * makes every sandbox tool of a listing share one answer.
 */
export const unavailableWhenNoSandbox =
  (deps: Pick<SandboxToolDeps, "sandbox" | "environments">) =>
  async (ctx: ToolListingScope): Promise<string | null> => {
    if (ctx.replay === true) return null;
    const key = "sandboxUsable";
    let usable = ctx.memo?.get(key) as Promise<boolean> | undefined;
    if (usable === undefined) {
      usable = sandboxUsable(deps, ctx.orgId, ctx.conversationId);
      ctx.memo?.set(key, usable);
    }
    return (await usable) ? null : SANDBOX_UNAVAILABLE_REASON;
  };

/** 读出的字节是否像二进制（开头 8 KB 里有 NUL）。 */
export function looksBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8192).includes(0);
}
