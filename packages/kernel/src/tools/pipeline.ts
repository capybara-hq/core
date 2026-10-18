import {
  type AuthInjection,
  type ConnectorSession,
  type InputRequired,
  type Logger,
  type ToolCallContext,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import type { AgentDefinition } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import { UNKNOWN_RESULT_TEXT } from "../runtime/context/pairing.js";
import { assistantIdemKey } from "../runtime/model-call.js";
import { type Breaker, breakerOpenMessage } from "./breaker.js";
import { type AppAuth, CredentialMissing, type Credentials } from "./credentials.js";
import { renderResult, resolveOutputRefs, spillIfLarge, type ToolOutputs } from "./outputs.js";
import type { ResolvedTool, ToolRegistry, UnavailableTool } from "./registry.js";
import { validateInput } from "./validate.js";

// ---- 模型可见文案（英文） ----

/** `ask` 的桩结果（Task 9 接入暂停 / 审批前）。 */
export const TOOL_APPROVAL_UNAVAILABLE = "This tool requires approval, which is not available yet.";
/** 处理函数返回 `input_required` 的桩结果（Task 9 接入前）。 */
export const TOOL_INPUT_UNAVAILABLE = "This tool requested user input, which is not available yet.";
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
const personalMissingText = (appName: string) =>
  `The user has not connected ${appName}. A connect card was shown; ask the user to connect it, then retry.`;
const orgMissingText = (appName: string) =>
  `${appName} has no organization credential configured; ask an organization admin to set it up.`;

// ---- 策略（Task 8 实现，这里只定接口与桩） ----

/** 需要人审批的请求（Task 8 / 9 扩充字段）。 */
export interface AskRequest {
  toolKey: string;
}

export type PolicyDecision = "allow" | "deny" | { ask: AskRequest };

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

/**
 * 桩：直接用工具的默认策略（`ask` 原样返回，由 tools 节点按拒绝处理）。
 * TODO(Task 8)：换成真正的判定（agent 收紧、R3 清单、记住的授权）；TODO(Task 9)：`ask` 接入暂停与审批。
 */
export const defaultDecidePolicy: DecidePolicy = async (tool) =>
  tool.defaultPolicy === "ask" ? { ask: { toolKey: tool.key } } : tool.defaultPolicy;

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
  credentials: Pick<Credentials, "injection">;
  breaker: Pick<Breaker, "check" | "failure" | "success">;
  outputs: Pick<ToolOutputs, "save" | "load">;
  config: () => KernelConfig;
  log: Logger;
  /** 默认 {@link defaultDecidePolicy}。 */
  decidePolicy?: DecidePolicy;
  hooks?: ToolPipelineHooks;
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

/** 执行阶段的结果。 */
export type ExecOutcome =
  /** 工具返回了结果（可能是工具自己报告的错误，或畸形结果，由渲染阶段处理）。 */
  | { kind: "result"; result: unknown }
  /** 执行失败（超时、抛错、熔断、中止等），message 给模型看。 */
  | { kind: "error"; message: string }
  /** 发起人未连接个人凭据：除错误结果外再写 `connection_required`。 */
  | { kind: "connection_required"; appId: string; appName: string; message: string };

type ToolCall = { id: string; name: string; input: unknown };

/** 幂等键（brief 约定）。 */
const idem = {
  started: (runId: string, callId: string) => `tool_started:${runId}:${callId}`,
  result: (runId: string, callId: string) => `tool_result:${runId}:${callId}`,
  connection: (runId: string, callId: string) => `connection_required:${runId}:${callId}`,
};

/** 关闭会话时最多等待的时间（连接器 close 卡住不拖住运行）。 */
const CLOSE_WAIT_MS = 5_000;

const errName = (e: unknown): string =>
  e instanceof Error && typeof e.name === "string" && e.name !== "" ? e.name : "Error";

const isInputRequired = (v: unknown): v is InputRequired =>
  typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "input_required";

class Stopped extends Error {}

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
    this.decide = deps.decidePolicy ?? defaultDecidePolicy;
  }

  /**
   * tools 节点：按顺序处理本步 assistant 消息里的全部 `tool_call`，每个调用都以一条 `tool_result` 结束
   * （之后才回到 prepare 构建下一次请求，保持「已记录调用、未记录结果之间不构建请求」的不变式）。
   * 已有结果 → 跳过；有开始无结果 → 结果未知；run 已中止 → 不执行。
   */
  async runStep(ctx: ToolStepContext): Promise<void> {
    const { eventLog } = this.deps;
    const msg = await eventLog.findByIdem(
      ctx.conversationId,
      assistantIdemKey(ctx.runId, ctx.step),
    );
    if (msg?.type !== "assistant_message") return;
    const calls = msg.payload.content.flatMap((b) =>
      b.type === "tool_call" ? [{ id: b.id, name: b.name, input: b.input }] : [],
    );
    let resolved: { tools: ResolvedTool[]; unavailable: UnavailableTool[] } | undefined;
    for (const call of calls) {
      if (await eventLog.findByIdem(ctx.conversationId, idem.result(ctx.runId, call.id))) continue;
      const started = await eventLog.findByIdem(
        ctx.conversationId,
        idem.started(ctx.runId, call.id),
      );
      if (started?.type === "tool_call_started") {
        await this.writeResult(ctx, call.id, started.payload.toolKey, {
          content: UNKNOWN_RESULT_TEXT,
          isError: true,
        });
        continue;
      }
      if (ctx.signal.aborted) {
        await this.writeResult(ctx, call.id, call.name, {
          content: RUN_STOPPED_TEXT,
          isError: true,
        });
        continue;
      }
      // 每步实时解析（应用 / 插件状态可能在模型调用之后变化）
      resolved ??= await this.deps.registry.forAgent(ctx.orgId, { tools: ctx.agent.tools ?? [] });
      await this.runCall(ctx, call, resolved);
    }
  }

  private async runCall(
    ctx: ToolStepContext,
    call: ToolCall,
    resolved: { tools: ResolvedTool[]; unavailable: UnavailableTool[] },
  ): Promise<void> {
    const fail = (content: string, key = call.name) =>
      this.writeResult(ctx, call.id, key, { content, isError: true });

    const tool = resolved.tools.find((t) => t.key === call.name);
    if (!tool) {
      const why = resolved.unavailable.find((u) => u.ref === call.name);
      if (why) return fail(unavailableText(call.name, why.reason));
      const keys = resolved.tools.map((t) => t.key).sort();
      return fail(unknownToolText(call.name, keys, keys.includes("tool_search")));
    }

    let input: unknown;
    try {
      input = await resolveOutputRefs(call.input, (id) => this.deps.outputs.load(ctx.orgId, id));
    } catch (e) {
      if (e instanceof ToolError) return fail(e.message, tool.key);
      throw e;
    }
    const invalid = validateInput(tool.key, tool.spec, input);
    if (invalid !== null) return fail(invalid, tool.key);

    const decision = await this.decide(tool, ctx.agent, {
      orgId: ctx.orgId,
      accountId: ctx.accountId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
    });
    if (decision === "deny") return fail(deniedText(tool.key), tool.key);
    // TODO(Task 9)：`ask` 交给暂停机制（插入审批、写 approval_requested、返回 suspended；不写 tool_call_started）。
    if (decision !== "allow") return fail(TOOL_APPROVAL_UNAVAILABLE, tool.key);

    await this.deps.eventLog.append(ctx.conversationId, [
      {
        type: "tool_call_started",
        runId: ctx.runId,
        idemKey: idem.started(ctx.runId, call.id),
        payload: { step: ctx.step, callId: call.id, toolKey: tool.key, specHash: tool.specHash },
      },
    ]);
    const t0 = Date.now();
    const outcome = await this.execute(tool, input, ctx, call.id);
    const durationMs = Date.now() - t0;
    await this.deps.hooks?.afterExecute?.(ctx.runId, call.id);

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
        // TODO(Task 9)：校验表单、插入输入请求、写 question_asked 并暂停。
        return { kind: "error", message: TOOL_INPUT_UNAVAILABLE };
      }
      return { kind: "result", result: r.value };
    } catch (e) {
      return this.thrown(tool.key, e);
    }
  }

  private async executeApp(
    tool: ResolvedTool,
    source: { kind: "app"; appId: string; name: string },
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
    const getAuth = () => {
      injection ??= credentials.injection(orgId, appId, auth, ctx.accountId);
      return injection;
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
      throw e;
    }

    let opened: Promise<ConnectorSession> | undefined;
    try {
      const r = await this.bounded(ctx.signal, async (signal) => {
        opened = connector.open({
          endpoint: app.endpoint,
          auth: getAuth,
          // 刷新凭据在 Task 15（OAuth）接入；这里只丢弃本次调用缓存的注入，下次请求重新读取。
          onUnauthorized: async () => {
            injection = undefined;
          },
          signal,
        });
        const session = await opened;
        return session.callTool(source.name, input, signal);
      });
      if (r === "aborted") return { kind: "error", message: RUN_STOPPED_DURING_TEXT };
      if (r === "timeout") {
        await breaker.failure(orgId, appId);
        return { kind: "error", message: timeoutText(tool.key, config().tools.timeoutMs) };
      }
      // 工具自己报告的错误（isError）说明服务可用，也算成功。
      await breaker.success(orgId, appId);
      return { kind: "result", result: r.value };
    } catch (e) {
      if (e instanceof CredentialMissing) return missing(e);
      await breaker.failure(orgId, appId);
      return this.thrown(tool.key, e);
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
   * 管线第 6 阶段：写 `tool_result`（与 `connection_required` 同批）。传入 `durationMs`（即工具实际执行过）时
   * 在同一事务里写审计 `tool.called`（detail 只有 toolKey、是否出错、耗时；不含参数与结果）。
   */
  private async writeResult(
    ctx: ToolStepContext,
    callId: string,
    toolKey: string,
    r: { content: string; isError: boolean; outputId?: string; contentTypes?: string[] },
    pre: AppendEvent[] = [],
    durationMs?: number,
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
