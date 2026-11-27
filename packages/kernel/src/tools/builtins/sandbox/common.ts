import {
  DEFAULT_SANDBOX_ROOTS,
  isDeviceOfflineError,
  isDeviceRequestNotSent,
  isDialInAnswerTimeoutError,
  isFileSystemGoneError,
  isSandboxOperationOutcomeUnknownError,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  isSandboxScopeValidationError,
  isSandboxWorkUnsettledError,
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
import { DeviceProtocolError } from "@capybara-hq/plugin-sdk/device-protocol";
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
  type DeviceUnusableReason,
  NO_DEVICE,
} from "../../../devices/conversation-devices.js";
import { canonicalRoot, workingRootOf } from "../../../devices/working-root.js";
import { ApiError } from "../../../errors.js";
import type { FileDeliveries } from "../../../files/deliveries.js";
import type { KernelConfigService } from "../../../infra/config/kernel-config.service.js";
import {
  ATTACHMENTS_ROOT,
  attachmentsDir,
  attachmentsRoot,
} from "../../../sandbox/attachments-path.js";
import { SandboxPathBusyError } from "../../../sandbox/leases.js";
import {
  MANAGED_DEVICE_CONTEXT_FAILED_TEXT,
  MANAGED_DEVICE_CONTEXT_STALE_TEXT,
  MANAGED_DEVICE_CONTEXT_UNAVAILABLE_TEXT,
  ManagedDeviceContextFailed,
  type ManagedDeviceContextPort,
  ManagedDeviceContextStale,
  ManagedDeviceContextUnavailable,
} from "../../../sandbox/managed-device-context.js";
import { isEscalationGrantMissing } from "../../../sandbox/operation-authority-types.js";
import {
  PermissionAdmissionUnavailable,
  type PermissionAvailabilityCause,
} from "../../../sandbox/permission-availability.js";
import type { HeldDeviceContextEvidence } from "../../../sandbox/permission-context-types.js";
import { isDeviceProgramRestarted } from "../../../sandbox/request-not-sent.js";
import {
  type HeldProvider,
  RetirementPendingError,
  SandboxLockLostError,
  type SandboxService,
} from "../../../sandbox/sandbox.service.js";
import {
  providerConnectionFailure,
  SandboxProviderUnreachableError,
} from "../../../sandbox/unreachable.js";
import type { StorageService } from "../../../storage/storage.service.js";
import type { BuiltinCallContext, ToolListingScope } from "../../registry.js";
import { assertDeviceOfRunAccount } from "./device-owner.js";
import type { ReadFileDeps } from "./read.js";

/** 沙箱工具的依赖（都按调用时取，多副本下无进程内状态）。 */
export interface SandboxToolDeps {
  /**
   * Every device call is a managed operation (`withOperations`). `pathLease` may be absent (test
   * stubs): the kernel's own file writes then take no path lease. `currentInstance` too: a
   * background `Bash` launch records the instance it started in; and `ifRunning`, which
   * `TaskOutput` reads a task through.
   */
  sandbox: Pick<SandboxService, "withOperations"> &
    Partial<Pick<SandboxService, "pathLease" | "currentInstance" | "ifRunning">>;
  /**
   * The device a call enters: the root conversation's, checked for its owner every call.
   * `usableNow` (absent in test stubs: the device's provider serves the org) tells a listing
   * whether a conversation's device has its provider on in the org (ruling R8).
   */
  devices: Pick<ConversationDevices, "forTool"> &
    Partial<Pick<ConversationDevices, "usableNow" | "unusableReason">>;
  /** Background `Bash` tasks; absent in test stubs, where `run_in_background` is refused. */
  background?: Pick<
    BackgroundTaskStore,
    "releaseStop" | "get" | "advanceOffset" | "runningOwnedBy" | "finishedOwnedBy"
  > &
    Partial<Pick<BackgroundTaskStore, "reserveManaged" | "failManagedPreEffect">>;
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
  /** `Deliver`'s blobs and delivery transaction (file library spec §4); absent in test stubs. */
  deliveries?: Pick<FileDeliveries, "ensureBlob" | "appendDelivered">;
  /**
   * `readDeliveryScope`: `Deliver`'s delivery scope (truthful delivery spec §2). `publishChanged`:
   * `Deliver` announces `changed: files` (UI refresh B).
   */
  eventLog: Pick<EventLog, "append" | "latestFileState" | "readDeliveryScope"> &
    Partial<Pick<EventLog, "publishChanged" | "findByIdem">>;
  config: Pick<KernelConfigService, "get">;
  /** Where a mapped provider failure keeps its raw error (warn); absent in test stubs. */
  log?: Pick<Logger, "warn">;
  /**
   * The managed device context writer (permission context replay spec B3): it records the marked
   * device paths before any preparation or user callback of every device call.
   */
  managedDeviceContext: ManagedDeviceContextPort;
  /**
   * `Read` beyond the device (vision-read design §1): reads by `file_id`, images shown or read by
   * the vision purpose, their stored copies. Absent in test stubs: `Read` then reads the device
   * only, and an image is reported as a binary file.
   */
  read?: ReadFileDeps;
}

/**
 * The sandbox a callback gets: the instance handle, the provider (every call a managed operation
 * under the admitted scope) and the call's signal combined with the lease's (pass it to every
 * provider call). The file tools' paths are bounded by each operation's admitted scope (project
 * roots plus directory grants, protected paths excluded), which the device enforces, as for
 * `Bash`, never by the device's tier or its outside-sandbox setting; the kernel checks only a
 * path's shape ({@link checkToolPath}).
 */
export interface SandboxSession {
  /** The device the call runs in (path leases are taken on it). */
  deviceId: string;
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
  "No device provider is on in this organization; ask an org admin to switch one on, or do the task without the sandbox.";
/**
 * A conversation with no device while device providers are on in the org: its owner has no default
 * device and the org has no default device provider to make one.
 */
export const NO_DEVICE_TEXT =
  "This conversation has no device: its owner has no default device and the organization has no default device provider to make one. Ask the user to create a device on the devices page and start a new conversation on it, or ask an org admin to choose a default device provider; or do the task without the sandbox.";
/** The message the kernel reports for a sandbox tool call with no provider, minus its final period. */
export const SANDBOX_UNAVAILABLE_REASON = NO_SANDBOX_TEXT.slice(0, -1);

/** The error of a sandbox call with no device provider on in the org. */
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
/** A device whose provider does not serve its org now (`device.unavailable`): files kept. */
export const ENV_UNAVAILABLE_TEXT =
  "This conversation's device runs on a device provider that is off in this organization or not installed; its files are kept. Ask an org admin to switch the provider back on, or start a new conversation on another device.";
/**
 * The device's files are gone at its provider (`device.files_lost`): the devices page resets them
 * where the provider offers that; otherwise the device is set up again where its provider keeps
 * its files (a dial-in device: its machine signs in to it again).
 */
export const ENV_FILES_LOST_TEXT =
  "This device's files are gone. Ask the user to reset its files on the devices page, or, where its provider offers no reset, to set the device up again (for a device served by a machine: sign that machine in to it again), then retry.";
/**
 * A provider call that never connected (refused, unknown host, unreachable network): the request
 * did not reach the provider, so the call did nothing in the sandbox.
 */
export const SANDBOX_UNREACHABLE_TEXT =
  "The sandbox provider can't be reached (the connection failed), so this call did nothing in the sandbox; retrying won't help until a super admin checks the sandbox extension's configuration (Admin console → Extensions). Continue without the sandbox, or ask the person to have a super admin check it.";
/** A provider connection that broke during the call: the provider may have acted before it broke. */
export const SANDBOX_CONNECTION_DROPPED_TEXT =
  "The connection to the sandbox provider broke during this call, so it may or may not have taken effect; check the sandbox state before retrying. If it fails again, continue without the sandbox and ask the person to have a super admin check the sandbox extension's configuration (Admin console → Extensions).";
/** A dial-in device whose machine is not connected (`device.offline`, the SDK's offline error). */
export const DEVICE_OFFLINE_TEXT =
  "The machine serving this device is offline. Ask the person to connect it again, or to start a new conversation on another device.";
const DEVICE_OUTDATED_TEXT =
  "The machine serving this device runs an outdated device program. Ask the person to update it on that machine and connect it again.";
const DEVICE_REVOKED_TEXT =
  "The machine serving this device was disconnected. Ask the person to sign that machine in to this device again, or to start a new conversation on another device.";
const deviceProtocolText = (detail: string): string =>
  `The machine serving this device sent an answer the platform cannot read (${detail}). Ask the person to update the device program on that machine, then retry.`;
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
 * A file tool's path, bounded by the operation's admitted scope: any clean absolute path passes
 * here (shape checks only; the review proposes a directory crossing for a path outside the scope,
 * and the device refuses one the scope does not cover, protected paths included).
 */
export function checkToolPath(path: string, field = "path"): string {
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

/** {@link checkToolPath} for a writing tool: the skills directory stays read-only either way. */
export function checkToolWritable(
  path: string,
  s: Pick<SandboxSession, "roots" | "workingRoot">,
): string {
  const p = checkToolPath(resolveToolPath(path, s), "file_path");
  if (p === s.roots.skills || p.startsWith(`${s.roots.skills}/`)) {
    throw new ToolError(
      `Path ${clip(p, 200)} is read-only (${s.roots.skills} holds skill files); pass another path instead.`,
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

/**
 * Running outside the sandbox refused by policy (B-13): the organization
 * (`org.outside_sandbox_not_allowed`) or the platform (`deployment.*`) has its outside-sandbox
 * setting off. One text per layer; the kernel's own message is never shown.
 */
export const ORG_OUTSIDE_SANDBOX_OFF_TOOL_TEXT =
  "Running commands outside the sandbox is off in this organization, so nothing ran. Run the command inside the sandbox, or ask an organization admin to allow running outside the sandbox.";
export const PLATFORM_OUTSIDE_SANDBOX_OFF_TOOL_TEXT =
  "Running commands outside the sandbox is off on this platform, so nothing ran. Run the command inside the sandbox, or ask a super admin to allow running outside the sandbox.";
/**
 * The device does not allow running outside the sandbox (`device.outside_sandbox_not_allowed`).
 */
export const OUTSIDE_SANDBOX_CEILING_TOOL_TEXT =
  "This device does not allow running commands outside the sandbox, so nothing ran. Run the command inside the sandbox, or ask the device's owner whether its provider can allow it.";
/**
 * The legacy retirement gate's refusals (`RetirementPendingError`, permission runtime cutover
 * 8.5): the device's earlier instance may still run background work an earlier version started.
 * Each says what clears it; the generic `device.unavailable` text would name an inactive provider.
 */
export const RETIREMENT_PENDING_TOOL_TEXT =
  "This device is unavailable: background work started by an earlier version may still run on its previous instance, which has not been confirmed destroyed yet, so nothing ran. Retry later (a cloud device becomes usable once its provider confirms the old instance destroyed), continue without the device, or ask the user to start a new conversation on another device.";
export const RETIREMENT_RECREATE_TOOL_TEXT =
  "Background work started by an earlier version may still be running on an earlier instance of this device, which can no longer be verified as destroyed, so nothing ran. Ask the device's owner to delete the device and create it again, or ask the user to start a new conversation on another device.";
/** The model-facing text of a retirement refusal's code (`device.unavailable` for any other). */
function retirementToolText(code: string): string {
  if (code === "device.recreate_required") return RETIREMENT_RECREATE_TOOL_TEXT;
  return RETIREMENT_PENDING_TOOL_TEXT;
}
/**
 * A managed operation outside the admitted scope (`SandboxScopeDeniedError`): fixed text, never
 * the refusal's own message (a provider may write it).
 */
export const SCOPE_DENIED_TOOL_TEXT =
  "This operation reaches outside the scope this conversation has on the device (a path outside the directories it may read or write, or a host it may not reach), so it did not run. Keep the call inside the working directory and the directories already granted, or ask the user to grant the directory, then retry.";
/** An approved sandbox escalation whose grant no longer matches at admission (nothing ran). */
export const ESCALATION_GRANT_MISSING_TEXT =
  'This Bash call was approved to run outside the sandbox, but the approval no longer matches: the device, its outside-sandbox setting or this conversation\'s permission scope changed since it was approved, so it did not run. Call Bash again with sandbox: "escalated" and a justification to ask again, or call it without sandbox to run it inside the sandbox.';
/** {@link ESCALATION_GRANT_MISSING_TEXT} as the reason of a refused background start. */
export const ESCALATION_GRANT_MISSING_LAUNCH_WHY =
  'its approval to run outside the sandbox no longer matches (the device, its outside-sandbox setting or the permission scope changed since it was approved); call Bash again with sandbox: "escalated" and a justification to ask again';
/** A request the machine never got: it reconnected, or its instance was gone, before it was sent. */
export const DEVICE_REQUEST_NOT_SENT_TOOL_TEXT =
  "The device's machine reconnected or changed before this operation was sent, so nothing ran. Retry the tool call.";
/** The device itself refused: it cannot enforce its sandbox (`SandboxPermissionUnsupportedError`). */
export const PERMISSION_UNSUPPORTED_TOOL_TEXT =
  "This device refused to run the operation because it cannot enforce its sandbox limits, so nothing ran. Ask the device's owner to update its device program (or a super admin to update its device plugin), or continue without the device.";
/** Earlier work on the device blocks a new operation (`SandboxWorkUnsettledError`). */
export const WORK_UNSETTLED_TOOL_TEXT =
  "Earlier work on this device has not settled yet, so nothing ran. Retry in a moment; if it keeps happening, ask the device's owner to stop the device's background tasks or restart its device program.";
export { PermissionAdmissionUnavailable };
/**
 * Admission's refusal on a device without permission-scoped operations
 * ({@link PermissionAdmissionUnavailable}): rendered from the cause, never from a provider's text.
 */
export function admissionUnavailableText(cause: PermissionAvailabilityCause): string {
  if (cause.kind === "provider-outdated")
    return `This device's sandbox plugin (${cause.plugin} ${cause.version}) cannot run device tools under a permission profile, so nothing ran. A super admin updates the plugin on the Plugins page; until then, continue without the device, or ask the user to start a new conversation on another device.`;
  return "This device's runtime cannot enforce its sandbox, so nothing ran. Ask the device's owner to update its device program (or a super admin to update its device plugin), or continue without the device.";
}
/**
 * A device refused an operation scope as invalid (`SandboxScopeValidationError`): the kernel only
 * sends scopes it validated, so this is a kernel invariant break (or a skewed device), never the
 * model's doing; whether anything ran is not proven.
 */
export const SCOPE_INVALID_TOOL_TEXT =
  "The device refused this operation as malformed, which points to a problem in the platform itself, not in the request. Tell the user the device rejected the operation and that it should be reported; do not retry it unchanged.";
/**
 * A device request whose machine came back as a new run of its device program before answering
 * (`DeviceProgramRestartedError`, also as the cause of an unknown outcome): its result is lost.
 */
export const DEVICE_PROGRAM_RESTARTED_TOOL_TEXT =
  "The device program restarted on the machine serving this device while this operation was in progress, so its result is lost and whether it ran, or how far, is unknown. Check the device's state (for example with Read, Glob or TaskList), then run it again if it is still needed; do not repeat an operation that must not run twice.";
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

/** The provider connection failure behind an unknown outcome, with the raw error to log. */
function unreachableCause(
  cause: unknown,
): { failure: "connect" | "dropped"; err: unknown } | undefined {
  if (cause instanceof SandboxProviderUnreachableError)
    return { failure: cause.failure, err: cause.cause };
  const failure = providerConnectionFailure(cause);
  return failure ? { failure, err: cause } : undefined;
}

export { DEVICE_OF_ANOTHER_ACCOUNT_TEXT } from "./device-owner.js";

export function mapSandboxError(e: unknown, log: Pick<Logger, "warn"> | undefined): unknown {
  if (e instanceof ManagedDeviceContextStale)
    return new ToolError(MANAGED_DEVICE_CONTEXT_STALE_TEXT, { kind: "unavailable" });
  if (e instanceof ManagedDeviceContextUnavailable)
    return new ToolError(MANAGED_DEVICE_CONTEXT_UNAVAILABLE_TEXT, { kind: "unavailable" });
  if (e instanceof ManagedDeviceContextFailed)
    return new ToolError(MANAGED_DEVICE_CONTEXT_FAILED_TEXT, { kind: "unavailable" });
  // the machine came back as a new program run: the request's result can never arrive
  if (isDeviceProgramRestarted(e)) {
    log?.warn("device program restarted before answering", { err: e, outcome: "unknown" });
    return new ToolError(DEVICE_PROGRAM_RESTARTED_TOOL_TEXT, { kind: "unavailable" });
  }
  // the managed route's typed refusals (unknown first: it never proves the operation had no effect)
  if (isSandboxOperationOutcomeUnknownError(e)) {
    // the provider could not be reached after the durable dispatch: the ledger keeps the outcome
    // unknown, the model gets the actionable connection text (a connection never made did
    // nothing; a broken one may have acted)
    const unreachable = unreachableCause((e as { cause?: unknown }).cause);
    if (unreachable) {
      log?.warn("sandbox provider unreachable", { ...unreachable, outcome: "unknown" });
      if (unreachable.failure === "connect")
        return new ToolError(SANDBOX_UNREACHABLE_TEXT, { kind: "unavailable" });
      return new ToolError(SANDBOX_CONNECTION_DROPPED_TEXT, { kind: "unavailable" });
    }
    log?.warn("sandbox operation outcome unknown", { err: e });
    return new ToolError(OUTCOME_UNKNOWN_TOOL_TEXT, { kind: "unavailable" });
  }
  // a connected dial-in machine that never answered (the relay's give-up): it may have acted
  if (isDialInAnswerTimeoutError(e)) {
    log?.warn("dial-in machine did not answer in time", { err: e });
    return new ToolError(OUTCOME_UNKNOWN_TOOL_TEXT, { kind: "unavailable" });
  }
  // a dial-in provider's machine is not connected (the SDK's error, from any provider)
  if (isDeviceOfflineError(e)) return new ToolError(DEVICE_OFFLINE_TEXT);
  // kernel-typed, before the scope refusal it extends: nothing was sent, a retry is safe
  if (isDeviceRequestNotSent(e))
    return new ToolError(DEVICE_REQUEST_NOT_SENT_TOOL_TEXT, { kind: "unavailable" });
  if (isEscalationGrantMissing(e)) {
    log?.warn("sandbox escalation grant no longer matches", { err: e });
    return new ToolError(ESCALATION_GRANT_MISSING_TEXT);
  }
  if (isSandboxScopeValidationError(e)) {
    log?.warn("kernel invariant broken: the device refused an operation scope as invalid", {
      err: e,
    });
    return new ToolError(SCOPE_INVALID_TOOL_TEXT);
  }
  if (isSandboxScopeDeniedError(e)) {
    log?.warn("sandbox operation outside its scope", { err: e });
    return new ToolError(SCOPE_DENIED_TOOL_TEXT);
  }
  // admission's own refusal and the unsettled refusal before the device's refusal they extend
  if (e instanceof PermissionAdmissionUnavailable) {
    log?.warn("device work refused: the device cannot run permission-scoped operations", {
      err: e,
    });
    return new ToolError(admissionUnavailableText(e.cause));
  }
  if (isSandboxWorkUnsettledError(e)) {
    log?.warn("device refused: earlier work is not settled", { err: e });
    return new ToolError(WORK_UNSETTLED_TOOL_TEXT);
  }
  if (isSandboxPermissionUnsupportedError(e)) {
    log?.warn("device refused: it cannot enforce its sandbox", { err: e });
    return new ToolError(PERMISSION_UNSUPPORTED_TOOL_TEXT);
  }
  if (e instanceof SandboxProviderUnreachableError) {
    log?.warn("sandbox provider unreachable", { failure: e.failure, err: e.cause });
    if (e.failure === "connect") {
      return new ToolError(SANDBOX_UNREACHABLE_TEXT, { kind: "unavailable" });
    }
    return new ToolError(SANDBOX_CONNECTION_DROPPED_TEXT, { kind: "unavailable" });
  }
  if (e instanceof RetirementPendingError) {
    return new ToolError(retirementToolText(e.code));
  }
  if (e instanceof ApiError) {
    if (e.code === "sandbox.busy") return new ToolError(BUSY_TEXT);
    if (e.code === "sandbox.unavailable") {
      const reason = (e.details?.[0] as { reason?: unknown } | undefined)?.reason;
      if (reason === ANONYMOUS_NO_DEVICE) return new ToolError(ANONYMOUS_TEXT);
      if (reason === NO_DEVICE) return new ToolError(NO_DEVICE_TEXT);
      return new ToolError(NO_SANDBOX_TEXT);
    }
    const detail = e.details?.[0] as { reason?: unknown } | undefined;
    if (e.code === "device.not_found") return new ToolError(ENV_NOT_FOUND_TEXT);
    if (e.code === "device.forbidden" && detail?.reason === "machine_revoked") {
      return new ToolError(DEVICE_REVOKED_TEXT);
    }
    if (e.code === "device.forbidden") return new ToolError(ENV_FORBIDDEN_TEXT);
    if (e.code === "device.unavailable") return new ToolError(ENV_UNAVAILABLE_TEXT);
    if (e.code === "device.files_lost") return new ToolError(ENV_FILES_LOST_TEXT);
    if (e.code === "device.offline") return new ToolError(DEVICE_OFFLINE_TEXT);
    if (e.code === "device.program_outdated") return new ToolError(DEVICE_OUTDATED_TEXT);
    if (e.code === "device.outside_sandbox_not_allowed")
      return new ToolError(OUTSIDE_SANDBOX_CEILING_TOOL_TEXT);
    if (e.code === "org.outside_sandbox_not_allowed")
      return new ToolError(ORG_OUTSIDE_SANDBOX_OFF_TOOL_TEXT);
    if (e.code === "deployment.outside_sandbox_not_allowed")
      return new ToolError(PLATFORM_OUTSIDE_SANDBOX_OFF_TOOL_TEXT);
    if (e.code === "device.permission_reconcile_required") {
      return new ToolError(RECONCILE_REQUIRED_TEXT, { kind: "unavailable" });
    }
    if (e.code === "sandbox.open_network_refused") {
      return new ToolError(SANDBOX_OPEN_NETWORK_REFUSED_TEXT);
    }
    if (e.code === "sandbox.create_failed") return new ToolError(SANDBOX_CREATE_FAILED_TEXT);
  }
  // an operation outside the sandbox service's own mapping (it records lost files itself)
  if (isFileSystemGoneError(e)) return new ToolError(ENV_FILES_LOST_TEXT);
  if (e instanceof DeviceProtocolError) return new ToolError(deviceProtocolText(e.message));
  if (e instanceof SandboxLockLostError) return new ToolError(LOCK_LOST_TEXT);
  if (e instanceof SandboxPathBusyError) return new ToolError(PATH_BUSY_TEXT);
  return e;
}

/**
 * The device entry of every builtin tool (B-17): runs `fn` in the device of the call's
 * conversation (a sub-agent: its root's) on the managed operation route
 * ({@link inSandboxOperations}): the device resolved and checked for the conversation's owner
 * (binding an unbound conversation to the owner's default first), the marked device paths
 * recorded before the callback, every provider call a managed operation. It never touches
 * attachments: `FetchAttachment` is the only way one enters the device. Returns the value and the
 * notices to put before the result (first use, a new instance).
 */
export async function inToolSandbox<T>(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  fn: (s: SandboxSession) => Promise<T>,
): Promise<{ value: T; notices: string[] }> {
  return inSandboxOperations(deps, ctx, fn);
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
  return inSandboxWith(deps, ctx, fn, stage);
}
/**
 * Trusted copy callbacks only receive preparation's three methods: the copy is a trusted
 * preparation on the managed route, scoped to `roots`, after the marked device paths.
 */
export async function inSandboxPreparation<T>(
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
  stage?: {
    purpose: SandboxPreparationScope["purpose"];
    roots: (roots: SandboxRoots) => readonly string[];
    run: (s: PreparationSession) => Promise<void>;
  },
): Promise<{ value: T; notices: string[] }> {
  // a run another account triggered never uses the owner's device: refused first
  assertDeviceOfRunAccount(ctx);
  try {
    const managed = deps.managedDeviceContext;
    const deviceId = await deps.devices.forTool(ctx.orgId, sandboxConversationOf(ctx));
    // a call the review covered runs in the working root it was reviewed against
    const reviewed = ctx.reviewedWorkingRoot;
    const claim = ctx.executionClaim;
    if (!claim || !ctx.runId || claim.runId !== ctx.runId)
      throw new SandboxScopeDeniedError("The tool has no current server execution claim");
    return await deps.sandbox.withOperations(
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
      {
        claim,
        callId: ctx.callId,
        deadlineMs: Math.min(ctx.runDeadline ?? Infinity, Date.now() + 30000),
        contextEvidence: true,
        beforeUser: async (staging, info, sig) => {
          // the held instance's device paths, recorded before any preparation or user callback
          // no installed evidence to describe the held instance: unavailable, not stale
          // (a device or machine that is gone for good says so instead)
          if (!info.contextEvidence)
            throw (
              (ctx.runId !== undefined &&
                (await managed.goneFor?.(
                  {
                    orgId: ctx.orgId,
                    conversationId: ctx.conversationId,
                    runId: ctx.runId,
                    accountId: ctx.accountId,
                  },
                  deviceId,
                ))) ||
              new ManagedDeviceContextUnavailable()
            );
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
          if (stage)
            await staging.prepare(stage.purpose, stage.roots(info.roots), (p, signal) =>
              stage.run({ deviceId, roots: info.roots, p, signal }),
            );
          sig.throwIfAborted();
        },
      },
      async (h, p, info, signal) => {
        // the held evidence the callback was admitted with (beforeUser refuses without it)
        const evidence = info.contextEvidence;
        if (!evidence) throw new ManagedDeviceContextUnavailable();
        const s: SandboxSession = {
          deviceId,
          h,
          roots: info.roots,
          // a managed call runs in the working root its device context recorded (admission's),
          // which a reviewed call's root equals (checked before the callback, B-18)
          workingRoot: evidence.workingRoot,
          p,
          signal,
        };
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
 * The conversation whose device a call uses (sub-agents spec §10.1, agent map spec §6): the tree
 * root for a sub-agent's call at any depth, the conversation itself otherwise.
 */
export const sandboxConversationOf = (ctx: BuiltinCallContext): string => ctx.rootConversationId;

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
 * Whether a sandbox tool call of the conversation tree rooted at `conversationId` can run
 * (ruling R8): the conversation's device (an unbound one: the device it would bind to) has its
 * provider on in the org. Without a conversation: some device provider is on in the org
 * ({@link ConversationDevices.usableNow}).
 */
export async function sandboxUsable(
  deps: Pick<SandboxToolDeps, "devices">,
  orgId: string,
  conversationId: string | undefined,
): Promise<boolean> {
  return deps.devices.usableNow ? deps.devices.usableNow(orgId, conversationId) : true;
}

/** The model-facing text of each {@link DeviceUnusableReason}. */
const UNUSABLE_TEXT: Record<DeviceUnusableReason, string> = {
  "provider-off": ENV_UNAVAILABLE_TEXT,
  "no-device": NO_DEVICE_TEXT,
  none: NO_SANDBOX_TEXT,
};

/**
 * Why a sandbox tool call of the tree rooted at `conversationId` cannot run, as model-facing text,
 * or null when it can ({@link ConversationDevices.unusableReason}): the conversation's device has
 * its provider off ({@link ENV_UNAVAILABLE_TEXT}), it has no device while providers are on
 * ({@link NO_DEVICE_TEXT}), or no device provider is on in the org ({@link NO_SANDBOX_TEXT}). A
 * stub with only `usableNow` reads a false answer as the last.
 */
export async function sandboxUnusableText(
  deps: Pick<SandboxToolDeps, "devices">,
  orgId: string,
  conversationId: string | undefined,
): Promise<string | null> {
  const reason = await sandboxUnusableReason(deps, orgId, conversationId);
  return reason === null ? null : UNUSABLE_TEXT[reason];
}

/**
 * The tool error of a call whose conversation's device cannot run ({@link sandboxUnusableText}),
 * or null when it can.
 */
export async function sandboxUnusableError(
  deps: Pick<SandboxToolDeps, "devices">,
  orgId: string,
  conversationId: string | undefined,
): Promise<ToolError | null> {
  const reason = await sandboxUnusableReason(deps, orgId, conversationId);
  if (reason === null) return null;
  if (reason === "provider-off") return new ToolError(ENV_UNAVAILABLE_TEXT);
  if (reason === "no-device") return new ToolError(NO_DEVICE_TEXT);
  return noSandboxError();
}

/** {@link ConversationDevices.unusableReason}, read from a stub's `usableNow` when it has only that. */
export async function sandboxUnusableReason(
  deps: Pick<SandboxToolDeps, "devices">,
  orgId: string,
  conversationId: string | undefined,
): Promise<DeviceUnusableReason | null> {
  if (deps.devices.unusableReason) return deps.devices.unusableReason(orgId, conversationId);
  return (await sandboxUsable(deps, orgId, conversationId)) ? null : "none";
}

/**
 * The reason the registry reports the sandbox tools unavailable with, or null when they can run
 * ({@link sandboxUnusableText}; the listing passes the root conversation of the run). An eval replay
 * lists them as available (`replay`: its calls are never executed). `memo` (one per listing)
 * makes every sandbox tool of a listing share one answer.
 */
export const unavailableWhenNoSandbox =
  (deps: Pick<SandboxToolDeps, "sandbox" | "devices">) =>
  async (ctx: ToolListingScope): Promise<string | null> => {
    if (ctx.replay === true) return null;
    const key = "sandboxUsable";
    let text = ctx.memo?.get(key) as Promise<string | null> | undefined;
    if (text === undefined) {
      text = sandboxUnusableText(deps, ctx.orgId, ctx.conversationId);
      ctx.memo?.set(key, text);
    }
    const t = await text;
    // the listing's reason has no final period
    return t === null ? null : t.slice(0, -1);
  };

/** 读出的字节是否像二进制（开头 8 KB 里有 NUL）。 */
export function looksBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8192).includes(0);
}
