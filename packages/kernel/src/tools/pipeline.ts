import {
  type AuthInjection,
  type ConnectorSession,
  type FormAnswer,
  type InputForm,
  type InputRequired,
  type Logger,
  type ToolDisplay,
  ToolError,
  validateInputForm,
  validateToolDisplay,
} from "@capybara-hq/plugin-sdk";
import type { AgentDefinition } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import type { OrgRole } from "../orgs/roles.js";
import { clipText } from "../plugins/hooks.js";
import { PLUGIN_UNLOADED_TOOL_ERROR, PluginUnloadedError } from "../plugins/inflight.js";
import { UNKNOWN_RESULT_TEXT } from "../runtime/context/pairing.js";
import {
  type AuditEntry,
  type ConversationKindForHooks,
  fireObserve,
  type HookRunner,
  hookDeniedAudit,
  hookDeniedEvent,
  hookScope,
} from "../runtime/hook-calls.js";
import type { WaitingFor } from "../runtime/loop.js";
import { assistantIdemKey, MAX_MODEL_ATTEMPTS, modelCallIdemKey } from "../runtime/model-call.js";
import { skillLoadOffered } from "../skills/catalog.js";
import type { ApprovalRecord, ApprovalScope, ApprovalsService } from "./approvals.service.js";
import { type Breaker, breakerOpenMessage } from "./breaker.js";
import { isAlwaysLoaded, notLoadedText } from "./builtins/tool-search.js";
import { type ConnectorAuth, CredentialMissing, type Credentials } from "./credentials.js";
import { ElicitationSession } from "./elicitation.js";
import { renderResult, resolveOutputRefs, spillIfLarge, type ToolOutputs } from "./outputs.js";
import { createDecidePolicy } from "./policy.js";
import type { QuestionRecord, QuestionsService } from "./questions.service.js";
import { redactDeep, redactorFor } from "./redact.js";
import type { AgentTools, BuiltinCallContext, ResolvedTool, ToolRegistry } from "./registry.js";
import { runResourceTool } from "./resources.js";
import { validateInput } from "./validate.js";

// ---- 模型可见文案（英文） ----

/** 审批被拒绝。 */
export const APPROVAL_DENIED_TEXT = "The user denied this tool call.";
/** 审批超时（按拒绝）。 */
export const approvalExpiredText = (hours: number) =>
  `Approval timed out after ${hours}h; treated as denied.`;
/** 等待审批期间 run 被中止。 */
export const APPROVAL_CANCELLED_TEXT = "The run was stopped while waiting for approval.";
/** 等待用户输入期间 run 被中止。 */
export const INPUT_CANCELLED_TEXT = "The run was stopped while waiting for user input.";
/** 同一调用连续请求输入超过上限。 */
export const TOO_MANY_INPUT_REQUESTS_TEXT = "Tool requested user input too many times.";
/** run 已被中止 / 到达截止时间，调用尚未开始执行。 */
export const RUN_STOPPED_TEXT = "The run was stopped before this tool call was executed.";
/** 调用执行中 run 被中止 / 到达截止时间。 */
export const RUN_STOPPED_DURING_TEXT =
  "The run was stopped while this tool call was running; its outcome is unknown. Verify before retrying.";

const timeoutText = (key: string, ms: number) =>
  `Tool ${key} timed out after ${ms / 1000}s. The operation may or may not have completed; verify before retrying.`;
const failedText = (key: string, errName: string) =>
  `Tool ${key} failed (${errName}). The operation may not have completed; check before retrying or try another approach.`;
const unknownToolText = (name: string, keys: string[], toolSearch: boolean) =>
  `Unknown tool "${name}". Available tools: ${keys.length === 0 ? "(none)" : keys.join(", ")}.` +
  (toolSearch ? " Use tool_search to load other tools." : "");
const unavailableText = (name: string, reason: string) =>
  `Tool "${name}" is unavailable: ${reason}.`;
const deniedText = (key: string) => `Tool ${key} is denied by policy.`;
/** Longest hook reason quoted in {@link hookDeniedText}. */
const HOOK_REASON_MAX = 500;
/**
 * A plugin policy hook denied the call (model-visible). `reason` is the sanitized deny reason, or the
 * generic sentence for a hook error / timeout; truncated to 500 characters.
 */
export const hookDeniedText = (plugin: string, reason: string): string =>
  `Tool call blocked by the "${plugin}" policy hook: ${clipText(reason, HOOK_REASON_MAX)}`;
const invalidFormText = (key: string, problems: string[]) =>
  `Tool ${key} returned an invalid input form: ${problems.join("; ")}.`;
const stateTooLargeText = (key: string) =>
  `Tool ${key} returned input state larger than ${MAX_INPUT_STATE_BYTES / 1024} KB.`;
const personalMissingText = (connectorName: string) =>
  `The user has not connected ${connectorName}. A connect card was shown; ask the user to connect, then retry.`;
const orgMissingText = (connectorName: string) =>
  `${connectorName} has no organization credential configured; ask an organization admin to set it up.`;

// ---- 策略（判定见 policy.ts） ----

/** 需要人审批的请求（`ApprovalsService.request` 据此建审批记录）。 */
export interface AskRequest {
  toolKey: string;
  /** 所批准的工具定义指纹（「本会话 / 以后都允许」授权按它匹配）。 */
  specHash: string;
  /** 连接器工具的来源连接器；插件 / 内置工具为 null。 */
  connectorId: string | null;
  /** 指定处理人（发起人本人）；按角色升级时为 null。 */
  requestedFor: string | null;
  /** 按角色升级（R1）时所需的角色；否则为 null。 */
  approverRole: OrgRole | null;
}

/**
 * `unavailable`：调用那一刻工具已不可用（连接器 / 工具不存在、停用、删除、待审核），值为事实原因；
 * 管线写「工具不可用」说明，而不是「策略拒绝」。
 */
export type PolicyDecision =
  | "allow"
  | "deny"
  | { ask: AskRequest }
  | { unavailable: string }
  /** 记住的授权把 `ask` 放行（按 allow 执行，审计记授权种类）。 */
  | { grant: "session" | "always" };

export interface PolicyContext {
  orgId: string;
  /** 对话发起人。 */
  accountId: string;
  agentId: string;
  conversationId: string;
  runId: string;
}

/** 管线第 3 阶段：策略判定。 */
export type DecidePolicy = (
  tool: ResolvedTool,
  agentDef: AgentDefinition,
  ctx: PolicyContext,
) => Promise<PolicyDecision>;

// ---- 管线 ----

/** 测试钩子。 */
export interface ToolPipelineHooks {
  /** 工具执行返回之后、结果写入日志之前调用：抛错即模拟「工具已执行、结果未记录」时进程崩溃。 */
  afterExecute?(runId: string, callId: string): Promise<void>;
}

export interface ToolPipelineDeps {
  db: KernelDb;
  eventLog: EventLog;
  registry: Pick<ToolRegistry, "forAgent" | "findConnector" | "handler">;
  credentials: Pick<Credentials, "injection" | "onUnauthorized">;
  breaker: Pick<Breaker, "check" | "failure" | "success">;
  outputs: Pick<ToolOutputs, "save" | "load">;
  /** 策略为 `ask` 时建审批；续跑时读该调用的审批结果。 */
  approvals: Pick<ApprovalsService, "request" | "forCall">;
  /** 处理函数返回 `input_required` 时建输入请求；续跑时读该调用的各轮输入请求。 */
  questions: Pick<QuestionsService, "ask" | "forCall">;
  config: () => KernelConfig;
  log: Logger;
  /** 默认 {@link createDecidePolicy}（执行时实时读取策略与授权）。 */
  decidePolicy?: DecidePolicy;
  hooks?: ToolPipelineHooks;
  /**
   * Plugin hooks (`tool.preExecute` policy / observe after policy and approval, `tool.postExecute`
   * observe after the result). Only the chat pipeline gets it; the eval replay uses
   * `RecordedToolPipeline`, which never runs hooks. Also needs `conversationKind: "chat"` (P-18).
   */
  pluginHooks?: HookRunner;
  /**
   * 连接器在调用途中报告工具清单变了（MCP `notifications/tools/list_changed`）：内核安排一次该连接器的漂移检查。
   * 不等待、不抛错（实现自己吞掉错误）。
   */
  onToolsChanged?: (orgId: string, connectorId: string) => void;
}

/** tools 节点处理一步工具调用所需的上下文。 */
export interface ToolStepContext {
  orgId: string;
  conversationId: string;
  runId: string;
  step: number;
  agentId: string;
  /** 运行所用的 agent 版本（审计链记录）。 */
  agentVersion: number;
  agent: AgentDefinition;
  /** 对话发起人（取个人凭据、审计 actor）。 */
  accountId: string;
  /** run 的中止信号（用户中止 / 截止时间）。 */
  signal: AbortSignal;
  /** run 的截止时间（epoch 毫秒）；传给内置工具（沙箱命令据此收紧超时，Ruling M20）。 */
  deadline?: number;
  /** Hooks fire only for `chat` conversations. */
  conversationKind?: ConversationKindForHooks;
}

/** tools 节点一步的结果：全部调用都有了结果，或某个调用需要等人处理（之后的调用留到续跑）。 */
export type ToolStepOutcome = { kind: "done" } | { kind: "suspended"; waitingFor: WaitingFor };

/** 续跑时带给处理函数的上一轮输入请求结果（`ctx.resume`）。 */
export type ToolResume = { state: unknown; answer: FormAnswer | null };

/** 执行阶段的结果。 */
export type ExecOutcome =
  /** 工具返回了结果（可能是工具自己报告的错误，或畸形结果，由渲染阶段处理）。 */
  | { kind: "result"; result: unknown }
  /** 处理函数需要用户输入（表单尚未校验）。 */
  | { kind: "input_required"; form: InputForm; state: unknown }
  /** 执行失败（超时、抛错、熔断、中止等），message 给模型看。 */
  | { kind: "error"; message: string }
  /** 发起人未连接个人凭据：除错误结果外再写 `connection_required`。 */
  | { kind: "connection_required"; connectorId: string; connectorName: string; message: string };

type ToolCall = { id: string; name: string; input: unknown };

/**
 * 审计链（spec 3.6 R6）里「凭什么放行」：在审批下执行（审批 id、批准人、范围）、记住的授权放行、或策略本身放行。
 * 续跑时「有开始无结果」的调用若没有已批准的审批，当时的放行依据已无从得知，不记（不猜）。
 */
type Authorization =
  | { approvalId: string; approvedByAccountId: string | null; scope: ApprovalScope | null }
  | { grant: "session" | "always" }
  | { policy: "allow" };

/** `tool.called` 审计的附加信息：传入即表示工具确实执行过（durationMs 为 null = 耗时未知）。 */
interface CallAudit {
  durationMs: number | null;
  connectorId: string | null;
  authorization?: Authorization;
}

const approvalAuthorization = (a: ApprovalRecord): Authorization => ({
  approvalId: a.id,
  approvedByAccountId: a.decidedBy,
  scope: a.scope,
});

/**
 * 幂等键（brief 约定）。同一调用因请求用户输入而被再次调用时，第 n（≥ 2）次调用的开始事件带轮次后缀。
 */
const idem = {
  started: (runId: string, callId: string, attempt = 1) =>
    attempt === 1
      ? `tool_started:${runId}:${callId}`
      : `tool_started:${runId}:${callId}:${attempt}`,
  result: (runId: string, callId: string) => `tool_result:${runId}:${callId}`,
  connection: (runId: string, callId: string) => `connection_required:${runId}:${callId}`,
  hookDenied: (runId: string, callId: string) => `hook_denied:${runId}:${callId}`,
};

/** 同一调用最多连续请求用户输入的次数。 */
const MAX_INPUT_ROUNDS = 3;
/** 输入请求 state 的上限（JSON 序列化后的字节数）。 */
const MAX_INPUT_STATE_BYTES = 16 * 1024;

/** 关闭会话时最多等待的时间（连接器 close 卡住不拖住运行）。 */
const CLOSE_WAIT_MS = 5_000;

const errName = (e: unknown): string =>
  e instanceof Error && typeof e.name === "string" && e.name !== "" ? e.name : "Error";

const isInputRequired = (v: unknown): v is InputRequired =>
  typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "input_required";

/**
 * 内置工具结果里的 `loadedTools`（见 `BuiltinResult`）：只保留本步可用、非内置的工具 key，去重、保持顺序。
 */
function loadedFrom(result: unknown, tools: readonly ResolvedTool[]): string[] {
  const raw = (result as { loadedTools?: unknown } | null)?.loadedTools;
  if (!Array.isArray(raw)) return [];
  const known = new Set(tools.filter((t) => !isAlwaysLoaded(t.key)).map((t) => t.key));
  return [...new Set(raw.filter((k): k is string => typeof k === "string" && known.has(k)))];
}

class Stopped extends Error {}

/** 在工具结果末尾附上说明（如被拒绝的 elicitation）；结果不是 `{ content: [] }` 形状时原样返回。 */
function withNotes(result: unknown, notes: readonly string[]): unknown {
  if (notes.length === 0) return result;
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return result;
  return {
    ...(result as object),
    content: [...content, ...notes.map((text) => ({ type: "text", text }))],
  };
}

type Resolved = AgentTools;

/** 审批的等待时长（小时，四舍五入，至少 1）。 */
const approvalHours = (a: ApprovalRecord): number =>
  Math.max(
    1,
    Math.round((new Date(a.expiresAt).getTime() - new Date(a.createdAt).getTime()) / 3_600_000),
  );

const approvalWait = (a: ApprovalRecord): WaitingFor => ({
  kind: "approval",
  id: a.id,
  expiresAt: a.expiresAt,
});
const inputWait = (q: QuestionRecord): WaitingFor => ({
  kind: "input",
  id: q.id,
  expiresAt: q.expiresAt,
});

/**
 * 工具执行管线（spec 5.4 / 6.2）：每个阶段是独立函数——
 * `resolveOutputRefs` → `validateInput` → `decidePolicy` → `execute`（超时、熔断）→ `renderResult` / `spillIfLarge`
 * → 写 `tool_result` 与审计。
 *
 * 有副作用不盲目重跑（spec 4.3）：执行前写 `tool_call_started`；续跑时「有开始无结果」的调用记为结果未知，不再执行。
 */
export class ToolPipeline {
  private readonly decide: DecidePolicy;

  constructor(private readonly deps: ToolPipelineDeps) {
    this.decide = deps.decidePolicy ?? createDecidePolicy(deps.db);
  }

  /**
   * tools 节点：按顺序处理本步 assistant 消息里的全部 `tool_call`，每个调用都以一条 `tool_result` 结束
   * （之后才回到 prepare 构建下一次请求，保持「已记录调用、未记录结果之间不构建请求」的不变式）。
   * 已有结果 → 跳过；有开始无结果 → 结果未知；run 已中止 → 不执行。
   * 某个调用需要等人处理（审批 / 用户输入）→ 返回 `suspended`，之后的调用留到续跑时处理；
   * 续跑时重新进入本函数，按 PG 里的审批 / 输入请求结果继续。
   */
  async runStep(ctx: ToolStepContext): Promise<ToolStepOutcome> {
    const { eventLog } = this.deps;
    const msg = await eventLog.findByIdem(
      ctx.conversationId,
      assistantIdemKey(ctx.runId, ctx.step),
    );
    if (msg?.type !== "assistant_message") return { kind: "done" };
    const calls = msg.payload.content.flatMap((b) =>
      b.type === "tool_call" ? [{ id: b.id, name: b.name, input: b.input }] : [],
    );
    let resolved: Resolved | undefined;
    const resolve = async (): Promise<Resolved> => {
      // 每步实时解析（连接器 / 插件状态可能在模型调用之后变化）
      if (!resolved) {
        // 与构建请求时同一判定：日志里有过技能目录快照 → skill_load 可用（空快照也不收回，见 skillLoadOffered）
        const skillLoad = skillLoadOffered(
          await this.deps.eventLog.latestOfType(ctx.conversationId, "skills_catalog"),
        );
        resolved = await this.deps.registry.forAgent(ctx.orgId, {
          tools: ctx.agent.tools ?? [],
          skillLoad,
        });
      }
      return resolved;
    };
    for (const call of calls) {
      if (await eventLog.findByIdem(ctx.conversationId, idem.result(ctx.runId, call.id))) continue;
      const waitingFor = await this.processCall(ctx, call, resolve);
      if (waitingFor) return { kind: "suspended", waitingFor };
    }
    return { kind: "done" };
  }

  /**
   * 处理一个尚无结果的调用。先看输入请求的轮次：最近一轮仍 pending → 继续等；否则本次是第
   * `已有轮数 + 1` 次调用，已有轮次时带 `ctx.resume`（answered → 答案，expired / cancelled → null）。
   * 本次调用「有开始无结果」→ 结果未知（spec 4.3）。返回需要等待的对象，或 undefined（已写结果）。
   */
  private async processCall(
    ctx: ToolStepContext,
    call: ToolCall,
    resolve: () => Promise<Resolved>,
  ): Promise<WaitingFor | undefined> {
    const rounds = await this.deps.questions.forCall(ctx.runId, call.id);
    const last = rounds.at(-1);
    if (last?.status === "pending") return inputWait(last);
    const attempt = rounds.length + 1;
    const started = await this.deps.eventLog.findByIdem(
      ctx.conversationId,
      idem.started(ctx.runId, call.id, attempt),
    );
    if (started?.type === "tool_call_started") {
      // 确实开始执行过：照样审计 tool.called（耗时未知）；放行依据只认批准了所执行定义的审批记录
      const key = started.payload.toolKey;
      const approval = await this.deps.approvals.forCall(ctx.runId, call.id);
      const approved =
        approval?.status === "approved" && approval.specHash === started.payload.specHash
          ? approval
          : null;
      const source = approved ? null : (await resolve()).tools.find((t) => t.key === key)?.source;
      await this.writeResult(
        ctx,
        call.id,
        key,
        { content: UNKNOWN_RESULT_TEXT, isError: true },
        [],
        {
          durationMs: null,
          connectorId: approved
            ? approved.connectorId
            : source?.kind === "connector"
              ? source.connectorId
              : null,
          ...(approved && { authorization: approvalAuthorization(approved) }),
        },
      );
      return undefined;
    }
    if (ctx.signal.aborted) {
      await this.writeResult(ctx, call.id, call.name, {
        content: RUN_STOPPED_TEXT,
        isError: true,
      });
      return undefined;
    }
    const resume: ToolResume | undefined = last
      ? { state: last.state, answer: last.status === "answered" ? last.answer : null }
      : undefined;
    return this.runCall(ctx, call, await resolve(), attempt, resume);
  }

  private async runCall(
    ctx: ToolStepContext,
    call: ToolCall,
    resolved: Resolved,
    attempt: number,
    resume: ToolResume | undefined,
  ): Promise<WaitingFor | undefined> {
    const fail = async (content: string, key = call.name): Promise<undefined> => {
      await this.writeResult(ctx, call.id, key, { content, isError: true });
      return undefined;
    };

    const tool = resolved.tools.find((t) => t.key === call.name);
    if (!tool) {
      const why =
        resolved.unavailable.find((u) => u.ref === call.name) ??
        resolved.hidden?.find((u) => u.ref === call.name);
      if (why) return fail(unavailableText(call.name, why.reason));
      let keys = resolved.tools.map((t) => t.key);
      // tool_search 模式：目录可能很大，只列内置工具与发出本次调用的请求里带了定义的工具
      if (resolved.toolSearch === true) {
        const sent = await this.sentTools(ctx);
        if (sent !== null) keys = keys.filter((k) => isAlwaysLoaded(k) || sent.has(k));
      }
      keys.sort();
      return fail(unknownToolText(call.name, keys, keys.includes("tool_search")));
    }
    // tool_search 模式下，模型只能调用请求里带了完整定义的工具：目录里有、但发出本次调用的请求没加载 →
    // 明确错误，不自动加载（spec 5.5 / 6.3）。同一步里先 tool_search 再调用刚加载的工具同样报错。
    if (resolved.toolSearch === true && !isAlwaysLoaded(tool.key)) {
      const sent = await this.sentTools(ctx);
      if (sent !== null && !sent.has(tool.key)) return fail(notLoadedText(tool.key), tool.key);
    }

    let input: unknown;
    try {
      input = await resolveOutputRefs(call.input, (id) =>
        this.deps.outputs.load({ orgId: ctx.orgId, conversationId: ctx.conversationId }, id),
      );
    } catch (e) {
      if (e instanceof ToolError) return fail(e.message, tool.key);
      throw e;
    }
    // 连接器工具的 schema 来自连接器（不受信任）：去掉有风险的关键字并限制大小 / 层数
    const invalid = validateInput(tool.key, tool.spec, input, {
      untrusted: tool.source.kind === "connector",
      log: this.deps.log,
    });
    if (invalid !== null) return fail(invalid, tool.key);

    const decision = await this.decide(tool, ctx.agent, {
      orgId: ctx.orgId,
      accountId: ctx.accountId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
    });
    if (decision === "deny") return fail(deniedText(tool.key), tool.key);
    if (typeof decision === "object" && "unavailable" in decision) {
      return fail(unavailableText(tool.key, decision.unavailable), tool.key);
    }
    // 该调用已有审批（续跑）→ 按审批结果；没有且策略为 ask → 建审批并等待
    // （不写 tool_call_started：此时尚未开始执行）。
    let approval = await this.deps.approvals.forCall(ctx.runId, call.id);
    // 批准的是旧定义（等待期间工具定义变了）：原批准不适用于当前定义，策略仍需审批时按新定义重新审批。
    const stale = approval?.status === "approved" && approval.specHash !== tool.specHash;
    if ((!approval || stale) && typeof decision === "object" && "ask" in decision) {
      approval = await this.deps.approvals.request({
        attempt: (approval?.attempt ?? 0) + 1,
        orgId: ctx.orgId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        step: ctx.step,
        callId: call.id,
        toolKey: tool.key,
        specHash: decision.ask.specHash,
        connectorId: decision.ask.connectorId,
        input: call.input,
        requestedFor: decision.ask.requestedFor,
        approverRole: decision.ask.approverRole,
      });
    }
    if (approval && approval.status !== "approved") {
      const refused = this.refusalText(approval);
      return refused === null ? approvalWait(approval) : fail(refused, tool.key);
    }
    // 走到这里即放行：在（与当前定义一致的）审批下执行，否则是授权或策略放行
    const authorization: Authorization =
      approval?.status === "approved" && approval.specHash === tool.specHash
        ? approvalAuthorization(approval)
        : typeof decision === "object" && "grant" in decision
          ? { grant: decision.grant }
          : { policy: "allow" };

    // tool.preExecute after policy and approval, before tool_call_started (F10)
    const hooks = this.deps.pluginHooks;
    const scope = hookScope(hooks, ctx);
    if (scope) {
      // sticky: a denial already logged for this call (e.g. an older log, or a crash right after it)
      // is final: fail with the recorded reason, never re-run the hooks or execute the tool
      const prior = await this.deps.eventLog.findByIdem(
        ctx.conversationId,
        idem.hookDenied(ctx.runId, call.id),
      );
      if (prior?.type === "hook_denied") {
        return fail(hookDeniedText(prior.payload.plugin, prior.payload.reason), tool.key);
      }
    }
    // payload only built when a tool hook is registered (zero overhead otherwise)
    const hookBase =
      scope && hooks && (hooks.has("tool.preExecute") || hooks.has("tool.postExecute"))
        ? {
            ...scope,
            step: ctx.step,
            callId: call.id,
            toolKey: tool.key,
            specHash: tool.specHash,
            input,
          }
        : null;
    if (hooks && hookBase && hooks.has("tool.preExecute")) {
      let verdict: Awaited<ReturnType<HookRunner["run"]>>;
      try {
        verdict = await hooks.run("tool.preExecute", hookBase, ctx.signal);
      } catch (e) {
        // run() rejects only when the run's signal aborted: an abort, never a deny
        if (ctx.signal.aborted) return fail(RUN_STOPPED_TEXT, tool.key);
        throw e;
      }
      if (!verdict.allowed) {
        // hook_denied, its audit entry and the tool_result in one transaction (no window where the
        // denial is logged but the call has no result)
        const site = {
          orgId: ctx.orgId,
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          accountId: ctx.accountId,
          agentId: ctx.agentId,
          idemKey: idem.hookDenied(ctx.runId, call.id),
        };
        const event = hookDeniedEvent(site, "tool.preExecute", verdict, {
          step: ctx.step,
          callId: call.id,
        });
        await this.writeResult(
          ctx,
          call.id,
          tool.key,
          { content: hookDeniedText(verdict.plugin, verdict.reason), isError: true },
          [event],
          undefined,
          [hookDeniedAudit(site, event.payload, verdict)],
        );
        return undefined;
      }
    }

    await this.deps.eventLog.append(ctx.conversationId, [
      {
        type: "tool_call_started",
        runId: ctx.runId,
        idemKey: idem.started(ctx.runId, call.id, attempt),
        payload: { step: ctx.step, callId: call.id, toolKey: tool.key, specHash: tool.specHash },
      },
    ]);
    const t0 = Date.now();
    let outcome = await this.execute(tool, input, ctx, call.id, resume, resolved.tools);
    const durationMs = Date.now() - t0;
    await this.deps.hooks?.afterExecute?.(ctx.runId, call.id);

    if (outcome.kind === "input_required") {
      const asked = await this.askInput(ctx, call.id, tool.key, attempt, outcome);
      if (typeof asked !== "string") return asked;
      outcome = { kind: "error", message: asked };
    }

    const rendered =
      outcome.kind === "result"
        ? renderResult(outcome.result)
        : { text: outcome.message, contentTypes: [], isError: true };
    // 内置工具（tool_search）报告的已加载工具：只认本步可用、非内置的 key，写进 tool_result（日志即事实源）
    const loadedTools =
      outcome.kind === "result" && tool.source.kind === "builtin"
        ? loadedFrom(outcome.result, resolved.tools)
        : [];
    // 显示摘要：只认插件 / 内置工具与内核的 resources 工具给的（连接器结果来自外部服务，不采信），
    // 校验不过就丢弃并告警
    const display =
      outcome.kind === "result" && (tool.source.kind !== "connector" || tool.source.resources)
        ? this.displayOf(outcome.result, tool.key)
        : undefined;
    const cfg = this.deps.config().tools;
    const spilled = await spillIfLarge(
      rendered.text,
      {
        // 内置工具可给更低的转存阈值（沙箱 bash 30000 字符）
        spillChars: Math.min(cfg.outputSpillChars, tool.spillChars ?? Number.POSITIVE_INFINITY),
        previewChars: cfg.outputPreviewChars,
      },
      (content) =>
        this.deps.outputs.save({
          orgId: ctx.orgId,
          conversationId: ctx.conversationId,
          callId: call.id,
          content,
        }),
    );
    const pre: AppendEvent[] =
      outcome.kind === "connection_required"
        ? [
            {
              type: "connection_required",
              runId: ctx.runId,
              idemKey: idem.connection(ctx.runId, call.id),
              payload: {
                step: ctx.step,
                callId: call.id,
                // 事件 payload 字段名改名后不变（C27：日志确定性）
                appId: outcome.connectorId,
                appName: outcome.connectorName,
              },
            },
          ]
        : [];
    await this.writeResult(
      ctx,
      call.id,
      tool.key,
      {
        content: spilled.content,
        isError: rendered.isError,
        ...(spilled.outputId !== undefined && { outputId: spilled.outputId }),
        ...(rendered.contentTypes.length > 0 && { contentTypes: rendered.contentTypes }),
        ...(loadedTools.length > 0 && { loadedTools }),
        ...(display !== undefined && { display }),
      },
      pre,
      {
        durationMs,
        connectorId: tool.source.kind === "connector" ? tool.source.connectorId : null,
        authorization,
      },
    );
    if (hooks && hookBase) {
      fireObserve(
        hooks,
        "tool.postExecute",
        { ...hookBase, isError: rendered.isError, content: spilled.content, durationMs },
        ctx.signal,
        this.deps.log,
      );
    }
    return undefined;
  }

  /**
   * 发出本步调用的请求里带了完整定义的工具 key：本步最后一次尝试的 `model_call.request.tools`
   * （`assistant_message` 来自最后一次尝试）。该请求不在 tool_search 模式（没有 `catalog`，工具全部发送）
   * 或找不到 model_call 时返回 null（不做加载检查）。已加载集合由此从日志得出，不放进程内存。
   */
  private async sentTools(ctx: ToolStepContext): Promise<Set<string> | null> {
    for (let attempt = MAX_MODEL_ATTEMPTS; attempt >= 1; attempt--) {
      const e = await this.deps.eventLog.findByIdem(
        ctx.conversationId,
        modelCallIdemKey(ctx.runId, ctx.step, attempt),
      );
      if (e?.type !== "model_call") continue;
      const { tools, catalog } = e.payload.request;
      return catalog === undefined ? null : new Set((tools ?? []).map((t) => t.key));
    }
    return null;
  }

  /** 审批的非批准结果 → 给模型的说明；仍 pending → null（继续等待）。 */
  private refusalText(a: ApprovalRecord): string | null {
    switch (a.status) {
      case "denied":
        return APPROVAL_DENIED_TEXT;
      case "expired":
        // 按该审批实际的等待时长（创建到到期），不读当前配置（配置可热更新）
        return approvalExpiredText(approvalHours(a));
      case "cancelled":
        return APPROVAL_CANCELLED_TEXT;
      default:
        return null;
    }
  }

  /**
   * 处理函数返回 `input_required`：超过轮次上限、表单不合规（`validateInputForm`）或 state 过大 → 返回给模型的错误说明；
   * 否则建输入请求（写 `question_asked`）并返回等待对象。
   */
  private async askInput(
    ctx: ToolStepContext,
    callId: string,
    toolKey: string,
    attempt: number,
    req: { form: InputForm; state: unknown },
  ): Promise<WaitingFor | string> {
    if (attempt > MAX_INPUT_ROUNDS) return TOO_MANY_INPUT_REQUESTS_TEXT;
    const problems = validateInputForm(req.form);
    if (problems.length > 0) return invalidFormText(toolKey, problems);
    let stateJson: string | undefined;
    try {
      stateJson = JSON.stringify(req.state ?? null);
    } catch {
      stateJson = undefined;
    }
    if (stateJson === undefined) return `Tool ${toolKey} returned input state that is not JSON.`;
    if (Buffer.byteLength(stateJson, "utf8") > MAX_INPUT_STATE_BYTES) {
      return stateTooLargeText(toolKey);
    }
    const q = await this.deps.questions.ask({
      orgId: ctx.orgId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      step: ctx.step,
      callId,
      attempt,
      toolKey,
      form: req.form,
      state: JSON.parse(stateJson) as unknown,
    });
    return inputWait(q);
  }

  /**
   * 管线第 4 阶段：执行。内置 / 插件工具直接调用处理函数，连接器工具经连接器（每次调用打开并关闭会话）。
   * 带 `tools.timeoutMs` 超时与 run 的中止信号（合并后传给处理函数 / 连接器，不响应信号的也按时结束）。
   * 熔断只作用于连接器工具（键为组织 × 连接器）。
   */
  async execute(
    tool: ResolvedTool,
    input: unknown,
    ctx: ToolStepContext,
    callId: string,
    resume?: ToolResume,
    stepTools?: readonly ResolvedTool[],
  ): Promise<ExecOutcome> {
    if (tool.source.kind === "connector") {
      return this.executeConnector(tool, tool.source, input, ctx, resume);
    }
    const handler = this.deps.registry.handler(tool.source);
    if (!handler) return { kind: "error", message: `Tool ${tool.key} is no longer available.` };
    // 插件处理函数只拿到 SDK 的 ToolCallContext；内置工具另外拿到本步解析出的工具（tool_search 用）
    const base: Omit<BuiltinCallContext, "signal"> = {
      orgId: ctx.orgId,
      accountId: ctx.accountId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      callId,
      ...(resume !== undefined && { resume }),
      ...(tool.source.kind === "builtin" && stepTools !== undefined && { tools: stepTools }),
      ...(tool.source.kind === "builtin" && { runId: ctx.runId }),
      ...(tool.source.kind === "builtin" &&
        ctx.deadline !== undefined && { runDeadline: ctx.deadline }),
    };
    // 内置工具可按输入给自己的时限（沙箱 bash 按命令超时加余量）；缺省 tools.timeoutMs
    const timeoutMs = tool.timeoutMs?.(input) ?? this.deps.config().tools.timeoutMs;
    try {
      const r = await this.bounded(
        ctx.signal,
        (signal) => handler(input, { ...base, signal }),
        undefined,
        timeoutMs,
      );
      if (r === "timeout") {
        return { kind: "error", message: timeoutText(tool.key, timeoutMs) };
      }
      if (r === "aborted") return { kind: "error", message: RUN_STOPPED_DURING_TEXT };
      if (isInputRequired(r.value)) {
        return { kind: "input_required", form: r.value.form, state: r.value.state ?? null };
      }
      return { kind: "result", result: r.value };
    } catch (e) {
      return this.thrown(tool.key, e);
    }
  }

  private async executeConnector(
    tool: ResolvedTool,
    source: Extract<ResolvedTool["source"], { kind: "connector" }>,
    input: unknown,
    ctx: ToolStepContext,
    resume?: ToolResume,
  ): Promise<ExecOutcome> {
    const { db, registry, breaker, credentials, config } = this.deps;
    const { orgId } = ctx;
    const connectorId = source.connectorId;
    const app = await db
      .selectFrom("connectors")
      .select(["name", "connector", "endpoint", "auth", "status"])
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (app?.status !== "active") {
      return { kind: "error", message: `The app providing ${tool.key} is no longer available.` };
    }
    const connector = registry.findConnector(app.connector);
    if (!connector) {
      return {
        kind: "error",
        message: `The connector for ${tool.key} is not installed; ask an administrator.`,
      };
    }
    const state = await breaker.check(orgId, connectorId);
    if (state.open) {
      return {
        kind: "error",
        message: breakerOpenMessage(app.name, state.failures, state.retryAfterSeconds),
      };
    }

    const auth = app.auth as ConnectorAuth;
    let injection: Promise<AuthInjection> | undefined;
    /** 本次调用实际注入过的凭据（含 401 后重新读取的），结果打码用。 */
    const injected: AuthInjection[] = [];
    const getAuth = () => {
      injection ??= credentials.injection(orgId, connectorId, auth, ctx.accountId).then((inj) => {
        injected.push(inj);
        return inj;
      });
      return injection;
    };
    // 远端在调用途中向用户要输入（MCP elicitation，见 elicitation.ts）：需要问用户时中止本次调用、按 input_required
    // 处理；续跑时用 ctx.resume 的答案答复远端再次发起的同一请求。resources 工具不续跑，一律拒绝。
    const suspend = new AbortController();
    const elicit = new ElicitationSession({
      resume,
      onSuspend: () => suspend.abort(),
      declineAll: source.resources === true,
    });
    // 远端可能把收到的凭据回显在结果 / 错误 / elicitation 表单里：写入事件之前按本次注入的值打码（见 redact.ts）
    const clean = (o: ExecOutcome): ExecOutcome => {
      const redact = redactorFor(injected);
      if (o.kind === "result") {
        return { kind: "result", result: redactDeep(withNotes(o.result, elicit.notes), redact) };
      }
      if (o.kind === "error") {
        return { kind: "error", message: redact([o.message, ...elicit.notes].join(" ")) };
      }
      if (o.kind === "input_required") {
        return {
          kind: "input_required",
          form: redactDeep(o.form, redact) as InputForm,
          state: redactDeep(o.state, redact),
        };
      }
      return o;
    };
    /** 本次执行要问用户（elicitation）：服务可达，算成功；返回打码后的输入请求。 */
    const asked = async (): Promise<ExecOutcome | undefined> => {
      if (!elicit.pending) return undefined;
      await breaker.success(orgId, connectorId);
      return clean({
        kind: "input_required",
        form: elicit.pending.form,
        state: elicit.pending.state,
      });
    };
    const missing = (e: CredentialMissing): ExecOutcome =>
      e.ownership === "personal"
        ? {
            kind: "connection_required",
            connectorId,
            connectorName: app.name,
            message: personalMissingText(app.name),
          }
        : { kind: "error", message: orgMissingText(app.name) };
    // 先取一次凭据：缺凭据在打开会话之前就确定，不依赖连接器把 CredentialMissing 原样抛出。
    try {
      await getAuth();
    } catch (e) {
      if (e instanceof CredentialMissing) return missing(e);
      // 取 token 时授权服务器暂时不可用（OAuth）：给模型可执行的说明，不让整轮失败
      if (e instanceof ToolError) return { kind: "error", message: e.message };
      throw e;
    }

    let opened: Promise<ConnectorSession> | undefined;
    try {
      // suspend 也参与竞速：为问用户中止时立即结束，不等连接器自己收尾
      const r = await this.bounded(
        ctx.signal,
        async (signal) => {
          opened = connector.open({
            endpoint: app.endpoint,
            auth: getAuth,
            // OAuth：在刷新锁内强制刷新（别的副本已刷新则直接用新 token）；之后丢弃本次调用缓存的注入，
            // 连接器重试时重新读取。refresh 被拒 → CredentialMissing，经连接器原样抛出，下面转成「需要连接」。
            onUnauthorized: async () => {
              const stale = injected.at(-1);
              injection = undefined;
              await credentials.onUnauthorized(orgId, connectorId, auth, ctx.accountId, stale);
            },
            signal,
            onElicit: elicit.handle,
            onToolsChanged: () => {
              try {
                this.deps.onToolsChanged?.(orgId, connectorId);
              } catch (err) {
                this.deps.log.warn("tools changed notification failed", {
                  orgId,
                  connectorId,
                  err,
                });
              }
            },
          });
          const session = await opened;
          return source.resources
            ? runResourceTool(session, source.name, input)
            : // 交回已复核的定义（connector_tools.spec，含 connectorData）：连接器按它路由，远端变化须先经漂移复核
              session.callTool(source.name, input, AbortSignal.any([signal, suspend.signal]), {
                spec: tool.spec,
              });
        },
        suspend.signal,
      );
      if (r === "aborted") return { kind: "error", message: RUN_STOPPED_DURING_TEXT };
      const ask = await asked();
      if (ask) return ask;
      if (r === "timeout") {
        await breaker.failure(orgId, connectorId);
        return { kind: "error", message: timeoutText(tool.key, config().tools.timeoutMs) };
      }
      // 工具自己报告的错误（isError）说明服务可用，也算成功。
      await breaker.success(orgId, connectorId);
      return clean({ kind: "result", result: r.value });
    } catch (e) {
      // 为问用户而中止了调用：中止引起的错误不是失败
      const ask = await asked();
      if (ask) return ask;
      if (e instanceof CredentialMissing) return missing(e);
      // 熔断只计远端不可用（连接 / 传输错误、HTTP 5xx：连接器抛 kind = unavailable 的 ToolError 或原始错误）。
      // 其余 ToolError（JSON-RPC 业务错误、鉴权失败、重定向等）说明服务可达，与 isError 结果一样算成功。
      if (e instanceof ToolError && e.kind !== "unavailable")
        await breaker.success(orgId, connectorId);
      else await breaker.failure(orgId, connectorId);
      return clean(this.thrown(tool.key, e));
    } finally {
      if (opened) await this.closeSession(opened, tool.key);
    }
  }

  /** 抛出的错误 → 给模型的结果：ToolError 的消息原样（插件约定为英文、可操作），其他只给错误类名。 */
  private thrown(key: string, e: unknown): ExecOutcome {
    if (e instanceof ToolError) return { kind: "error", message: e.message };
    // 提供工具的插件实例在调用进行中被撤销（停用 / 升级），排空时限到后中止（C17）
    if (e instanceof PluginUnloadedError) {
      this.deps.log.warn("tool call aborted: plugin unloaded", { toolKey: key, plugin: e.plugin });
      return { kind: "error", message: PLUGIN_UNLOADED_TOOL_ERROR };
    }
    // 不记参数与结果；错误经日志打码
    this.deps.log.warn("tool call failed", { toolKey: key, err: e });
    return { kind: "error", message: failedText(key, errName(e)) };
  }

  /**
   * 带超时与中止执行 work：合并 run 信号与超时信号传给 work，并与之竞速（work 不响应信号也按时返回）。
   * 返回 `{ value }`，或 `"timeout"` / `"aborted"`；work 自己的错误照常抛出。
   */
  private async bounded<T>(
    runSignal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
    /** 额外参与竞速的信号（不传给 work）：中止时以 `Stopped` 抛出，由调用方判断原因。 */
    interrupt?: AbortSignal,
    /** 时限（毫秒），缺省 `tools.timeoutMs`。 */
    timeoutMs: number = this.deps.config().tools.timeoutMs,
  ): Promise<{ value: T } | "timeout" | "aborted"> {
    if (runSignal.aborted) return "aborted";
    const timeout = new AbortController();
    // 本进程发起的调用自己的计时器，结束即清除
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = AbortSignal.any([runSignal, timeout.signal]);
    let onAbort: () => void = () => {};
    const race = interrupt ? AbortSignal.any([signal, interrupt]) : signal;
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Stopped());
      race.addEventListener("abort", onAbort, { once: true });
    });
    stopped.catch(() => {});
    try {
      const p = (async () => work(signal))();
      p.catch(() => {});
      return { value: await Promise.race([p, stopped]) };
    } catch (e) {
      if (signal.aborted) return runSignal.aborted ? "aborted" : "timeout";
      throw e;
    } finally {
      clearTimeout(timer);
      race.removeEventListener("abort", onAbort);
    }
  }

  /** 关闭会话（打开仍在进行时等它完成后关闭），最多等 {@link CLOSE_WAIT_MS}；失败只记日志。 */
  private async closeSession(opened: Promise<ConnectorSession>, key: string): Promise<void> {
    const closing = opened
      .then((s) => s.close())
      .catch((err: unknown) =>
        this.deps.log.warn("connector session close failed", { toolKey: key, err }),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closing,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * 工具结果里的显示摘要（`ToolResult.display`）：合法时只取 `{ summary: { zh, en } }`，没有给返回 undefined，
   * 不合法时记告警并丢弃（结果照常写入）。摘要只进事件日志给界面看，不进模型请求。
   */
  private displayOf(result: unknown, toolKey: string): ToolDisplay | undefined {
    const d = (result as { display?: unknown } | null)?.display;
    if (d === undefined) return undefined;
    const problems = validateToolDisplay(d);
    if (problems.length > 0) {
      this.deps.log.warn("tool returned an invalid display summary; dropped", {
        toolKey,
        problems,
      });
      return undefined;
    }
    const { zh, en } = (d as ToolDisplay).summary;
    return { summary: { zh, en } };
  }

  /**
   * 管线第 6 阶段：写 `tool_result`（与 `connection_required` 同批）。传入 `callAudit`（即工具实际执行过；
   * 耗时 null = 执行过但耗时未知，如续跑时「有开始无结果」的调用）时在同一事务里写审计 `tool.called`。
   * 审计链（R6）：actor = 发起人 → agent（id + 版本）→ 会话 / 运行 / 调用 / 工具（连接器工具带 connectorId）→
   * 放行依据（审批人 / 授权 / 策略）。不含参数、结果与凭据。
   */
  private async writeResult(
    ctx: ToolStepContext,
    callId: string,
    toolKey: string,
    r: {
      content: string;
      isError: boolean;
      outputId?: string;
      contentTypes?: string[];
      loadedTools?: string[];
      display?: ToolDisplay;
    },
    pre: AppendEvent[] = [],
    callAudit?: CallAudit,
    /** Extra audit entries written in the same transaction (e.g. `hook.denied`). */
    audits: AuditEntry[] = [],
  ): Promise<void> {
    const events: AppendEvent[] = [
      ...pre,
      {
        type: "tool_result",
        runId: ctx.runId,
        idemKey: idem.result(ctx.runId, callId),
        payload: { step: ctx.step, callId, toolKey, ...r },
      },
    ];
    if (callAudit === undefined && audits.length === 0) {
      await this.deps.eventLog.append(ctx.conversationId, events);
      return;
    }
    const written = await this.deps.db.transaction().execute(async (t) => {
      const out = await this.deps.eventLog.append(ctx.conversationId, events, t);
      for (const a of audits) await audit(t, a);
      if (callAudit === undefined) return out;
      await audit(t, {
        actorAccountId: ctx.accountId,
        orgId: ctx.orgId,
        action: "tool.called",
        target: ctx.conversationId,
        detail: {
          toolKey,
          isError: r.isError,
          durationMs: callAudit.durationMs,
          agentId: ctx.agentId,
          agentVersion: ctx.agentVersion,
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          callId,
          ...(callAudit.connectorId !== null && { connectorId: callAudit.connectorId }),
          ...callAudit.authorization,
        },
      });
      return out;
    });
    await this.deps.eventLog.notify(ctx.conversationId, Math.max(...written.map((e) => e.seq)));
  }
}
