import {
  type AuthInjection,
  type ConnectorSession,
  type FormAnswer,
  type InputForm,
  type InputRequired,
  type Logger,
  type ToolCallContext,
  ToolError,
  validateInputForm,
} from "@capybara-hq/plugin-sdk";
import type { AgentDefinition } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import type { OrgRole } from "../orgs/roles.js";
import { UNKNOWN_RESULT_TEXT } from "../runtime/context/pairing.js";
import type { WaitingFor } from "../runtime/loop.js";
import { assistantIdemKey } from "../runtime/model-call.js";
import type { ApprovalRecord, ApprovalsService } from "./approvals.service.js";
import { type Breaker, breakerOpenMessage } from "./breaker.js";
import { type AppAuth, CredentialMissing, type Credentials } from "./credentials.js";
import { renderResult, resolveOutputRefs, spillIfLarge, type ToolOutputs } from "./outputs.js";
import { createDecidePolicy } from "./policy.js";
import type { QuestionRecord, QuestionsService } from "./questions.service.js";
import { redactDeep, redactorFor } from "./redact.js";
import type { ResolvedTool, ToolRegistry, UnavailableTool } from "./registry.js";
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
const invalidFormText = (key: string, problems: string[]) =>
  `Tool ${key} returned an invalid input form: ${problems.join("; ")}.`;
const stateTooLargeText = (key: string) =>
  `Tool ${key} returned input state larger than ${MAX_INPUT_STATE_BYTES / 1024} KB.`;
const personalMissingText = (appName: string) =>
  `The user has not connected ${appName}. A connect card was shown; ask the user to connect, then retry.`;
const orgMissingText = (appName: string) =>
  `${appName} has no organization credential configured; ask an organization admin to set it up.`;

// ---- 策略（判定见 policy.ts） ----

/** 需要人审批的请求（`ApprovalsService.request` 据此建审批记录）。 */
export interface AskRequest {
  toolKey: string;
  /** 所批准的工具定义指纹（「本会话 / 以后都允许」授权按它匹配）。 */
  specHash: string;
  /** 应用工具的来源应用；插件 / 内置工具为 null。 */
  appId: string | null;
  /** 指定处理人（发起人本人）；按角色升级时为 null。 */
  requestedFor: string | null;
  /** 按角色升级（R1）时所需的角色；否则为 null。 */
  approverRole: OrgRole | null;
}

/**
 * `unavailable`：调用那一刻工具已不可用（应用 / 工具不存在、停用、删除、待审核），值为事实原因；
 * 管线写「工具不可用」说明，而不是「策略拒绝」。
 */
export type PolicyDecision = "allow" | "deny" | { ask: AskRequest } | { unavailable: string };

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
   * 连接器在调用途中报告工具清单变了（MCP `notifications/tools/list_changed`）：内核安排一次该应用的漂移检查。
   * 不等待、不抛错（实现自己吞掉错误）。
   */
  onToolsChanged?: (orgId: string, appId: string) => void;
}

/** tools 节点处理一步工具调用所需的上下文。 */
export interface ToolStepContext {
  orgId: string;
  conversationId: string;
  runId: string;
  step: number;
  agentId: string;
  agent: AgentDefinition;
  /** 对话发起人（取个人凭据、审计 actor）。 */
  accountId: string;
  /** run 的中止信号（用户中止 / 截止时间）。 */
  signal: AbortSignal;
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
  | { kind: "connection_required"; appId: string; appName: string; message: string };

type ToolCall = { id: string; name: string; input: unknown };

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

class Stopped extends Error {}

type Resolved = { tools: ResolvedTool[]; unavailable: UnavailableTool[] };

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
      // 每步实时解析（应用 / 插件状态可能在模型调用之后变化）
      resolved ??= await this.deps.registry.forAgent(ctx.orgId, { tools: ctx.agent.tools ?? [] });
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
      // 确实开始执行过：照样审计 tool.called（耗时未知）
      await this.writeResult(
        ctx,
        call.id,
        started.payload.toolKey,
        { content: UNKNOWN_RESULT_TEXT, isError: true },
        [],
        null,
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
      const why = resolved.unavailable.find((u) => u.ref === call.name);
      if (why) return fail(unavailableText(call.name, why.reason));
      const keys = resolved.tools.map((t) => t.key).sort();
      return fail(unknownToolText(call.name, keys, keys.includes("tool_search")));
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
    // 应用工具的 schema 来自连接器（不受信任）：去掉有风险的关键字并限制大小 / 层数
    const invalid = validateInput(tool.key, tool.spec, input, {
      untrusted: tool.source.kind === "app",
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
    if ((!approval || stale) && decision !== "allow") {
      approval = await this.deps.approvals.request({
        attempt: (approval?.attempt ?? 0) + 1,
        orgId: ctx.orgId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        step: ctx.step,
        callId: call.id,
        toolKey: tool.key,
        specHash: decision.ask.specHash,
        appId: decision.ask.appId,
        input: call.input,
        requestedFor: decision.ask.requestedFor,
        approverRole: decision.ask.approverRole,
      });
    }
    if (approval && approval.status !== "approved") {
      const refused = this.refusalText(approval);
      return refused === null ? approvalWait(approval) : fail(refused, tool.key);
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
    let outcome = await this.execute(tool, input, ctx, call.id, resume);
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
    const cfg = this.deps.config().tools;
    const spilled = await spillIfLarge(
      rendered.text,
      { spillChars: cfg.outputSpillChars, previewChars: cfg.outputPreviewChars },
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
                appId: outcome.appId,
                appName: outcome.appName,
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
      },
      pre,
      durationMs,
    );
    return undefined;
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
   * 管线第 4 阶段：执行。内置 / 插件工具直接调用处理函数，应用工具经连接器（每次调用打开并关闭会话）。
   * 带 `tools.timeoutMs` 超时与 run 的中止信号（合并后传给处理函数 / 连接器，不响应信号的也按时结束）。
   * 熔断只作用于应用工具（键为组织 × 应用）。
   */
  async execute(
    tool: ResolvedTool,
    input: unknown,
    ctx: ToolStepContext,
    callId: string,
    resume?: ToolResume,
  ): Promise<ExecOutcome> {
    if (tool.source.kind === "app") {
      return this.executeApp(tool, tool.source, input, ctx);
    }
    const handler = this.deps.registry.handler(tool.source);
    if (!handler) return { kind: "error", message: `Tool ${tool.key} is no longer available.` };
    const base: Omit<ToolCallContext, "signal"> = {
      orgId: ctx.orgId,
      accountId: ctx.accountId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      callId,
      ...(resume !== undefined && { resume }),
    };
    try {
      const r = await this.bounded(ctx.signal, (signal) => handler(input, { ...base, signal }));
      if (r === "timeout") {
        return {
          kind: "error",
          message: timeoutText(tool.key, this.deps.config().tools.timeoutMs),
        };
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

  private async executeApp(
    tool: ResolvedTool,
    source: Extract<ResolvedTool["source"], { kind: "app" }>,
    input: unknown,
    ctx: ToolStepContext,
  ): Promise<ExecOutcome> {
    const { db, registry, breaker, credentials, config } = this.deps;
    const { orgId } = ctx;
    const appId = source.appId;
    const app = await db
      .selectFrom("apps")
      .select(["name", "connector", "endpoint", "auth", "status"])
      .where("id", "=", appId)
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
    const state = await breaker.check(orgId, appId);
    if (state.open) {
      return {
        kind: "error",
        message: breakerOpenMessage(app.name, state.failures, state.retryAfterSeconds),
      };
    }

    const auth = app.auth as AppAuth;
    let injection: Promise<AuthInjection> | undefined;
    /** 本次调用实际注入过的凭据（含 401 后重新读取的），结果打码用。 */
    const injected: AuthInjection[] = [];
    const getAuth = () => {
      injection ??= credentials.injection(orgId, appId, auth, ctx.accountId).then((inj) => {
        injected.push(inj);
        return inj;
      });
      return injection;
    };
    // 远端可能把收到的凭据回显在结果 / 错误里：写入事件之前按本次注入的值打码（见 redact.ts）
    const clean = (o: ExecOutcome): ExecOutcome => {
      const redact = redactorFor(injected);
      if (o.kind === "result") return { kind: "result", result: redactDeep(o.result, redact) };
      if (o.kind === "error") return { kind: "error", message: redact(o.message) };
      return o;
    };
    const missing = (e: CredentialMissing): ExecOutcome =>
      e.ownership === "personal"
        ? {
            kind: "connection_required",
            appId,
            appName: app.name,
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
      const r = await this.bounded(ctx.signal, async (signal) => {
        opened = connector.open({
          endpoint: app.endpoint,
          auth: getAuth,
          // OAuth：在刷新锁内强制刷新（别的副本已刷新则直接用新 token）；之后丢弃本次调用缓存的注入，
          // 连接器重试时重新读取。refresh 被拒 → CredentialMissing，经连接器原样抛出，下面转成「需要连接」。
          onUnauthorized: async () => {
            const stale = injected.at(-1);
            injection = undefined;
            await credentials.onUnauthorized(orgId, appId, auth, ctx.accountId, stale);
          },
          signal,
          onToolsChanged: () => {
            try {
              this.deps.onToolsChanged?.(orgId, appId);
            } catch (err) {
              this.deps.log.warn("tools changed notification failed", { orgId, appId, err });
            }
          },
        });
        const session = await opened;
        return source.resources
          ? runResourceTool(session, source.name, input)
          : session.callTool(source.name, input, signal);
      });
      if (r === "aborted") return { kind: "error", message: RUN_STOPPED_DURING_TEXT };
      if (r === "timeout") {
        await breaker.failure(orgId, appId);
        return { kind: "error", message: timeoutText(tool.key, config().tools.timeoutMs) };
      }
      // 工具自己报告的错误（isError）说明服务可用，也算成功。
      await breaker.success(orgId, appId);
      return clean({ kind: "result", result: r.value });
    } catch (e) {
      if (e instanceof CredentialMissing) return missing(e);
      // 熔断只计远端不可用（连接 / 传输错误、HTTP 5xx：连接器抛 kind = unavailable 的 ToolError 或原始错误）。
      // 其余 ToolError（JSON-RPC 业务错误、鉴权失败、重定向等）说明服务可达，与 isError 结果一样算成功。
      if (e instanceof ToolError && e.kind !== "unavailable") await breaker.success(orgId, appId);
      else await breaker.failure(orgId, appId);
      return clean(this.thrown(tool.key, e));
    } finally {
      if (opened) await this.closeSession(opened, tool.key);
    }
  }

  /** 抛出的错误 → 给模型的结果：ToolError 的消息原样（插件约定为英文、可操作），其他只给错误类名。 */
  private thrown(key: string, e: unknown): ExecOutcome {
    if (e instanceof ToolError) return { kind: "error", message: e.message };
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
  ): Promise<{ value: T } | "timeout" | "aborted"> {
    if (runSignal.aborted) return "aborted";
    const timeout = new AbortController();
    // 本进程发起的调用自己的计时器，结束即清除
    const timer = setTimeout(() => timeout.abort(), this.deps.config().tools.timeoutMs);
    const signal = AbortSignal.any([runSignal, timeout.signal]);
    let onAbort: () => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Stopped());
      signal.addEventListener("abort", onAbort, { once: true });
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
      signal.removeEventListener("abort", onAbort);
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
   * 管线第 6 阶段：写 `tool_result`（与 `connection_required` 同批）。传入 `durationMs`（即工具实际执行过；
   * null = 执行过但耗时未知，如续跑时「有开始无结果」的调用）时在同一事务里写审计 `tool.called`
   * （detail 只有 toolKey、是否出错、耗时；不含参数与结果）。
   */
  private async writeResult(
    ctx: ToolStepContext,
    callId: string,
    toolKey: string,
    r: { content: string; isError: boolean; outputId?: string; contentTypes?: string[] },
    pre: AppendEvent[] = [],
    durationMs?: number | null,
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
    if (durationMs === undefined) {
      await this.deps.eventLog.append(ctx.conversationId, events);
      return;
    }
    const written = await this.deps.db.transaction().execute(async (t) => {
      const out = await this.deps.eventLog.append(ctx.conversationId, events, t);
      await audit(t, {
        actorAccountId: ctx.accountId,
        orgId: ctx.orgId,
        action: "tool.called",
        target: ctx.conversationId,
        detail: { toolKey, isError: r.isError, durationMs },
      });
      return out;
    });
    await this.deps.eventLog.notify(ctx.conversationId, Math.max(...written.map((e) => e.seq)));
  }
}
