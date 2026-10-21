import {
  type SandboxHandle,
  type SandboxProvider,
  ToolError,
  validateSandboxPath,
} from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../../../config/schema.js";
import type { AttachmentsService } from "../../../conversations/attachments.service.js";
import type { EventLog } from "../../../conversations/event-log.js";
import { ApiError } from "../../../errors.js";
import { SandboxLockLostError, type SandboxService } from "../../../sandbox/sandbox.service.js";
import type { StorageService } from "../../../storage/storage.service.js";
import type { BuiltinCallContext } from "../../registry.js";

/** 沙箱工具的依赖（都按调用时取，多副本下无进程内状态）。 */
export interface SandboxToolDeps {
  sandbox: Pick<SandboxService, "available" | "withSandbox">;
  attachments: Pick<AttachmentsService, "listForConversation" | "openForConversation">;
  storage: Pick<StorageService, "kernel">;
  eventLog: Pick<EventLog, "append">;
  config: () => KernelConfig;
}

/** 回调拿到的沙箱：句柄、提供方与「调用 signal + 锁丢失」合并后的 signal（每个提供方调用都传它）。 */
export interface SandboxSession {
  h: SandboxHandle;
  p: SandboxProvider;
  signal: AbortSignal;
}

// ---- 模型可见文案（英文） ----

/** 没有沙箱提供方时「工具不可用」的原因（进提醒与调用结果）。 */
export const SANDBOX_UNAVAILABLE_REASON =
  "no sandbox is configured in this deployment; ask an administrator to install a sandbox plugin, or do the task without the sandbox";
/** 本对话第一次用沙箱。 */
export const SANDBOX_STARTED_NOTICE =
  "Sandbox started for this conversation (first use); the working directory is /workspace.";
/** 沙箱被重建（之前的实例已销毁或不在了）。 */
export const SANDBOX_RECREATED_NOTICE = "Sandbox was recreated; previous files are gone.";

const BUSY_TEXT =
  "The sandbox is busy with another command in this conversation; wait for it to finish and retry.";
const NO_SANDBOX_TEXT =
  "No sandbox is configured in this deployment; ask an administrator to install a sandbox plugin, or do the task without the sandbox.";
const LOCK_LOST_TEXT =
  "The sandbox operation was interrupted because the sandbox lock was lost; check the sandbox state and retry.";

/** 沙箱里附件所在目录。 */
export const ATTACHMENTS_DIR = "/workspace/attachments";
/** 已同步附件的标记文件：`{ <附件 id>: <文件名> }`。 */
export const SYNC_MARKER = `${ATTACHMENTS_DIR}/.capybara-sync.json`;
const MARKER_MAX_BYTES = 1024 * 1024;
const NAME_MAX_CHARS = 200;

/** 沙箱工具执行时限的余量：等锁与创建 / 恢复沙箱（`tools.timeoutMs + sandbox.lockWaitSeconds`）。 */
export const sandboxBaseTimeoutMs = (cfg: KernelConfig): number =>
  cfg.tools.timeoutMs + cfg.sandbox.lockWaitSeconds * 1000;

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

/** 校验沙箱内路径（`validateSandboxPath`）；不合法抛给模型可执行的错误。 */
export function checkPath(path: string, field = "path"): string {
  const errors = validateSandboxPath(path);
  if (errors.length > 0) {
    throw new ToolError(
      `Invalid ${field} "${clip(path, 200)}": ${errors.join("; ")}. Pass an absolute path under /workspace, /skills or /tmp.`,
    );
  }
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** 写入类工具的路径：`/skills` 是技能文件的只读副本。 */
export function checkWritable(path: string): string {
  const p = checkPath(path);
  if (p === "/skills" || p.startsWith("/skills/")) {
    throw new ToolError(
      `Path ${clip(p, 200)} is read-only (/skills holds skill files); pass a path under /workspace or /tmp instead.`,
    );
  }
  return p;
}

/** POSIX shell 单引号转义。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const utf8 = new TextEncoder();

/** 把一个文件名清理成单个安全的路径段（控制字符、`/`、`\` 换成 `_`），过长时保留扩展名截断。 */
function sanitizeName(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要换掉控制字符
  let n = raw.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim();
  if (n === "" || n === "." || n === "..") return "attachment";
  const cps = [...n];
  if (cps.length > NAME_MAX_CHARS) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 20 ? n.slice(dot) : "";
    n = cps.slice(0, NAME_MAX_CHARS - [...ext].length).join("") + ext;
  }
  return n;
}

/**
 * 给附件分配沙箱里的文件名（按给定顺序，确定性）：清理成安全的路径段，与 `used`（已同步的）及彼此不重名，
 * 重名时加 `-2`、`-3`……（加在扩展名之前）。清理后仍不是合法沙箱路径的用 `attachment-<id 前 8 位>`。
 */
export function assignAttachmentNames(
  items: readonly { id: string; name: string }[],
  used: ReadonlySet<string>,
): Map<string, string> {
  const taken = new Set(used);
  taken.add(SYNC_MARKER.slice(ATTACHMENTS_DIR.length + 1));
  const out = new Map<string, string>();
  for (const a of items) {
    let base = sanitizeName(a.name);
    if (validateSandboxPath(`${ATTACHMENTS_DIR}/${base}`).length > 0) {
      base = `attachment-${a.id.slice(0, 8)}`;
    }
    let name = base;
    if (taken.has(name)) {
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      for (let i = 2; taken.has(name); i++) name = `${stem}-${i}${ext}`;
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

/**
 * 把本对话已 ready 的附件复制到 `/workspace/attachments/<name>`，标记文件记下已复制的（不重复复制）。
 * `reset`（新建 / 重建的沙箱，文件已不在）时忽略标记文件全部重新复制。对象已不在的附件跳过（下次再试）。
 * 返回本次复制的沙箱路径。
 */
async function syncAttachments(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  s: SandboxSession,
  reset: boolean,
): Promise<string[]> {
  const list = await deps.attachments.listForConversation(ctx.orgId, ctx.conversationId);
  if (list.length === 0) return [];
  let marker: Record<string, string> = {};
  if (!reset) {
    const m = await s.p.readFile(s.h, SYNC_MARKER, {
      maxBytes: MARKER_MAX_BYTES,
      signal: s.signal,
    });
    if (m && !m.truncated) marker = parseMarker(m.data);
  }
  const pending = list.filter((a) => !Object.hasOwn(marker, a.id));
  if (pending.length === 0) return [];
  const names = assignAttachmentNames(pending, new Set(Object.values(marker)));
  const copied: string[] = [];
  for (const a of pending) {
    const opened = await deps.attachments.openForConversation(ctx.orgId, ctx.conversationId, a.id);
    if (!opened) continue;
    const bytes = new Uint8Array(await new Response(opened.body).arrayBuffer());
    const name = names.get(a.id) as string;
    const path = `${ATTACHMENTS_DIR}/${name}`;
    await s.p.writeFile(s.h, path, bytes, s.signal);
    marker[a.id] = name;
    copied.push(path);
  }
  if (copied.length > 0) {
    await s.p.writeFile(s.h, SYNC_MARKER, utf8.encode(JSON.stringify(marker)), s.signal);
  }
  return copied;
}

/** 沙箱服务的错误 → 给模型的可执行说明；其余原样抛出（管线按「工具失败」处理）。 */
function mapError(e: unknown): unknown {
  if (e instanceof ApiError) {
    if (e.code === "sandbox.busy") return new ToolError(BUSY_TEXT);
    if (e.code === "sandbox.unavailable") return new ToolError(NO_SANDBOX_TEXT);
  }
  if (e instanceof SandboxLockLostError) return new ToolError(LOCK_LOST_TEXT);
  return e;
}

/**
 * 在本对话的沙箱上执行 `fn`（`SandboxService.withSandbox`：懒创建、恢复、重建）：先同步附件，
 * 再执行；返回结果与要加在结果开头的状态说明（首次使用 / 重建 / 新复制的附件）。
 * `withSandbox` 遇到实例不在时会重建并再调用一次回调，说明按最后一次调用的为准。
 */
export async function inSandbox<T>(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  fn: (s: SandboxSession) => Promise<T>,
): Promise<{ value: T; notices: string[] }> {
  try {
    return await deps.sandbox.withSandbox(
      { orgId: ctx.orgId, conversationId: ctx.conversationId },
      async (h, p, info, signal) => {
        const s = { h, p, signal };
        const notices: string[] = [];
        if (info.recreated) notices.push(SANDBOX_RECREATED_NOTICE);
        else if (info.fresh) notices.push(SANDBOX_STARTED_NOTICE);
        const copied = await syncAttachments(deps, ctx, s, info.fresh || info.recreated);
        if (copied.length > 0) {
          notices.push(`Attachments copied into the sandbox: ${copied.join(", ")}.`);
        }
        return { value: await fn(s), notices };
      },
      ctx.signal,
    );
  } catch (e) {
    throw mapError(e);
  }
}

/** 本部署是否有沙箱：没有时返回「不可用」原因（注册表据此把沙箱工具报为不可用）。 */
export const unavailableWhenNoSandbox =
  (deps: Pick<SandboxToolDeps, "sandbox">) => (): string | null =>
    deps.sandbox.available ? null : SANDBOX_UNAVAILABLE_REASON;

/** 读出的字节是否像二进制（开头 8 KB 里有 NUL）。 */
export function looksBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8192).includes(0);
}
