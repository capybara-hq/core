import {
  DEFAULT_SANDBOX_ROOTS,
  DeviceProtocolError,
  isFileSystemGoneError,
  isSandboxOperationOutcomeUnknownError,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  type Logger,
  type SandboxHandle,
  type SandboxPreparation,
  type SandboxPreparationScope,
  type SandboxRoots,
  SandboxScopeDeniedError,
  ToolError,
  validateSandboxPath,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import type { BackgroundTaskFinisher } from "../../../background/finish.js";
import type { BackgroundTaskStopper } from "../../../background/stop.js";
import type { BackgroundTaskStore } from "../../../background/store.js";
import type { KernelConfig } from "../../../config/schema.js";
import type { ChildAgent } from "../../../conversations/agent-tree.js";
import type { AttachmentsService } from "../../../conversations/attachments.service.js";
import type { EventLog } from "../../../conversations/event-log.js";
import {
  ANONYMOUS_NO_DEVICE,
  type ConversationDevices,
  type WorkingFacts,
} from "../../../devices/conversation-devices.js";
import { canonicalRoot, workingRootOf } from "../../../devices/working-root.js";
import { ApiError } from "../../../errors.js";
import type { KernelConfigService } from "../../../infra/config/kernel-config.service.js";
import { InstanceBindingError } from "../../../local-devices/instance-bindings.js";
import { AUTO_MODE_NOT_ALLOWED_TEXT } from "../../../local-devices/local-device-provider.js";
import { isDeviceRequestNotSent } from "../../../local-devices/relay.js";
import { type DeviceModeLevel, devicePathsChange } from "../../../runtime/context/device-paths.js";
import {
  ATTACHMENTS_ROOT,
  attachmentsDir,
  attachmentsRoot,
} from "../../../sandbox/attachments-path.js";
import { SandboxPathBusyError } from "../../../sandbox/leases.js";
import type { LegacyRetirementStore } from "../../../sandbox/legacy-retirement.js";
import {
  MANAGED_DEVICE_CONTEXT_FAILED_TEXT,
  MANAGED_DEVICE_CONTEXT_STALE_TEXT,
  MANAGED_DEVICE_CONTEXT_UNAVAILABLE_TEXT,
  ManagedDeviceContextFailed,
  type ManagedDeviceContextPort,
  ManagedDeviceContextStale,
  ManagedDeviceContextUnavailable,
} from "../../../sandbox/managed-device-context.js";
import type { SandboxMode } from "../../../sandbox/modes.js";
import type { HeldDeviceContextEvidence } from "../../../sandbox/permission-context-types.js";
import {
  type HeldProvider,
  SandboxLockLostError,
  type SandboxService,
} from "../../../sandbox/sandbox.service.js";
import {
  providerConnectionFailure,
  SandboxProviderUnreachableError,
} from "../../../sandbox/unreachable.js";
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
    Partial<Pick<SandboxService, "pathLease" | "currentInstance" | "ifRunning" | "withOperations">>;
  /**
   * The device a call enters: the root conversation's, checked for its owner every call.
   * `usableNow` (absent in test stubs: only the cloud provider counts) tells a listing whether a
   * conversation's device can run without a cloud provider (ruling R8). `workingFacts` (absent
   * in test stubs: free mode) gives what decides the working root, read as the review reads it.
   */
  devices: Pick<ConversationDevices, "forTool"> &
    Partial<Pick<ConversationDevices, "usableNow" | "modeLevel" | "workingFacts" | "projectReach">>;
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
    | "runningOwnedBy"
    | "finishedOwnedBy"
  > &
    Partial<Pick<BackgroundTaskStore, "reserveManaged" | "failManagedPreEffect">>;
  /**
   * The legacy-launch freeze check (permission runtime cutover 8.5) every legacy background launch
   * makes immediately before it dispatches; always wired in the kernel, absent in test stubs.
   */
  legacyLaunch?: Pick<LegacyRetirementStore, "admitLegacyDispatch">;
  /**
   * Whether `id` is a sub-agent conversation in the tree under `rootConversationId` (TaskOutput /
   * TaskStop tell a sub-agent's agentId apart from an unknown task id), and the sub-agents a
   * conversation dispatched itself (`TaskList`); absent in test stubs.
   */
  subagents?: {
    inTree(rootConversationId: string, id: string): Promise<boolean>;
    childrenOf(orgId: string, conversationId: string): Promise<ChildAgent[]>;
  };
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
   * conversation's latest `device_paths` (absent in test stubs, which record none).
   */
  eventLog: Pick<EventLog, "append" | "latestFileState"> &
    Partial<Pick<EventLog, "publishChanged" | "latestOfType" | "findByIdem">>;
  config: Pick<KernelConfigService, "get">;
  /** Where a mapped provider failure keeps its raw error (warn); absent in test stubs. */
  log?: Pick<Logger, "warn">;
  /**
   * The managed device context writer (permission context replay spec B3): on the managed route it
   * records the marked device paths before any preparation or user callback, instead of the legacy
   * `device_paths` writer. Absent while dormant (the legacy writer stays on unactivated routes).
   */
  managedDeviceContext?: ManagedDeviceContextPort;
  /**
   * The paired activation (`PERMISSION_CONTEXT_ACTIVATION`): the managed route then requires
   * {@link managedDeviceContext} and refuses before entering without it.
   */
  managedDeviceContextRequired?: boolean;
}

/**
 * The sandbox a callback gets: the instance handle, the provider (every `exec` carries the
 * holder's tag and the call's actor) and the call's signal combined with the lease's (pass it to
 * every provider call).
 */
export interface SandboxSession {
  /** The device the call runs in (path leases are taken on it). */
  deviceId: string;
  /** The mode the device runs at now (auto mode spec §4.1): the file tools' path checks follow it. */
  mode: SandboxMode;
  h: SandboxHandle;
  /** The instance's roots: every path the call builds or checks is under one of them. */
  roots: SandboxRoots;
  /**
   * The conversation's working root ({@link workingRootOf}): the bound project's root, else
   * `roots.workspace`. `Bash` runs here, `Glob` / `Grep` search here by default and a relative
   * file-tool path resolves against it; it never changes what {@link checkToolPath} accepts.
   */
  workingRoot: string;
  p: HeldProvider;
  signal: AbortSignal;
}

// ---- 模型可见文案（英文） ----

/**
 * This conversation's first use of its device. The working directory is the instance's workspace,
 * or a bound project's root (`workingRoot`, project root spec §4.3).
 */
export const sandboxStartedNotice = (
  roots: SandboxRoots,
  workingRoot: string = roots.workspace,
): string =>
  workingRoot === roots.workspace
    ? `Device started (first use in this conversation); the working directory is ${roots.workspace}, shared with the device's other conversations.`
    : `Device started (first use in this conversation); the working directory is ${workingRoot}, the project's root, on a device shared with other conversations.`;
/** {@link sandboxStartedNotice} of an instance with the default roots. */
export const SANDBOX_STARTED_NOTICE = sandboxStartedNotice(DEFAULT_SANDBOX_ROOTS);
/** A new instance came up on the device's kept files. */
export const SANDBOX_RESTARTED_NOTICE =
  "The device's instance was restarted; files are kept, running processes are gone and temporary files may be gone.";
/**
 * The device's files were reset (on request, or after they were lost) since this conversation
 * last used it.
 */
export const sandboxFilesResetNotice = (roots: SandboxRoots): string =>
  `The device's files were reset; earlier files in ${roots.workspace} and running processes are gone and temporary files may be gone, so recreate anything you still need.`;
/** {@link sandboxFilesResetNotice} of an instance with the default roots. */
export const SANDBOX_FILES_RESET_NOTICE = sandboxFilesResetNotice(DEFAULT_SANDBOX_ROOTS);

const BUSY_TEXT =
  "The device is busy: all its command slots are taken by commands of this or another conversation sharing it; wait for one to finish and retry.";
const NO_SANDBOX_TEXT =
  "No sandbox is configured in this deployment; ask an administrator to install a sandbox plugin, or do the task without the sandbox.";
/** The message the kernel reports for a sandbox tool call with no provider, minus its final period. */
export const SANDBOX_UNAVAILABLE_REASON = NO_SANDBOX_TEXT.slice(0, -1);

/** The error of a sandbox call in a deployment without a sandbox provider. */
export function noSandboxError(): ToolError {
  return new ToolError(NO_SANDBOX_TEXT);
}

const PATH_BUSY_TEXT =
  "Another sub-agent or another conversation on this device is writing this file; wait a moment and retry.";
const ANONYMOUS_TEXT =
  "The sandbox is not available to anonymous IM senders; do the task without the sandbox, or ask the person to link their account and start a new conversation.";
const ENV_NOT_FOUND_TEXT =
  "This conversation's device was deleted or its owner can no longer use it; ask the user to start a new conversation on another device.";
const ENV_FORBIDDEN_TEXT =
  "This conversation's owner may no longer use its device; ask the user to start a new conversation on a device they can use.";
const ENV_UNAVAILABLE_TEXT =
  "This conversation's device is kept by a sandbox provider that is not active in this deployment; ask the user to start a new conversation on another device, or an administrator to re-enable that provider.";
const ENV_FILES_LOST_TEXT =
  "This device's files are gone. Ask the user to reset its files on the devices page, then retry.";
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
  "This device's directory is gone from the device's machine. Ask the person to run capybara-device logout, then capybara-device login into this device, on that machine, then retry.";
const FILES_GONE_TEXT =
  "This device's files are gone. Ask the user to reset its files on the devices page (for a local device: to run capybara-device logout, then capybara-device login, on it), then retry.";
const DEVICE_OFFLINE_TEXT =
  "The device's machine is offline. Ask the person to start capybara-device on it, or to start a new conversation on another device.";
const DEVICE_OUTDATED_TEXT =
  "The device's machine runs an outdated capybara-device. Ask the person to update it on that machine and start it again.";
const DEVICE_REVOKED_TEXT =
  "The device's machine was disconnected. Ask the person to run capybara-device logout, then capybara-device login on it, or to start a new conversation on another device.";
const deviceProtocolText = (detail: string): string =>
  `The device's machine sent an answer the platform cannot read (${detail}). Ask the person to update capybara-device on that machine, then retry.`;
/**
 * A cloud provider refused the device's open public network (`sandbox.open_network_refused`): the
 * fixed text, never the provider's own message (it may name its settings).
 */
export const SANDBOX_OPEN_NETWORK_REFUSED_TEXT =
  "The cloud sandbox provider refused to give this device the open public network, so nothing ran in the sandbox and retrying won't help. Ask the person to switch this device to sandbox mode and have an org admin switch the organization's cloud network to an allowlist, or have a super admin use a sandbox provider that offers the open network. Continue without the sandbox meanwhile.";
/** A cloud provider failed to create the device's sandbox otherwise (`sandbox.create_failed`). */
export const SANDBOX_CREATE_FAILED_TEXT =
  "The cloud sandbox provider could not create this device's sandbox, so nothing ran in it. Retry once; if it fails again, continue without the sandbox and ask the person to have a super admin check the sandbox extension's settings (Admin console → Extensions).";
const LOCK_LOST_TEXT =
  "The sandbox operation was interrupted because the sandbox lock was lost; check the sandbox state and retry.";

export { ATTACHMENTS_ROOT, attachmentsDir, attachmentsRoot };
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
 * control characters, no empty or `..` segments), run before the call enters its device, so
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

/**
 * A file tool's path in the mode the device runs at now (auto mode spec §4.1, decision 1): auto
 * mode accepts any clean absolute path on the machine (shape checks only, the review judges a write
 * outside the workspace); sandbox mode keeps the roots ({@link checkPath}).
 */
export function checkToolPath(
  path: string,
  s: Pick<SandboxSession, "roots" | "mode">,
  field = "path",
): string {
  if (s.mode !== "auto") return checkPath(path, s.roots, field);
  checkPathShape(path, field);
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * The shape checks of a file tool's path before the call enters its device: an absolute path gets
 * {@link checkPathShape}; a relative one (resolved against the working root inside,
 * {@link resolveToolPath}) must not start with `~` (never expanded) and must pass the same shape
 * checks (no control characters, no empty or `..` segments).
 */
export function checkFilePathShape(path: string, field = "file_path"): void {
  if (path.startsWith("/")) {
    checkPathShape(path, field);
    return;
  }
  const errors = path.startsWith("~")
    ? ["~ is not expanded"]
    : path === "" || path === "."
      ? ["path must name a file"]
      : validateSandboxPathShape(`/${path}`);
  if (errors.length > 0) {
    throw new ToolError(
      `Invalid ${field} "${clip(path, 200)}": ${errors.join("; ")}. Pass an absolute path, or a path relative to the working directory without '..' segments.`,
    );
  }
}

/**
 * A file tool's path made absolute: a relative path (shape-checked by {@link checkFilePathShape})
 * resolves against the session's working root, `.` segments dropped; an absolute one is kept.
 * The result still goes through {@link checkToolPath}.
 */
export function resolveToolPath(path: string, s: Pick<SandboxSession, "workingRoot">): string {
  if (path.startsWith("/")) return path;
  const segments = path.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (segments.length === 0) return s.workingRoot;
  return `${s.workingRoot === "/" ? "" : s.workingRoot}/${segments.join("/")}`;
}

/** {@link checkToolPath} for a writing tool: the skills directory stays read-only in both modes. */
export function checkToolWritable(
  path: string,
  s: Pick<SandboxSession, "roots" | "mode" | "workingRoot">,
): string {
  const p = checkToolPath(resolveToolPath(path, s), s, "file_path");
  if (p === s.roots.skills || p.startsWith(`${s.roots.skills}/`)) {
    const where =
      s.mode === "auto"
        ? "pass another path instead"
        : `pass a path under ${s.roots.workspace} or ${s.roots.tmp} instead`;
    throw new ToolError(
      `Path ${clip(p, 200)} is read-only (${s.roots.skills} holds skill files); ${where}.`,
    );
  }
  return p;
}

/** POSIX shell 单引号转义。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

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
 * 字节），与 `used`（已占用的）及彼此不重名，重名时加 `-2`、`-3`……（加在扩展名之前）。
 * 清理后仍不是合法沙箱路径的用 `attachment-<id 前 8 位>`。
 */
export function assignAttachmentNames(
  items: readonly { id: string; name: string }[],
  used: ReadonlySet<string>,
): Map<string, string> {
  const taken = new Set(used);
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

/** A trusted copy's session: the three preparation methods, scoped to the declared roots. */
export interface PreparationSession {
  deviceId: string;
  roots: SandboxRoots;
  signal: AbortSignal;
  p: SandboxPreparation;
}
/** Temporary protocol-2 binding; removed with the active caller cutover in Task8. */
function legacyPreparationSession(s: SandboxSession): PreparationSession {
  return {
    deviceId: s.deviceId,
    roots: s.roots,
    signal: s.signal,
    p: {
      readFile: (path, opts) => s.p.readFile(s.h, path, opts),
      writeFile: (path, data, signal) => s.p.writeFile(s.h, path, data, signal),
      stat: (path, signal) => s.p.stat(s.h, path, signal),
    },
  };
}

/**
 * A machine that reports auto mode while the organization allows only sandbox mode (auto mode
 * spec §4.3): the kernel's refusal text plus what the model can do.
 */
const AUTO_MODE_TOOL_TEXT = `${AUTO_MODE_NOT_ALLOWED_TEXT} Ask the user to switch it on the machine, or to start a new conversation on another device.`;
/**
 * Full access refused by policy (B-13: `org.*` / `deployment.*`, old and renamed codes): the
 * organization or the platform has it off. The kernel's own message is never shown.
 */
export const FULL_ACCESS_OFF_BY_POLICY_TOOL_TEXT =
  "Full access is turned off by your organization's or the platform's policy, so nothing ran. Continue with the Request approval or Approve for me permission profile, or ask an org admin (or a super admin) to allow Full access.";
/**
 * The device's owner ceiling does not allow Full access (`device.full_access_not_allowed`).
 */
export const FULL_ACCESS_CEILING_TOOL_TEXT =
  "This device's owner ceiling does not allow Full access, so nothing ran. Ask the device's owner to raise it with `capybara-device ceiling set` on that machine, or continue with the Request approval or Approve for me permission profile.";
/**
 * The full-access refusal codes off by policy: the renamed ones (W5-P3b) and the old organization
 * and platform names until that rename lands; `device.auto_mode_not_allowed` keeps its machine
 * text ({@link AUTO_MODE_TOOL_TEXT}).
 */
const FULL_ACCESS_OFF_BY_POLICY_CODES: ReadonlySet<string> = new Set([
  "org.full_access_not_allowed",
  "deployment.full_access_not_allowed",
  "org.auto_mode_not_allowed",
  "deployment.auto_mode_not_allowed",
]);
/**
 * A managed operation outside the admitted scope (`SandboxScopeDeniedError`): fixed text, never
 * the refusal's own message (a provider may write it).
 */
export const SCOPE_DENIED_TOOL_TEXT =
  "This operation reaches outside what this conversation's permission profile allows on the device (a path outside the directories it may read or write, or a host it may not reach), so it did not run. Keep the call inside the working directory and the directories already granted, or ask the user to grant the directory or choose a broader permission profile, then retry.";
/** A staged request the machine never got: it reconnected before the request was sent. */
export const DEVICE_REQUEST_NOT_SENT_TOOL_TEXT =
  "The device's machine reconnected before this operation was sent, so nothing ran. Retry the tool call.";
/** The device cannot enforce the conversation's profile (`SandboxPermissionUnsupportedError`). */
export const PERMISSION_UNSUPPORTED_TOOL_TEXT =
  "This device cannot enforce this conversation's permission profile, so nothing ran. Ask the user to choose another permission profile for the conversation, or to start a new conversation on a device that supports it.";
/** A managed operation whose outcome could not be confirmed (`SandboxOperationOutcomeUnknownError`). */
export const OUTCOME_UNKNOWN_TOOL_TEXT =
  "The device may or may not have run this operation: its outcome could not be confirmed. Check the device's state (for example with Read, Glob or TaskList) before retrying, and do not repeat an operation that must not run twice.";

/**
 * Sandbox service errors → actionable text for the model; anything else is returned unchanged
 * (the pipeline reports a generic tool failure). A provider that cannot be reached becomes a
 * fixed text (providers never write model-visible text) with `kind: "unavailable"`, and its raw
 * error is logged to `log` as a warning (the pipeline logs only errors it did not get as a
 * `ToolError`).
 */
const RECONCILE_REQUIRED_TEXT =
  "This device's sandbox limits must be established again before it runs anything, so nothing ran. Ask the person to reset the device's files on the devices page, then retry, or to start a new conversation on another device.";
const INSTANCE_BINDING_TEXT =
  "The device's machine has not confirmed its current instance, so nothing ran. Ask the person to restart capybara-device on that machine (updating it if it is outdated), then retry, or to start a new conversation on another device.";

/** The provider connection failure behind an unknown outcome, with the raw error to log. */
function unreachableCause(
  cause: unknown,
): { failure: "connect" | "dropped"; err: unknown } | undefined {
  if (cause instanceof SandboxProviderUnreachableError)
    return { failure: cause.failure, err: cause.cause };
  const failure = providerConnectionFailure(cause);
  return failure ? { failure, err: cause } : undefined;
}

/** The run's account is not the conversation's owner, whose device it never uses. */
class DeviceOfAnotherAccount extends Error {
  override readonly name = "DeviceOfAnotherAccount";
  constructor() {
    super("The run's account is not the conversation's owner");
  }
}
export const DEVICE_OF_ANOTHER_ACCOUNT_TEXT =
  "This conversation's device belongs to its owner, and this run was started by another member, so nothing ran on the device. Continue without the device, or ask the conversation's owner to run this.";

export function mapSandboxError(e: unknown, log: Pick<Logger, "warn"> | undefined): unknown {
  if (e instanceof DeviceOfAnotherAccount) return new ToolError(DEVICE_OF_ANOTHER_ACCOUNT_TEXT);
  if (e instanceof ManagedDeviceContextStale)
    return new ToolError(MANAGED_DEVICE_CONTEXT_STALE_TEXT, { kind: "unavailable" });
  if (e instanceof ManagedDeviceContextUnavailable)
    return new ToolError(MANAGED_DEVICE_CONTEXT_UNAVAILABLE_TEXT, { kind: "unavailable" });
  if (e instanceof ManagedDeviceContextFailed)
    return new ToolError(MANAGED_DEVICE_CONTEXT_FAILED_TEXT, { kind: "unavailable" });
  // the managed route's typed refusals (unknown first: it never proves the operation had no effect)
  if (isSandboxOperationOutcomeUnknownError(e)) {
    // the provider could not be reached after the durable dispatch: the ledger keeps the outcome
    // unknown, the model gets the actionable connection text (a connection never made did
    // nothing; a broken one may have acted)
    const unreachable = unreachableCause((e as { cause?: unknown }).cause);
    if (unreachable) {
      log?.warn("sandbox provider unreachable", { ...unreachable, outcome: "unknown" });
      return new ToolError(
        unreachable.failure === "connect"
          ? SANDBOX_UNREACHABLE_TEXT
          : SANDBOX_CONNECTION_DROPPED_TEXT,
        { kind: "unavailable" },
      );
    }
    log?.warn("sandbox operation outcome unknown", { err: e });
    return new ToolError(OUTCOME_UNKNOWN_TOOL_TEXT, { kind: "unavailable" });
  }
  // kernel-typed, before the scope refusal it extends: nothing was sent, a retry is safe
  if (isDeviceRequestNotSent(e))
    return new ToolError(DEVICE_REQUEST_NOT_SENT_TOOL_TEXT, { kind: "unavailable" });
  if (isSandboxScopeDeniedError(e)) {
    log?.warn("sandbox operation outside its scope", { err: e });
    return new ToolError(SCOPE_DENIED_TOOL_TEXT);
  }
  if (isSandboxPermissionUnsupportedError(e)) {
    log?.warn("sandbox permission profile unsupported", { err: e });
    return new ToolError(PERMISSION_UNSUPPORTED_TOOL_TEXT);
  }
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
      if (reason === ANONYMOUS_NO_DEVICE) return new ToolError(ANONYMOUS_TEXT);
      return new ToolError(NO_SANDBOX_TEXT);
    }
    const detail = e.details?.[0] as { reason?: unknown; source?: unknown } | undefined;
    if (e.code === "device.not_found") return new ToolError(ENV_NOT_FOUND_TEXT);
    if (e.code === "device.forbidden" && detail?.reason === "machine_revoked") {
      return new ToolError(DEVICE_REVOKED_TEXT);
    }
    if (e.code === "device.forbidden") return new ToolError(ENV_FORBIDDEN_TEXT);
    if (e.code === "device.unavailable") return new ToolError(ENV_UNAVAILABLE_TEXT);
    if (e.code === "device.files_lost" && detail?.source === "local") {
      return new ToolError(DEVICE_FILES_LOST_TEXT);
    }
    if (e.code === "device.files_lost") return new ToolError(ENV_FILES_LOST_TEXT);
    if (e.code === "device.offline") return new ToolError(DEVICE_OFFLINE_TEXT);
    if (e.code === "device.program_outdated") return new ToolError(DEVICE_OUTDATED_TEXT);
    if (e.code === "device.auto_mode_not_allowed") return new ToolError(AUTO_MODE_TOOL_TEXT);
    if (e.code === "device.full_access_not_allowed")
      return new ToolError(FULL_ACCESS_CEILING_TOOL_TEXT);
    if (FULL_ACCESS_OFF_BY_POLICY_CODES.has(e.code))
      return new ToolError(FULL_ACCESS_OFF_BY_POLICY_TOOL_TEXT);
    if (e.code === "device.permission_reconcile_required") {
      return new ToolError(RECONCILE_REQUIRED_TEXT, { kind: "unavailable" });
    }
    if (e.code === "sandbox.open_network_refused") {
      return new ToolError(SANDBOX_OPEN_NETWORK_REFUSED_TEXT);
    }
    if (e.code === "sandbox.create_failed") return new ToolError(SANDBOX_CREATE_FAILED_TEXT);
  }
  // an operation outside withSandbox's own mapping (it records lost files itself)
  if (isFileSystemGoneError(e)) return new ToolError(FILES_GONE_TEXT);
  if (e instanceof DeviceProtocolError) return new ToolError(deviceProtocolText(e.message));
  if (e instanceof InstanceBindingError) {
    log?.warn("device instance binding failed", { err: e });
    return new ToolError(INSTANCE_BINDING_TEXT, { kind: "unavailable" });
  }
  if (e instanceof SandboxLockLostError) return new ToolError(LOCK_LOST_TEXT);
  if (e instanceof SandboxPathBusyError) return new ToolError(PATH_BUSY_TEXT);
  return e;
}

/**
 * Runs `fn` in the device of the call's conversation (a sub-agent: its root's): resolves and
 * checks the device for the conversation's owner (binding an unbound conversation to the
 * owner's default first), then `SandboxService.withSandbox` (the instance created, resumed or
 * rebuilt on the kept files as needed, every `exec` carrying the call's actor). It never touches
 * attachments: `FetchAttachment` is the only way one enters the device. Returns the value and the
 * notices to put before the result (first use, a new instance). When `withSandbox` rebuilds a gone
 * instance and calls `fn` again, the notices are the last call's. The instance's roots are recorded
 * for the model on the conversation's first call and whenever they change
 * ({@link recordDevicePaths}).
 */
export async function inSandbox<T>(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  fn: (s: SandboxSession) => Promise<T>,
): Promise<{ value: T; notices: string[] }> {
  return inSandboxWith(deps, ctx, fn, false);
}
/**
 * The device entry of every builtin tool (B-17): once the one activation gate is on (the managed
 * writer required, {@link SandboxToolDeps.managedDeviceContextRequired}) the managed operation
 * route ({@link inSandboxOperations}: the marked device paths recorded before the callback, every
 * provider call a managed operation); otherwise the legacy route ({@link inSandbox}), unchanged.
 */
export async function inToolSandbox<T>(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  fn: (s: SandboxSession) => Promise<T>,
): Promise<{ value: T; notices: string[] }> {
  return deps.managedDeviceContextRequired
    ? inSandboxOperations(deps, ctx, fn)
    : inSandbox(deps, ctx, fn);
}
export async function inSandboxOperations<T>(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  fn: (s: SandboxSession) => Promise<T>,
  stage?: {
    purpose: SandboxPreparationScope["purpose"];
    roots: (roots: SandboxRoots) => readonly string[];
    run: (s: PreparationSession) => Promise<void>;
  },
): Promise<{ value: T; notices: string[] }> {
  return inSandboxWith(deps, ctx, fn, true, stage);
}
/**
 * Trusted copy callbacks only receive preparation's three methods. Once the activation gate is on
 * the copy is a trusted preparation on the managed route ({@link inSandboxOperationPreparation},
 * scoped to `roots`, after the marked device paths); otherwise the protocol-2 binding.
 */
export async function inSandboxPreparation<T>(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  purpose: SandboxPreparationScope["purpose"],
  roots: (roots: SandboxRoots) => readonly string[],
  fn: (s: PreparationSession) => Promise<T>,
): Promise<{ value: T; notices: string[] }> {
  if (deps.managedDeviceContextRequired)
    return inSandboxOperationPreparation(deps, ctx, purpose, roots, fn);
  return inSandbox(deps, ctx, (s) => fn(legacyPreparationSession(s)));
}
/** The trusted-copy entry on the managed route ({@link inSandboxPreparation} once activated). */
export async function inSandboxOperationPreparation<T>(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  purpose: SandboxPreparationScope["purpose"],
  roots: (roots: SandboxRoots) => readonly string[],
  fn: (s: PreparationSession) => Promise<T>,
): Promise<{ value: T; notices: string[] }> {
  let value: T;
  return inSandboxOperations(deps, ctx, async () => value, {
    purpose,
    roots,
    run: async (s) => {
      value = await fn(s);
    },
  });
}
async function inSandboxWith<T>(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  fn: (s: SandboxSession) => Promise<T>,
  operations: boolean,
  stage?: {
    purpose: SandboxPreparationScope["purpose"];
    roots: (roots: SandboxRoots) => readonly string[];
    run: (s: PreparationSession) => Promise<void>;
  },
): Promise<{ value: T; notices: string[] }> {
  try {
    // once activated, only the managed route runs: a legacy route refuses before entering, so v1
    // permission context never sits next to old-mode device_paths; a managed route never runs
    // without its writer, so no preparation or user callback can run unrecorded
    if (!operations && deps.managedDeviceContextRequired)
      throw new ManagedDeviceContextFailed("refused");
    const managed = operations ? managedWriter(deps) : undefined;
    // a run another account triggered in this conversation (a wake attributed to another member)
    // never uses the owner's device: refused before the device is resolved
    if (ctx.ownerAccountId !== undefined && ctx.ownerAccountId !== ctx.accountId)
      throw new DeviceOfAnotherAccount();
    const deviceId = await deps.devices.forTool(ctx.orgId, sandboxConversationOf(ctx));
    // the mode once per call: the path checks follow it and the device_paths event records it;
    // the working facts (workspace, home, project snapshot) are read as the review reads them
    // a call the review covered runs in the working root it was reviewed against: never read again
    const reviewed = ctx.reviewedWorkingRoot;
    const [level, reach, working] = await Promise.all([
      deps.devices.modeLevel?.(ctx.orgId, deviceId) ?? null,
      deps.devices.projectReach?.(ctx.orgId, deviceId),
      reviewed !== undefined
        ? null
        : (deps.devices.workingFacts?.(
            ctx.orgId,
            sandboxConversationOf(ctx),
            ctx.conversationId,
            deviceId,
          ) ?? null),
    ]);
    const enter: SandboxService["withSandbox"] = operations
      ? (use, call, signal) => {
          const claim = ctx.executionClaim;
          if (!claim || !ctx.runId || claim.runId !== ctx.runId || !deps.sandbox.withOperations)
            throw new SandboxScopeDeniedError("The tool has no current server execution claim");
          return deps.sandbox.withOperations(
            use,
            {
              claim,
              callId: ctx.callId,
              deadlineMs: Math.min(ctx.runDeadline ?? Infinity, Date.now() + 30000),
              ...(managed && { contextEvidence: true as const }),
              beforeUser: async (staging, info, sig) => {
                // the held instance's device paths, recorded before any preparation or user callback
                if (managed) {
                  // no installed binding to describe the held instance: unavailable, not stale
                  if (!info.contextEvidence) throw new ManagedDeviceContextUnavailable();
                  // B-18: the review judged the call against a root (the workspace included);
                  // held evidence of another root is stale, refused before anything is recorded
                  // or run
                  const against = ctx.reviewedAgainstRoot ?? reviewed;
                  if (
                    against !== undefined &&
                    canonicalRoot(against) !== canonicalRoot(info.contextEvidence.workingRoot)
                  )
                    throw new ManagedDeviceContextStale();
                  await recordManagedDevicePaths(
                    { managedDeviceContext: managed },
                    ctx,
                    info.contextEvidence,
                    sig,
                  );
                }
                if (stage)
                  await staging.prepare(stage.purpose, stage.roots(info.roots), (p, signal) =>
                    stage.run({ deviceId, roots: info.roots, p, signal }),
                  );
                sig.throwIfAborted();
              },
            },
            call,
            signal,
          );
        }
      : deps.sandbox.withSandbox.bind(deps.sandbox);
    return await enter(
      {
        orgId: ctx.orgId,
        deviceId,
        // a sub-agent is told when another holder rebuilt the shared instance (final review m5)
        holderConversationId: ctx.conversationId,
        // the run routes its network grants to a connected device (network ask-to-allow P-D3)
        actor: {
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
          ...(ctx.runId !== undefined && { runId: ctx.runId }),
        },
      },
      async (h, p, info, signal) => {
        // unknown mode: the strict (sandbox) path checks stay (fail closed)
        const mode = level?.mode ?? "sandbox";
        const s: SandboxSession = {
          deviceId,
          mode,
          h,
          roots: info.roots,
          // a managed call runs in the working root its device context recorded (admission's),
          // which a reviewed call's root equals (checked before the callback, B-18)
          workingRoot:
            (managed ? info.contextEvidence?.workingRoot : undefined) ??
            reviewed ??
            sessionWorkingRoot(working, mode, info.roots.workspace, reach),
          p,
          signal,
        };
        // the legacy writer only on unactivated routes: a managed call recorded before preparation
        if (!managed) await recordDevicePaths(deps, ctx, info.roots, level ?? null);
        const notices: string[] = [];
        if (info.filesReset) notices.push(sandboxFilesResetNotice(info.roots));
        else if (info.restarted) notices.push(SANDBOX_RESTARTED_NOTICE);
        else if (info.fresh) notices.push(sandboxStartedNotice(info.roots, s.workingRoot));
        return { value: await fn(s), notices };
      },
      ctx.signal,
    );
  } catch (e) {
    throw mapSandboxError(e, deps.log);
  }
}

/**
 * The managed writer of an operations route: the injected one, or none while dormant. Once the
 * paired activation requires it, a missing writer refuses the call before anything is entered.
 */
function managedWriter(deps: SandboxToolDeps): ManagedDeviceContextPort | undefined {
  if (deps.managedDeviceContext) return deps.managedDeviceContext;
  if (deps.managedDeviceContextRequired) throw new ManagedDeviceContextFailed("refused");
  return undefined;
}

/**
 * Records the managed device paths of the held instance `held` into the calling conversation (a
 * sub-agent: its own log) for this call's run and actor: a thin delegator to the managed writer,
 * which owns the transaction and all validation (permission context replay spec B3).
 */
export async function recordManagedDevicePaths(
  deps: { managedDeviceContext: ManagedDeviceContextPort },
  ctx: BuiltinCallContext,
  held: Readonly<HeldDeviceContextEvidence>,
  signal: AbortSignal,
): Promise<void> {
  if (ctx.runId === undefined) throw new ManagedDeviceContextFailed("refused");
  await deps.managedDeviceContext.record(
    {
      orgId: ctx.orgId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      accountId: ctx.accountId,
    },
    held,
    signal,
  );
}

/**
 * Environments spec §13.1, ruling R22; auto mode spec §4.2: the calling conversation's log (the
 * log its model reads; a sub-agent's own too) gets a `device_paths` event on its first sandbox
 * call, the default roots included, and again whenever the held instance's roots or the device's
 * mode and network differ from the latest recorded ones; always before the call's result. Two
 * indexed reads per call (migration 0094, the device's row); parallel calls that saw the same
 * latest event write one event (its idempotency key).
 */
async function recordDevicePaths(
  deps: Pick<SandboxToolDeps, "eventLog">,
  ctx: BuiltinCallContext,
  roots: SandboxRoots,
  level: DeviceModeLevel | null,
): Promise<void> {
  if (!deps.eventLog.latestOfType) return;
  const latest = await deps.eventLog.latestOfType(ctx.conversationId, "device_paths");
  const change = devicePathsChange(latest, roots, ctx.runId, level ?? undefined);
  if (change) await deps.eventLog.append(ctx.conversationId, [change]);
}

/**
 * The working root of a call: the project root exactly as the review decides it (from the same
 * {@link WorkingFacts}); when that falls back to the device's workspace, the held instance's own
 * workspace (`workspace`), where the call really runs. Every session built outside `inSandbox` (a
 * person's project skill invocation) takes its working root from here too.
 */
export function sessionWorkingRoot(
  working: WorkingFacts | null,
  mode: SandboxMode,
  workspace: string,
  reach?: "workspace" | "os-user",
): string {
  if (working === null) return workspace;
  const root = workingRootOf(working.project, { mode, reach, ...working });
  return root === working.workspace ? workspace : root;
}

/** The conversation whose device a call uses (the root conversation's for a sub-agent). */
export const sandboxConversationOf = (ctx: BuiltinCallContext): string =>
  ctx.sandboxConversationId ?? ctx.conversationId;

/**
 * Runs `fn` under the per-path lease of `path` in the session's device (spec §10.4: the
 * kernel's own read-modify-write of one file never loses another holder's update, from any
 * conversation sharing the device). `fn` gets `signal` combined with the path lease's: pass
 * it to every provider call, so a lost path lease stops the write. Without `pathLease` (test
 * stubs) it just runs `fn` with `signal`.
 */
export async function withPathLease<T>(
  deps: Pick<SandboxToolDeps, "sandbox">,
  s: Pick<SandboxSession, "deviceId">,
  path: string,
  signal: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!deps.sandbox.pathLease) return fn(signal);
  const lease = await deps.sandbox.pathLease(s.deviceId, path, signal);
  try {
    return await fn(AbortSignal.any([signal, lease.signal]));
  } finally {
    await lease.release().catch(() => {});
  }
}

/**
 * Whether a sandbox tool call of the conversation tree rooted at `conversationId` can run: a
 * cloud provider is loaded, or (ruling R8) the conversation's device runs on a registered
 * kernel provider (`@local`). Without a conversation only the cloud provider counts.
 */
export async function sandboxUsable(
  deps: Pick<SandboxToolDeps, "sandbox" | "devices">,
  orgId: string,
  conversationId: string | undefined,
): Promise<boolean> {
  if (deps.sandbox.cloudAvailable) return true;
  if (conversationId === undefined || !deps.devices.usableNow) return false;
  return deps.devices.usableNow(orgId, conversationId);
}

/**
 * The reason the registry reports the sandbox tools unavailable with, or null when they can run
 * ({@link sandboxUsable}; the listing passes the root conversation of the run). An eval replay
 * lists them as available (`replay`: its calls are never executed). `memo` (one per listing)
 * makes every sandbox tool of a listing share one answer.
 */
export const unavailableWhenNoSandbox =
  (deps: Pick<SandboxToolDeps, "sandbox" | "devices">) =>
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
