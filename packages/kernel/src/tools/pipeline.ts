import {
  type AuthInjection,
  type ConnectorSession,
  type ConversationSource,
  type FormAnswer,
  type InputForm,
  type InputRequired,
  type Logger,
  type NetworkBlockedHost,
  parseToolKey,
  type ToolDisplay,
  ToolError,
  validateInputForm,
  validateToolDisplay,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { AgentDefinition } from "../agents/definition.js";
import { type AppendEvent, EventLog } from "../conversations/event-log.js";
import {
  COMMAND_ASK_MAX_CHARS,
  COMMAND_ASK_TEXT_MAX_CHARS,
  type ReviewRecord,
  type ToolView,
  ToolViewSchema,
} from "../conversations/events.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ConversationDevices } from "../devices/conversation-devices.js";
import { ApiError } from "../errors.js";
import { EffectiveConfigs, NEEDS_CONFIG_REASON } from "../extensions/effective-config.js";
import { clipText } from "../extensions/hooks.js";
import { ExtensionHost } from "../extensions/host.js";
import { ExtensionUnloadedError, PLUGIN_UNLOADED_TOOL_ERROR } from "../extensions/inflight.js";
import { audit } from "../identity/audit.js";
import { sha256Hex } from "../identity/hash.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { DevicePolicyService } from "../local-devices/device-policy.service.js";
import { NetworkGrants, type NetworkRunState } from "../local-devices/network-grants.js";
import type { OrgRole } from "../orgs/roles.js";
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
import { type SubagentParent, subagentWaitingIdemKey, type WaitingFor } from "../runtime/loop.js";
import { assistantIdemKey, MAX_STEP_MODEL_CALLS, modelCallIdemKey } from "../runtime/model-call.js";
import { rootSurfaceOf } from "../runtime/subagents/child.js";
import type { DispatchArgs, DispatchOutcome } from "../runtime/subagents/dispatch.js";
import { type MessageOutcome, SubagentMessages } from "../runtime/subagents/messages.js";
import { pairStoppedForks } from "../runtime/subagents/skill-fork.js";
import { SubagentsService } from "../runtime/subagents/subagents.service.js";
import {
  type CommandReview,
  isSessionGrantableRule,
  type ReviewVerdict,
} from "../sandbox/review/index.js";
import { CommandReviewService } from "../sandbox/review/review.service.js";
import {
  appendMissingGrant,
  connectionGrantKey,
  UNATTENDED_CONNECTION_ERROR,
  UNATTENDED_ELICITATION_NOTE,
  UNATTENDED_QUESTION_ERROR,
  type UnattendedRun,
  unattendedFails,
  unattendedRunOf,
} from "../schedules/unattended.js";
import { skillLoadOfferedIn } from "../skills/catalog.js";
import {
  type ApprovalRecord,
  type ApprovalScope,
  ApprovalsService,
  type CommandAskDetail,
  type NetworkAskDetail,
} from "./approvals.service.js";
import { Breaker, breakerOpenMessage } from "./breaker.js";
import { SEND_MESSAGE, SUBAGENT_HANDBACK, TOOL_SEARCH } from "./builtin-names.js";
import { AGENT_TOOL, AgentToolInput } from "./builtins/agent.js";
import { HandbackInput } from "./builtins/handback.js";
import {
  DEVICE_CODE_PATTERN,
  deviceCodeIdemKey,
  GITHUB_DEVICE_LOGIN_URL,
} from "./builtins/sandbox/device-code.js";
import { SendMessageInput } from "./builtins/send-message.js";
import { isAlwaysLoaded, notLoadedText } from "./builtins/tool-search.js";
import { canonicalJson } from "./canonical-json.js";
import { type ConnectorAuth, CredentialMissing, Credentials } from "./credentials.js";
import { ToolDrift } from "./drift.js";
import { ElicitationSession } from "./elicitation.js";
import { type LegacyScope, legacyHint, legacyToolInput, legacyToolKey } from "./legacy-keys.js";
import {
  blockedEventHosts,
  clipKept,
  NETWORK_ASK_KEPT_MAX_BYTES,
  networkBlockedIdemKey,
  planNetworkAsk,
  settledNetworkNotes,
  withNetworkNotes,
} from "./network-asks.js";
import { OrgToolSwitches, toolTurnedOffReason } from "./org-tool-switches.js";
import { renderResult, resolveOutputRefs, spillIfLarge, ToolOutputs } from "./outputs.js";
import { createDecidePolicy, type GrantKind } from "./policy.js";
import { type QuestionRecord, QuestionsService } from "./questions.service.js";
import { redactDeep, redactorFor } from "./redact.js";
import {
  type AgentTools,
  type BuiltinCallContext,
  type CallPolicy,
  type ResolvedTool,
  ToolRegistry,
} from "./registry.js";
import { runResourceTool } from "./resources.js";
import { validateInput } from "./validate.js";

// ---- 模型可见文案（英文） ----

/** 审批被拒绝。 */
export const APPROVAL_DENIED_TEXT = "The user denied this tool call.";

/**
 * The denied call's result when the approver gave a reason (model-visible, in the log). "An
 * approver": under role escalation an admin, not the requester, decides. Older logs keep the text
 * they recorded ("The user denied this tool call. Reason: …"); only new denials use this one.
 */
export const approvalDeniedText = (reason: string | null): string =>
  reason === null ? APPROVAL_DENIED_TEXT : `An approver denied this tool call. Reason: ${reason}`;
/** 审批超时（按拒绝）。 */
export const approvalExpiredText = (hours: number) =>
  `Approval timed out after ${hours}h; treated as denied.`;
/** 等待审批期间 run 被中止。 */
export const APPROVAL_CANCELLED_TEXT = "The run was stopped while waiting for approval.";
/**
 * The command review's deny text (auto mode spec §5.4, P-D12): the model-visible reason and what it
 * can do instead. `kind` says whether a shell command or a file write was held.
 */
export const commandDeniedText = (reason: string, kind: "command" | "write"): string =>
  kind === "write"
    ? `This write is blocked by review: ${reason}. Write it another way or ask the user to allow it.`
    : `Command blocked by review: ${reason}. Do the work another way or ask the user to run it.`;
/**
 * A command (or write) the review held in an unattended run: no one can answer, so it is a deny at
 * once — no approval, no grant (P-D3).
 */
export const commandUnattendedText = (reason: string, kind: "command" | "write"): string =>
  kind === "write"
    ? `This write needs approval (${reason}), and no one can approve it now; do it another way or leave it for the person.`
    : `This command needs approval (${reason}), and no one can approve it now; do the work another way or leave it for the person.`;
/**
 * A command longer than the ask ceiling (`COMMAND_ASK_MAX_CHARS`): it cannot be shown for approval,
 * and an approval must bind the whole text, so the call is refused before any approval exists.
 */
export const commandTooLongReason = (chars: number): string =>
  `The command is ${chars} characters long; commands over ${COMMAND_ASK_MAX_CHARS} are too long to review and approve.`;
/** The model-visible result of a command over the ask ceiling (actionable, English). */
export const commandTooLongText = (chars: number): string =>
  `This command is too long to review (${chars} characters; the limit is ${COMMAND_ASK_MAX_CHARS}). Split it into shorter commands; long inline scripts are reviewed as code the review cannot read.`;
/** The person declined a held command or write (P-D12); `reason` is what they said, if anything. */
export const commandDeclinedText = (reason: string | null, kind: "command" | "write"): string => {
  const what = kind === "write" ? "this write" : "to run this command";
  return reason === null
    ? `The user declined ${what}. Continue without it or ask the user.`
    : `The user declined ${what}: ${reason}. Continue without it or ask the user.`;
};
/** 等待用户输入期间 run 被中止。 */
export const INPUT_CANCELLED_TEXT = "The run was stopped while waiting for user input.";
/**
 * The result of an `AskUserQuestion` call whose question the user skipped by sending a message
 * (reply-while-question spec §7.1): the message follows in the log as an ordinary user message.
 */
export const QUESTION_SKIPPED_TEXT =
  "The user did not answer this question and sent a message instead; read it below and continue.";
/** The result of any other tool's input request (extension `input_required`, MCP elicitation) skipped by a message. */
export const INPUT_SKIPPED_TEXT =
  "The user did not provide the requested input and sent a message instead; read it below and continue. Call the tool again only if it is still needed.";
/** 同一调用连续请求输入超过上限。 */
export const TOO_MANY_INPUT_REQUESTS_TEXT = "Tool requested user input too many times.";
/** run 已被中止 / 到达截止时间，调用尚未开始执行。 */
export const RUN_STOPPED_TEXT = "The run was stopped before this tool call was executed.";
/** 调用执行中 run 被中止 / 到达截止时间。 */
export const RUN_STOPPED_DURING_TEXT =
  "The run was stopped while this tool call was running; its outcome is unknown. Verify before retrying.";

/** The fixed result of a call whose input request was skipped by a message (spec §7.1). */
const skippedResult = (
  toolKey: string,
): { content: string; isError: boolean; display: ToolDisplay } =>
  toolKey === "AskUserQuestion"
    ? {
        content: QUESTION_SKIPPED_TEXT,
        isError: false,
        display: {
          summary: {
            zh: "用户没有回答，直接发了消息",
            en: "User sent a message instead of answering",
          },
        },
      }
    : {
        content: INPUT_SKIPPED_TEXT,
        isError: true,
        display: {
          summary: { zh: "用户没有提供输入，直接发了消息", en: "User sent a message instead" },
        },
      };

const timeoutText = (key: string, ms: number) =>
  `Tool ${key} timed out after ${ms / 1000}s. The operation may or may not have completed; verify before retrying.`;
const failedText = (key: string, errName: string) =>
  `Tool ${key} failed (${errName}). The operation may not have completed; check before retrying or try another approach.`;
/** The connector slugs and extension names among the run's tools (to read old `<x>__<tool>` keys). */
const legacyScopeOf = (tools: readonly ResolvedTool[]): LegacyScope => {
  const connectorSlugs = new Set<string>();
  const extensionNames = new Set<string>();
  for (const t of tools) {
    const p = parseToolKey(t.key);
    if (p?.kind === "connector") connectorSlugs.add(p.slug);
    else if (p?.kind === "extension") extensionNames.add(p.plugin);
  }
  return { connectorSlugs, extensionNames };
};
const unknownToolText = (
  name: string,
  keys: string[],
  toolSearch: boolean,
  hint: string | null = null,
) =>
  `Unknown tool "${name}". Available tools: ${keys.length === 0 ? "(none)" : keys.join(", ")}.` +
  (toolSearch ? " Use ToolSearch to load other tools." : "") +
  (hint === null ? "" : ` ${hint}`);
const unavailableText = (name: string, reason: string) =>
  `Tool "${name}" is unavailable: ${reason}.`;
/** With a per-call policy key (`Platform:<operation>`), the text names it. */
const deniedText = (key: string, policyKey?: string) =>
  policyKey === undefined || policyKey === key
    ? `Tool ${key} is denied by policy.`
    : `Tool ${key} is denied by policy for ${policyKey}.`;
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
  /** Which rule asked (display only, written to `approval_requested.policy`). */
  policy: ApprovalPolicySource;
}

/**
 * Which rule made a call need approval: role escalation, the agent's tool policy, the connector's
 * policy, a fixed ask (R3, `requiresUserInteraction`), the org's `sandboxToolPolicy`, or the tool's
 * own default. `org` and `fixed` were added after the first B events (older logs say `default`).
 */
export type ApprovalPolicySource =
  | "agent"
  | "connector"
  | "member"
  | "default"
  | "role"
  | "org"
  | "fixed";

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
  | { grant: GrantKind }
  /**
   * Refused without an approval: an unattended run in `fail` mode (scheduled tasks spec §7). The
   * text is the tool error; `missingGrant` is added to the task run's `missing_grants`.
   */
  | { refused: string; missingGrant?: string };

export interface PolicyContext {
  orgId: string;
  /** 对话发起人。 */
  accountId: string;
  agentId: string;
  conversationId: string;
  runId: string;
  /**
   * A sub-agent's call: its parent conversation, whose agent's current policies apply on top
   * (sub-agents spec §5.5).
   */
  parentConversationId?: string;
  /**
   * A sub-agent's call: the root conversation of its tree, where "approve for this conversation"
   * grants are stored and looked up (agent map spec §7), so every agent of the tree uses them.
   */
  rootConversationId?: string;
  /**
   * False when the sub-agent runs its parent conversation's agent (a template or general-purpose
   * child): the parent agent's policies were already read as its own, so no second read. Unset:
   * read and compare.
   */
  parentAgentDiffers?: boolean;
  /**
   * The call's per-call policy ({@link ResolvedTool.callPolicy} of the validated input), or
   * null / unset: policies, grants and approvals use the tool key.
   */
  callPolicy?: CallPolicy | null;
  /**
   * The scheduled task run the run serves, unattended or trial (scheduled tasks spec §7); unset or
   * null: an attended run.
   */
  unattended?: UnattendedRun | null;
}

/** 管线第 3 阶段：策略判定。 */
export type DecidePolicy = (
  tool: ResolvedTool,
  agentDef: AgentDefinition,
  ctx: PolicyContext,
) => Promise<PolicyDecision>;

// ---- 管线 ----

/** The pipeline's test seams (`TOOL_PIPELINE_HOOKS`; the kernel never provides them). */
export interface ToolPipelineHooks {
  /**
   * Called after a tool returned and before its result is logged: throwing simulates a crash
   * between the execution and the record ("executed, result not recorded").
   */
  afterExecute?(runId: string, callId: string): Promise<void>;
  /** The policy decision; default {@link createDecidePolicy} (reads policies and grants live). */
  decidePolicy?: DecidePolicy;
}

/** `tool_result.card`: an inline card under the call (display only). */
type ToolCard = { plugin: string; view: string; key?: string };

/** Optional provider: the pipeline's {@link ToolPipelineHooks} (tests). */
export const TOOL_PIPELINE_HOOKS = Symbol("TOOL_PIPELINE_HOOKS");

/** What the pipeline calls through (the sub-agent dispatch is read at call time). */
interface PipelineDeps {
  /** The kernel-schema handle of the current context (its transaction, else the pool). */
  readonly db: KernelSchemaDb;
  readonly eventLog: EventLog;
  readonly registry: Pick<ToolRegistry, "forAgent" | "findConnector" | "handler">;
  readonly credentials: Pick<Credentials, "injection" | "onUnauthorized">;
  readonly breaker: Pick<Breaker, "check" | "failure" | "success">;
  readonly outputs: Pick<ToolOutputs, "save" | "load">;
  /** 策略为 `ask` 时建审批；续跑时读该调用的审批结果。 A refused network host: a network ask. */
  readonly approvals: Pick<
    ApprovalsService,
    | "request"
    | "forCall"
    | "networkForCall"
    | "requestNetwork"
    | "commandForCall"
    | "requestCommand"
  >;
  /** 处理函数返回 `input_required` 时建输入请求；续跑时读该调用的各轮输入请求。 */
  readonly questions: Pick<QuestionsService, "ask" | "forCall">;
  readonly log: Logger;
  readonly hooks: ToolPipelineHooks | undefined;
  /**
   * Plugin hooks (`tool.preExecute` policy / observe after policy and approval, `tool.postExecute`
   * observe after the result). Only the chat pipeline has them; the eval replay uses
   * `RecordedToolPipeline`, which never runs hooks. Also needs `conversationKind: "chat"` (P-18).
   */
  readonly pluginHooks: HookRunner | undefined;
  /**
   * The effective deployment config of an extension for an org (layering spec A §6): a plugin
   * tool's handler gets it as `ToolCallContext.config`, and is not called when it is not valid.
   */
  readonly effective: Pick<EffectiveConfigs, "get">;
  /** The org's switches of single extension tools: a turned-off one is not called (spec A §7). */
  readonly switches: Pick<OrgToolSwitches, "isToolOff">;
  /**
   * Ids of an extension's `conversation.tool-result.card` contributions of any kind (view, embed
   * or component; read live, no alias): a plugin tool's `ToolResult.card` must name one of them,
   * otherwise it is dropped with a warning.
   */
  inlineViews(plugin: string): ReadonlySet<string>;
  /**
   * 连接器在调用途中报告工具清单变了（MCP `notifications/tools/list_changed`）：内核安排一次该连接器的漂移检查。
   * 不等待、不抛错（实现自己吞掉错误）。
   */
  onToolsChanged(orgId: string, connectorId: string): void;
  /**
   * Dispatches the sub-agent of an `Agent` call (sub-agents spec §7.1; `dispatchSubagent`). Without
   * it, `Agent` calls reach the builtin's guard, which refuses them.
   */
  readonly subagents: { dispatch(a: DispatchArgs): Promise<DispatchOutcome> } | undefined;
  /**
   * `SendMessage` and `SubagentHandback` (agent map spec §4.2, §4.3; `SubagentMessages`). Without
   * it, their calls reach the builtins' guards, which refuse them.
   */
  readonly messages: Pick<SubagentMessages, "toChild" | "toParent"> | undefined;
  /**
   * The command review of a call the pipeline makes (auto mode spec §5.1, §5.4); absent (hand-built
   * pipelines): no call is reviewed. It never throws: any failure is an ask.
   */
  readonly review: CommandReview | undefined;
  /**
   * The facts a reviewed call's device has (mode, owner, workspace root); absent (hand-built
   * pipelines): no call is reviewed. Null facts (no device bound): the call is not reviewed.
   */
  readonly devices: Pick<ConversationDevices, "reviewFacts"> | undefined;
  /**
   * What a command's refused network hosts need (network ask-to-allow spec §6.2): the run tree's
   * network asks and the device's features and policy summary. Without them (hand-built test
   * pipelines) a report only writes `network_blocked`.
   */
  readonly network:
    | {
        /** `deviceId` scopes the run tree's asks to the device (ignored by an older provider). */
        grants: { runState(runId: string, deviceId?: string): Promise<NetworkRunState> };
        devices: Pick<DevicePolicyService, "summary">;
      }
    | undefined;
}

/** The sub-agent dispatch the pipeline calls (`SubagentsService.dispatch`). */
export type SubagentDispatch = NonNullable<PipelineDeps["subagents"]>["dispatch"];

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
  /** The run's trigger account (personal credentials, the audit actor). */
  accountId: string;
  /**
   * The conversation's source (memory plugin spec §6.2): extension tools limited by
   * `spec.sources` are resolved with it, and plugin handlers receive it.
   */
  source: ConversationSource;
  /** The conversation's owner (`conversations.account_id`), given to plugin handlers. */
  ownerAccountId: string;
  /** The trigger account's current org role, given to plugin handlers. */
  role: OrgRole;
  /** run 的中止信号（用户中止 / 截止时间）。 */
  signal: AbortSignal;
  /** run 的截止时间（epoch 毫秒）；传给内置工具（沙箱命令据此收紧超时，Ruling M20）。 */
  deadline?: number;
  /** Hooks fire only for `chat` conversations. */
  conversationKind?: ConversationKindForHooks;
  /**
   * Set when the run is a sub-agent's: its builtin tools use the root conversation's sandbox
   * (spec §10.1, agent map spec §6), and it dispatches sub-agents only below `subagents.maxDepth`.
   */
  parent?: SubagentParent;
  /**
   * The scheduled task run this run serves (scheduled tasks spec §7); filled by `runStep` once per
   * step from PG (`unattendedRunOf`), null when attended. Callers leave it unset.
   */
  unattended?: UnattendedRun | null;
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
  | {
      kind: "connection_required";
      connectorId: string;
      connectorName: string;
      connectorSlug: string;
      message: string;
    };

type ToolCall = { id: string; name: string; input: unknown };

/**
 * The tools the command review covers (auto mode spec §5.1): the shell and the file tools whose
 * writes may leave the workspace. Any other tool call is not reviewed (the review service answers
 * `allow` for it too; the pipeline skips the facts read).
 */
const REVIEWED_TOOL_KEYS: ReadonlySet<string> = new Set(["Bash", "Write", "Edit"]);

/** Whether the review holds a shell command or a file write, for the texts and the ask's detail. */
const reviewKindOf = (toolKey: string): "command" | "write" =>
  toolKey === "Bash" ? "command" : "write";

/** What the review stage found for one call (auto mode spec §5.4). */
type ReviewOutcome =
  /** Run the call; `review` is recorded on its result when the review ran. */
  | { kind: "continue"; review?: ReviewRecord | undefined; commandAsk?: ApprovalRecord }
  /** The run waits on the call's `command` approval. */
  | { kind: "wait"; wait: WaitingFor }
  /** The call ends now with this model-visible error result and its review record. */
  | { kind: "result"; content: string; review: ReviewRecord };

/** The review record of an allowed call. */
const allowRecord = (v: ReviewVerdict): ReviewRecord => ({
  decision: "allow",
  by: v.by,
  rule: v.rule,
  reason: v.reason,
});

/** The review record of a denied call (the rule table's, the classifier's or a person's). */
const denyRecord = (by: ReviewRecord["by"], rule: string | null, reason: string): ReviewRecord => ({
  decision: "deny",
  by,
  rule,
  reason,
});

/** A string field of a validated tool input, or "" (never another type). */
const textField = (input: unknown, field: string): string => {
  const v = (input as Record<string, unknown> | null)?.[field];
  return typeof v === "string" ? v : "";
};

/**
 * 审计链（spec 3.6 R6）里「凭什么放行」：在审批下执行（审批 id、批准人、范围）、记住的授权放行、或策略本身放行。
 * 续跑时「有开始无结果」的调用若没有已批准的审批，当时的放行依据已无从得知，不记（不猜）。
 */
type Authorization =
  | { approvalId: string; approvedByAccountId: string | null; scope: ApprovalScope | null }
  | { grant: GrantKind }
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

/** A network ask's kept display fields, written with its result when the ask settles. */
const keptExtras = (kept: NetworkAskDetail["result"] | undefined) => ({
  ...(kept?.outputId !== undefined && { outputId: kept.outputId }),
  ...(kept?.contentTypes !== undefined && { contentTypes: kept.contentTypes }),
  ...(kept?.display !== undefined && { display: kept.display }),
  ...(kept?.view !== undefined && { view: kept.view }),
});

/** A builtin result's kernel-internal network report (see `BuiltinResult.networkReport`). */
function networkReportOf(
  result: unknown,
): { deviceId: string; blocked: NetworkBlockedHost[] } | undefined {
  const r = (result as { networkReport?: unknown } | null)?.networkReport as
    | { deviceId?: unknown; blocked?: unknown }
    | undefined;
  if (r === undefined || typeof r.deviceId !== "string" || !Array.isArray(r.blocked)) {
    return undefined;
  }
  const blocked = r.blocked.filter(
    (b): b is NetworkBlockedHost =>
      typeof b === "object" &&
      b !== null &&
      typeof (b as NetworkBlockedHost).host === "string" &&
      typeof (b as NetworkBlockedHost).port === "number" &&
      ["device", "org", "address", "unknown"].includes((b as NetworkBlockedHost).layer),
  );
  return blocked.length === 0 ? undefined : { deviceId: r.deviceId, blocked };
}

/**
 * A kernel-internal device code (see `BuiltinResult.loginCode` and `KeptToolResult.loginCode`):
 * the shape is checked again here so a malformed value never reaches the log (the event schema
 * would throw).
 */
function validLoginCode(v: unknown): { url: string; code: string } | undefined {
  const r = v as { url?: unknown; code?: unknown } | null | undefined;
  if (
    r == null ||
    typeof r.url !== "string" ||
    typeof r.code !== "string" ||
    r.url !== GITHUB_DEVICE_LOGIN_URL ||
    !DEVICE_CODE_PATTERN.test(r.code)
  ) {
    return undefined;
  }
  return { url: r.url, code: r.code };
}

/** A builtin result's kernel-internal device code (`{ loginCode: { url, code } }`). */
function loginCodeOf(result: unknown): { url: string; code: string } | undefined {
  return validLoginCode((result as { loginCode?: unknown } | null)?.loginCode);
}

/**
 * The display-only `device_code` event of the call whose output carried the code (auto mode spec
 * §6, P-D13). The key is per (run, call), so a retry of that call appends it once; a different
 * call with the same code is deduplicated by value (`EventLog.deviceCodeShown`).
 */
function deviceCodeEvent(
  runId: string,
  step: number,
  callId: string,
  code: { url: string; code: string },
): AppendEvent {
  return {
    type: "device_code",
    runId,
    idemKey: deviceCodeIdemKey(runId, callId),
    payload: { step, callId, ...code },
  };
}

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
@Injectable()
export class ToolPipeline {
  private readonly decide: DecidePolicy;
  private readonly deps: PipelineDeps;

  constructor(
    @Inject(KernelDb) kdb: KernelDb,
    @Inject(EventLog) eventLog: EventLog,
    /** The `Agent` tool's sub-agent dispatch; absent (tests): `Agent` calls are refused. */
    @Inject(SubagentsService) subagents: Pick<SubagentsService, "dispatch"> | undefined,
    /** The message tools between agents; absent (tests): their calls are refused. */
    @Inject(SubagentMessages) messages: Pick<SubagentMessages, "toChild" | "toParent"> | undefined,
    @Inject(ToolRegistry) registry: Pick<ToolRegistry, "forAgent" | "findConnector" | "handler">,
    @Inject(Credentials) credentials: Pick<Credentials, "injection" | "onUnauthorized">,
    @Inject(Breaker) breaker: Pick<Breaker, "check" | "failure" | "success">,
    @Inject(ToolOutputs) outputs: Pick<ToolOutputs, "save" | "load">,
    @Inject(ApprovalsService)
    approvals: Pick<
      ApprovalsService,
      | "request"
      | "forCall"
      | "networkForCall"
      | "requestNetwork"
      | "commandForCall"
      | "requestCommand"
    >,
    @Inject(QuestionsService) questions: Pick<QuestionsService, "ask" | "forCall">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) log: Logger,
    /** Plugin hooks and inline ui contributions; absent (tests): no hooks, cards dropped. */
    @Inject(ExtensionHost) host: Pick<ExtensionHost, "hooks" | "current"> | undefined,
    @Inject(ToolDrift) drift: Pick<ToolDrift, "onToolsChanged"> | undefined,
    @Inject(EffectiveConfigs) effective: Pick<EffectiveConfigs, "get">,
    @Inject(OrgToolSwitches) switches: Pick<OrgToolSwitches, "isToolOff">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Optional() @Inject(TOOL_PIPELINE_HOOKS) hooks?: ToolPipelineHooks,
    @Optional()
    @Inject(NetworkGrants)
    networkGrants?: { runState(runId: string, deviceId?: string): Promise<NetworkRunState> },
    @Optional() @Inject(DevicePolicyService) devicePolicy?: Pick<DevicePolicyService, "summary">,
    /** The command review (auto mode spec §5.4); absent in hand-built pipelines. */
    @Optional() @Inject(CommandReviewService) review?: CommandReview,
    /** The reviewed call's device facts; absent in hand-built pipelines. */
    @Optional()
    @Inject(ConversationDevices)
    devices?: Pick<ConversationDevices, "reviewFacts">,
  ) {
    this.deps = {
      get db() {
        return kdb.db;
      },
      eventLog,
      registry,
      credentials,
      breaker,
      outputs,
      approvals,
      questions,
      log,
      hooks,
      get pluginHooks() {
        return host?.hooks;
      },
      effective,
      switches,
      inlineViews: (plugin) =>
        new Set(
          (host?.current(plugin)?.ui ?? [])
            .filter(
              (r) =>
                r.slot.id === "conversation.tool-result.card" &&
                r.contribution.aliasOf === undefined,
            )
            .map((r) => r.contribution.id),
        ),
      onToolsChanged: (orgId, connectorId) => {
        void drift?.onToolsChanged(orgId, connectorId);
      },
      get subagents() {
        return subagents ? { dispatch: (a: DispatchArgs) => subagents.dispatch(a) } : undefined;
      },
      messages,
      review,
      devices,
      network:
        networkGrants && devicePolicy
          ? { grants: networkGrants, devices: devicePolicy }
          : undefined,
    };
    const decide = hooks?.decidePolicy;
    // the default policy reads live, on the context's handle
    this.decide = decide ?? ((tool, def, c) => createDecidePolicy(kdb.db)(tool, def, c));
  }

  /**
   * tools 节点：按顺序处理本步 assistant 消息里的全部 `tool_call`，每个调用都以一条 `tool_result` 结束
   * （之后才回到 prepare 构建下一次请求，保持「已记录调用、未记录结果之间不构建请求」的不变式）。
   * 已有结果 → 跳过；有开始无结果 → 结果未知；run 已中止 → 不执行。
   * 某个调用需要等人处理（审批 / 用户输入）→ 返回 `suspended`，之后的调用留到续跑时处理；
   * 续跑时重新进入本函数，按 PG 里的审批 / 输入请求结果继续。
   */
  async runStep(given: ToolStepContext): Promise<ToolStepOutcome> {
    let ctx = given;
    const { eventLog } = this.deps;
    const msg = await eventLog.findByIdem(
      ctx.conversationId,
      assistantIdemKey(ctx.runId, ctx.step),
    );
    if (msg?.type !== "assistant_message") return { kind: "done" };
    const calls = msg.payload.content.flatMap((b) =>
      b.type === "tool_call" ? [{ id: b.id, name: b.name, input: b.input }] : [],
    );
    // scheduled tasks spec §7: read live for each step (a person's message absorbed since makes the
    // rest of the run attended)
    if (calls.length > 0 && ctx.unattended === undefined) {
      ctx = {
        ...ctx,
        unattended: await unattendedRunOf(this.deps.db, this.config, ctx.orgId, ctx.runId),
      };
    }
    let resolved: Resolved | undefined;
    const resolve = async (): Promise<Resolved> => {
      // 每步实时解析（连接器 / 插件状态可能在模型调用之后变化）
      if (!resolved) {
        // the request builder's rule: a skills catalog snapshot (even an empty one) or a person's
        // skill invocation in the log → Skill is offered (see skillLoadOffered)
        const skillLoad = await skillLoadOfferedIn(
          this.deps.db,
          this.deps.eventLog,
          ctx.conversationId,
        );
        resolved = await this.deps.registry.forAgent(ctx.orgId, {
          disabledTools: ctx.agent.disabledTools,
          subagentTools: ctx.agent.subagentTools,
          skillLoad,
          subagents: ctx.agent.subagents,
          child: ctx.parent !== undefined,
          forkChild: ctx.parent?.forSkill === true,
          sandboxConversationId: ctx.parent?.rootConversationId ?? ctx.conversationId,
          replay: ctx.conversationKind === "eval",
          source: ctx.source,
        });
      }
      return resolved;
    };
    // an `Agent` call's dispatch writes its result (the sub-agent runs in the background, agent
    // map spec §4.1), so no call keeps the step waiting on a sub-agent
    for (const call of calls) {
      if (await eventLog.findByIdem(ctx.conversationId, idem.result(ctx.runId, call.id))) continue;
      const waitingFor = await this.processCall(ctx, call, resolve);
      if (waitingFor) return { kind: "suspended", waitingFor };
    }
    return { kind: "done" };
  }

  /**
   * Writes, in the caller's transaction (`mandatory`), what a run that is being stopped (a person,
   * its deadline, a failure, an orphan repair) still owes its log: the report of its fork invocation
   * (phase D, `pairStoppedForks`; a still active fork child is stopped by the caller after its
   * commit). An `Agent` call has its result from its dispatch (agent map spec §4.1), so there is
   * nothing to write for it. Returns the fork's call id (the caller must not write a "not executed"
   * result for it), the highest seq written, and `fire`, a no-op kept for the callers' hook phase.
   */
  @Transactional({ propagation: "mandatory" })
  async stopOpenAgentCalls(
    runId: string,
  ): Promise<{ steps: number[]; callIds: Set<string>; toSeq: number | null; fire: () => void }> {
    const forks = await pairStoppedForks(this.deps.db, this.deps.eventLog, runId);
    return { steps: [], callIds: new Set(forks.callIds), toSeq: forks.toSeq, fire: () => {} };
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
    // skipped by the starter's message: the kernel writes the result, the tool is not called again
    // (spec D6: an extension would only see `answer: null`, an MCP call would be re-sent)
    if (last?.status === "skipped") {
      await this.writeResult(ctx, call.id, last.toolKey, skippedResult(last.toolKey));
      return undefined;
    }
    const attempt = rounds.length + 1;
    const started = await this.deps.eventLog.findByIdem(
      ctx.conversationId,
      idem.started(ctx.runId, call.id, attempt),
    );
    if (started?.type === "tool_call_started") {
      // a command that ran and was refused a network host waits for the device owner (network
      // ask-to-allow spec §6.2, P-D2): pending → wait on; settled → its kept result and the
      // outcome's note (the command is never run again; its tool.called was audited when it ran)
      const ask = await this.deps.approvals.networkForCall(ctx.runId, call.id);
      if (ask !== null) {
        const notes = settledNetworkNotes(ask, approvalHours(ask));
        if (notes === null) return approvalWait(ask);
        const kept = ask.detail?.result;
        // the device code the command printed is carried in the kept result: write its
        // display-only event here too (a crash before the ask's first write, or an older kept
        // result; the event's ids and the per-conversation code check keep it to one)
        const keptCode = validLoginCode(kept?.loginCode);
        const pre: AppendEvent[] =
          keptCode !== undefined &&
          !(await this.deps.eventLog.deviceCodeShown(ctx.conversationId, keptCode.code))
            ? [deviceCodeEvent(ctx.runId, ctx.step, call.id, keptCode)]
            : [];
        await this.writeResult(
          ctx,
          call.id,
          call.name,
          {
            ...keptExtras(kept),
            content: withNetworkNotes(kept?.content ?? UNKNOWN_RESULT_TEXT, notes),
            isError: kept?.isError ?? true,
            ...(kept?.review !== undefined && { review: kept.review }),
          },
          pre,
        );
        return undefined;
      }
      // 确实开始执行过：照样审计 tool.called（耗时未知）；放行依据只认批准了所执行定义的审批记录
      const key = started.payload.toolKey;
      const approval = await this.deps.approvals.forCall(ctx.runId, call.id);
      const approved =
        approval?.status === "approved" && approval.specHash === started.payload.specHash
          ? approval
          : null;
      // a command that ran under the person's `command` approval: its review record and
      // authorization survive the lost result too (the ask is the whole truth on a resume)
      const commandAsk = await this.deps.approvals.commandForCall(ctx.runId, call.id);
      const command = commandAsk?.status === "approved" ? commandAsk : null;
      const authorization =
        approved !== null
          ? approvalAuthorization(approved)
          : command !== null
            ? approvalAuthorization(command)
            : null;
      const source = approved ? null : (await resolve()).tools.find((t) => t.key === key)?.source;
      await this.writeResult(
        ctx,
        call.id,
        key,
        {
          content: UNKNOWN_RESULT_TEXT,
          isError: true,
          ...(command !== null && { review: this.personAllowRecord(command) }),
        },
        [],
        {
          durationMs: null,
          connectorId: approved
            ? approved.connectorId
            : source?.kind === "connector"
              ? source.connectorId
              : null,
          ...(authorization !== null && { authorization }),
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
    // the command review's record for this call's result (absent: not reviewed, or no device)
    let review: ReviewRecord | undefined;
    const fail = async (content: string, key = call.name, view?: ToolView): Promise<undefined> => {
      await this.writeResult(ctx, call.id, key, {
        content,
        isError: true,
        ...(view !== undefined && { view }),
        ...(review !== undefined && { review }),
      });
      return undefined;
    };

    let tool = resolved.tools.find((t) => t.key === call.name);
    // A call logged before the tool keys were renamed (spec 8.1): the request that issued it offered
    // the old key. It runs as the current tool with translated input; the result keeps the logged key.
    let legacy = false;
    if (!tool) {
      const next = legacyToolKey(call.name, legacyScopeOf(resolved.tools));
      const current = next === null ? undefined : resolved.tools.find((t) => t.key === next);
      if (current && (await this.requestToolKeys(ctx))?.has(call.name) === true) {
        tool = current;
        legacy = true;
      }
    }
    if (!tool) {
      const why =
        resolved.unavailable.find((u) => u.ref === call.name) ??
        resolved.hidden?.find((u) => u.ref === call.name);
      if (why) return fail(unavailableText(call.name, why.reason));
      let keys = resolved.tools.map((t) => t.key);
      // ToolSearch 模式：目录可能很大，只列内置工具与发出本次调用的请求里带了定义的工具
      if (resolved.toolSearch === true) {
        const sent = await this.sentTools(ctx);
        if (sent !== null) keys = keys.filter((k) => isAlwaysLoaded(k) || sent.has(k));
      }
      keys.sort();
      return fail(
        unknownToolText(call.name, keys, keys.includes(TOOL_SEARCH), legacyHint(call.name)),
      );
    }
    const outKey = legacy ? call.name : tool.key;
    // ToolSearch 模式下，模型只能调用请求里带了完整定义的工具：目录里有、但发出本次调用的请求没加载 →
    // 明确错误，不自动加载（spec 5.5 / 6.3）。同一步里先 ToolSearch 再调用刚加载的工具同样报错。
    // This is the protocol working, not a failure: the `not_loaded` view lets the row read neutral.
    if (!legacy && resolved.toolSearch === true && !isAlwaysLoaded(tool.key)) {
      const sent = await this.sentTools(ctx);
      if (sent !== null && !sent.has(tool.key))
        return fail(notLoadedText(tool.key), outKey, { kind: "not_loaded" });
    }

    const rawInput = legacy ? legacyToolInput(call.name, call.input) : call.input;
    let input: unknown;
    try {
      input = await resolveOutputRefs(rawInput, (id) =>
        this.deps.outputs.load({ orgId: ctx.orgId, conversationId: ctx.conversationId }, id),
      );
    } catch (e) {
      if (e instanceof ToolError) return fail(e.message, outKey);
      throw e;
    }
    // 连接器工具的 schema 来自连接器（不受信任）：去掉有风险的关键字并限制大小 / 层数
    const invalid = validateInput(tool.key, tool.spec, input, {
      untrusted: tool.source.kind === "connector",
      log: this.deps.log,
    });
    if (invalid !== null) return fail(invalid, outKey);

    // the per-call policy key (Platform tool spec §6.2): key and summary come from the resolved
    // input, while the approval binding below compares the raw call.input
    const callPolicy =
      (await tool.callPolicy?.(input, {
        orgId: ctx.orgId,
        accountId: ctx.accountId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        rawInput,
        signal: ctx.signal,
      })) ?? null;
    // a deny with a reason (e.g. an unavailable operation): the reason is the tool error
    if (callPolicy?.policy === "deny" && callPolicy.denyReason !== undefined) {
      return fail(callPolicy.denyReason, outKey);
    }
    const policyKey = callPolicy?.key ?? tool.key;

    const decision = await this.decide(tool, ctx.agent, {
      orgId: ctx.orgId,
      accountId: ctx.accountId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      ...(ctx.parent !== undefined && {
        parentConversationId: ctx.parent.conversationId,
        rootConversationId: ctx.parent.rootConversationId,
        ...(ctx.parent.otherAgent !== undefined && { parentAgentDiffers: ctx.parent.otherAgent }),
      }),
      callPolicy,
      ...(ctx.unattended != null && { unattended: ctx.unattended }),
    });
    if (decision === "deny") return fail(deniedText(tool.key, callPolicy?.key), outKey);
    if (typeof decision === "object" && "refused" in decision) {
      if (decision.missingGrant !== undefined && ctx.unattended != null) {
        await appendMissingGrant(this.deps.db, ctx.unattended.taskRunId, decision.missingGrant);
      }
      return fail(decision.refused, outKey);
    }
    if (typeof decision === "object" && "unavailable" in decision) {
      return fail(unavailableText(tool.key, decision.unavailable), outKey);
    }
    // 该调用已有审批（续跑）→ 按审批结果；没有且策略为 ask → 建审批并等待
    // （不写 tool_call_started：此时尚未开始执行）。
    let approval = await this.deps.approvals.forCall(ctx.runId, call.id);
    // 批准的是旧定义（等待期间工具定义变了）：原批准不适用于当前定义，策略仍需审批时按新定义重新审批。
    // An in-flight rc call (spec §9) is the exception: its approval was asked under the rc definition
    // of the same call, and the rename changed every builtin's definition; the person approved this
    // very call, so the approval stands.
    // An approval binds the exact input it showed (Platform tool spec §6.3): an approved record
    // whose stored input differs from the call's is not used.
    const approvedHere =
      approval?.status === "approved" &&
      (legacy || approval.specHash === tool.specHash) &&
      canonicalJson(approval.input) === canonicalJson(call.input ?? {});
    const stale = approval?.status === "approved" && !approvedHere;
    if ((!approval || stale) && typeof decision === "object" && "ask" in decision) {
      approval = await this.deps.approvals.request({
        attempt: (approval?.attempt ?? 0) + 1,
        orgId: ctx.orgId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        step: ctx.step,
        callId: call.id,
        toolKey: policyKey,
        specHash: decision.ask.specHash,
        connectorId: decision.ask.connectorId,
        input: call.input,
        requestedFor: decision.ask.requestedFor,
        approverRole: decision.ask.approverRole,
        policy: decision.ask.policy,
        ...(callPolicy?.summary !== undefined && { summary: callPolicy.summary }),
        ...(callPolicy !== null && !callPolicy.remember && { scopes: ["once"] }),
      });
    }
    if (approval && approval.status !== "approved") {
      const refused = this.refusalText(approval);
      return refused === null ? approvalWait(approval) : fail(refused, outKey);
    }
    // 走到这里即放行：在（与当前定义一致的）审批下执行，否则是授权或策略放行
    let authorization: Authorization =
      approval?.status === "approved" && approvedHere
        ? approvalAuthorization(approval)
        : typeof decision === "object" && "grant" in decision
          ? { grant: decision.grant }
          : { policy: "allow" };

    // Auto mode spec §5.1: the command review, after argument validation and the tool policy (and
    // its approval), before the plugin hooks and `tool_call_started`. A deny ends the call here; an
    // ask parks the run on the command approval (attended) or is a deny at once (unattended). An
    // already decided command approval resumes the call without re-reviewing.
    const reviewed = await this.reviewCall(ctx, call, tool, input);
    if (reviewed.kind === "wait") return reviewed.wait;
    if (reviewed.kind === "result") {
      review = reviewed.review;
      return fail(reviewed.content, outKey);
    }
    review = reviewed.review;
    if (reviewed.commandAsk !== undefined)
      authorization = approvalAuthorization(reviewed.commandAsk);

    // tool.preExecute after policy and approval, before tool_call_started (F10)
    const hooks = this.deps.pluginHooks;
    const scope = hookScope(hooks, ctx);
    if (scope && hooks?.has("tool.preExecute")) {
      // sticky: a denial already logged for this call (e.g. an older log, or a crash right after it)
      // is final: fail with the recorded reason, never re-run the hooks or execute the tool. Only
      // looked up when a tool.preExecute hook could run (M-2: no query without hooks); a denial is
      // written with the call's tool_result, so a call with a logged denial never runs again anyway.
      const prior = await this.deps.eventLog.findByIdem(
        ctx.conversationId,
        idem.hookDenied(ctx.runId, call.id),
      );
      if (prior?.type === "hook_denied") {
        return fail(hookDeniedText(prior.payload.plugin, prior.payload.reason), outKey);
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
        if (ctx.signal.aborted) return fail(RUN_STOPPED_TEXT, outKey);
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
          outKey,
          {
            content: hookDeniedText(verdict.plugin, verdict.reason),
            isError: true,
            ...(review !== undefined && { review }),
          },
          [event],
          undefined,
          [hookDeniedAudit(site, event.payload, verdict)],
        );
        return undefined;
      }
    }

    // `Agent` (sub-agents spec §7.1, agent map spec §4.1): no tool_call_started; one transaction
    // makes the dispatch durable (its marker is the subagent_dispatches row) and writes the call's
    // immediate result, while the sub-agent runs in the background
    const dispatcher = this.deps.subagents;
    if (tool.source.kind === "builtin" && tool.key === AGENT_TOOL && dispatcher) {
      const parsed = AgentToolInput.safeParse(input);
      if (!parsed.success) {
        return fail(
          "Invalid agent call: pass description and prompt, and optionally subagent_type and model.",
          outKey,
        );
      }
      const r = await dispatcher.dispatch({
        ctx,
        callId: call.id,
        input: parsed.data,
        call: { toolKey: outKey, authorization, startedAt: Date.now() },
      });
      if (r.kind === "refused") return fail(r.content, outKey);
      if (hooks && hookBase) {
        fireObserve(
          hooks,
          "tool.postExecute",
          {
            ...hookBase,
            isError: false,
            content: r.content,
            durationMs: 0,
          },
          ctx.signal,
          this.deps.log,
        );
      }
      return undefined;
    }

    // `SendMessage` and `SubagentHandback` (agent map spec §4.2, §4.3): no tool_call_started; each
    // write is idempotent by the call (the message in the sub-agent's log, the delivery in the
    // parent's), so a call retried after a crash sends nothing twice. A send that starts an idle
    // sub-agent writes its result with the dispatch, like `Agent`
    const messenger = this.deps.messages;
    if (
      tool.source.kind === "builtin" &&
      (tool.key === SEND_MESSAGE || tool.key === SUBAGENT_HANDBACK) &&
      messenger
    ) {
      const t0 = Date.now();
      let r: MessageOutcome;
      if (tool.key === SEND_MESSAGE) {
        const parsed = SendMessageInput.safeParse(input);
        if (!parsed.success) {
          return fail("Invalid SendMessage call: pass to and message.", outKey);
        }
        r = await messenger.toChild(ctx, call.id, parsed.data.to, parsed.data.message, {
          authorization,
        });
      } else {
        const parsed = HandbackInput.safeParse(input);
        if (!parsed.success) return fail("Invalid SubagentHandback call: pass message.", outKey);
        r = await messenger.toParent(ctx, "report", parsed.data.message, call.id);
      }
      if (r.isError) return fail(r.content, outKey);
      const durationMs = Date.now() - t0;
      if (r.logged !== true) {
        await this.writeResult(ctx, call.id, outKey, { content: r.content, isError: false }, [], {
          durationMs,
          connectorId: null,
          authorization,
        });
      }
      if (hooks && hookBase) {
        fireObserve(
          hooks,
          "tool.postExecute",
          { ...hookBase, isError: false, content: r.content, durationMs },
          ctx.signal,
          this.deps.log,
        );
      }
      return undefined;
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

    // scheduled tasks spec §7, `fail` mode: no one answers an input request or connects an app
    if (unattendedFails(ctx.unattended) && ctx.unattended != null) {
      if (outcome.kind === "input_required") {
        outcome = { kind: "error", message: UNATTENDED_QUESTION_ERROR };
      } else if (outcome.kind === "connection_required") {
        await appendMissingGrant(
          this.deps.db,
          ctx.unattended.taskRunId,
          connectionGrantKey(outcome.connectorSlug),
        );
        outcome = { kind: "error", message: UNATTENDED_CONNECTION_ERROR(outcome.connectorName) };
      }
    }
    if (outcome.kind === "input_required") {
      const asked = await this.askInput(ctx, call.id, tool.key, attempt, outcome);
      if (typeof asked !== "string") return asked;
      outcome = { kind: "error", message: asked };
    }

    const rendered =
      outcome.kind === "result"
        ? renderResult(outcome.result)
        : { text: outcome.message, contentTypes: [], isError: true };
    // 内置工具（ToolSearch）报告的已加载工具：只认本步可用、非内置的 key，写进 tool_result（日志即事实源）
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
    // structured view: builtins only (extension and connector results never carry one)
    const view =
      outcome.kind === "result" && tool.source.kind === "builtin"
        ? this.viewOf(outcome.result, tool.key)
        : undefined;
    // inline card: plugin tools only, naming an inline view of the same extension
    const card =
      outcome.kind === "result" && tool.source.kind === "plugin"
        ? this.cardOf(outcome.result, tool.source.plugin, tool.key)
        : undefined;
    // a `gh auth login --web` device code (`Bash`; auto mode spec §6): display only, written under
    // this call before its result, never part of the result or the request the model sees
    const loginCode =
      outcome.kind === "result" && tool.source.kind === "builtin"
        ? loginCodeOf(outcome.result)
        : undefined;
    const cfg = this.config.get().tools;
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
    if (
      loginCode !== undefined &&
      !(await this.deps.eventLog.deviceCodeShown(ctx.conversationId, loginCode.code))
    ) {
      // the per-call id makes a retry or a resumed run append it once; a second call (a task read
      // again, another command printing the same code) does not show the same code twice (P-D13)
      pre.push(deviceCodeEvent(ctx.runId, ctx.step, call.id, loginCode));
    }
    const callAudit: CallAudit = {
      durationMs,
      connectorId: tool.source.kind === "connector" ? tool.source.connectorId : null,
      authorization,
    };
    // a foreground command refused network hosts (network ask-to-allow spec §6.2): display-only
    // `network_blocked` before the result, then an ask to the device owner (the run waits; the
    // result is written when the ask settles) or notes after the output
    const report =
      outcome.kind === "result" && tool.source.kind === "builtin"
        ? networkReportOf(outcome.result)
        : undefined;
    let content = spilled.content;
    if (report !== undefined) {
      const handled = await this.networkBlocked(
        ctx,
        call.id,
        outKey,
        input,
        report,
        pre,
        callAudit,
        {
          text: rendered.text,
          content: spilled.content,
          isError: rendered.isError,
          ...(spilled.outputId !== undefined && { outputId: spilled.outputId }),
          ...(rendered.contentTypes.length > 0 && { contentTypes: rendered.contentTypes }),
          ...(display !== undefined && { display }),
          ...(view !== undefined && { view }),
          ...(review !== undefined && { review }),
          // carried into the kept result so a resumed run writes the event too (it was written
          // with `network_blocked` below when the ask was created)
          ...(loginCode !== undefined && { loginCode }),
        },
      );
      if (handled.kind === "wait") {
        if (hooks && hookBase) {
          fireObserve(
            hooks,
            "tool.postExecute",
            { ...hookBase, isError: rendered.isError, content: handled.content, durationMs },
            ctx.signal,
            this.deps.log,
          );
        }
        return handled.wait;
      }
      if (handled.event !== null) pre.push(handled.event);
      content = withNetworkNotes(content, handled.notes);
    }
    await this.writeResult(
      ctx,
      call.id,
      outKey,
      {
        content,
        isError: rendered.isError,
        ...(spilled.outputId !== undefined && { outputId: spilled.outputId }),
        ...(rendered.contentTypes.length > 0 && { contentTypes: rendered.contentTypes }),
        ...(loadedTools.length > 0 && { loadedTools }),
        ...(display !== undefined && { display }),
        ...(view !== undefined && { view }),
        ...(card !== undefined && { card }),
        ...(review !== undefined && { review }),
      },
      pre,
      callAudit,
    );
    // a sub-agent that needs a personal connection: mirrored in the root conversation of its tree
    // for display (sub-agents spec §9, agent map spec §7; not a wait, the child got the connect
    // text as its result)
    if (outcome.kind === "connection_required" && ctx.parent !== undefined) {
      await this.surfaceConnectInRoot(ctx, ctx.parent, call.id, tool.key).catch((err: unknown) =>
        this.deps.log.warn("cannot surface a sub-agent's connect card in its root conversation", {
          runId: ctx.runId,
          err,
        }),
      );
    }
    if (hooks && hookBase) {
      fireObserve(
        hooks,
        "tool.postExecute",
        { ...hookBase, isError: rendered.isError, content, durationMs },
        ctx.signal,
        this.deps.log,
      );
    }
    return undefined;
  }

  /**
   * The command review of one call (auto mode spec §5.1, §5.4), after argument validation and the
   * tool policy (and its approval), before the plugin hooks and execution. The device facts come
   * from the same `ConversationDevices.forTool` the tool enters; with no device (or a deployment
   * without a review service) the call runs unreviewed and fails on its own if it cannot. A deny is
   * final whatever the mode and approvals; an `ask` waits for the device owner's `command` approval
   * when the run is attended, and is a deny at once when it is not. A command approval already
   * asked is the whole truth on a resume: the call is never reviewed twice.
   */
  private async reviewCall(
    ctx: ToolStepContext,
    call: ToolCall,
    tool: ResolvedTool,
    input: unknown,
  ): Promise<ReviewOutcome> {
    const review = this.deps.review;
    const devices = this.deps.devices;
    if (review === undefined || devices === undefined) return { kind: "continue" };
    if (!REVIEWED_TOOL_KEYS.has(tool.key)) return { kind: "continue" };
    const asked = await this.deps.approvals.commandForCall(ctx.runId, call.id);
    if (asked !== null) return this.settledCommandAsk(asked, tool.key);
    const rootConversationId = ctx.parent?.rootConversationId ?? ctx.conversationId;
    const facts = await devices.reviewFacts(ctx.orgId, rootConversationId, ctx.conversationId);
    if (facts === null) return { kind: "continue" }; // no device: the tool fails on its own
    const kind = reviewKindOf(tool.key);
    const attended = ctx.unattended == null && ctx.accountId === facts.ownerAccountId;
    // a command over the ceiling is refused before any review: no stage reads it in full, and no
    // approval could bind a text the person cannot see (hardening spec R8)
    if (kind === "command") {
      const text = textField(input, "command");
      if (text.length > COMMAND_ASK_MAX_CHARS) {
        return {
          kind: "result",
          content: commandTooLongText(text.length),
          review: denyRecord("rule", null, commandTooLongReason(text.length)),
        };
      }
    }
    const verdict = await review.review({
      orgId: ctx.orgId,
      conversationId: rootConversationId,
      runId: ctx.runId,
      accountId: ctx.accountId,
      toolKey: tool.key,
      input,
      mode: facts.mode,
      workspace: facts.workspace,
      attended,
      step: ctx.step,
      callId: call.id,
      signal: ctx.signal,
      ...(ctx.parent !== undefined && {
        parentRunId: ctx.parent.runId,
        ...(ctx.parent.budgetRunId !== undefined && { budgetRunId: ctx.parent.budgetRunId }),
        parent: {
          conversationId: ctx.parent.conversationId,
          runId: ctx.parent.runId,
          callId: ctx.parent.callId,
        },
      }),
      agentId: ctx.agentId,
      agentVersion: ctx.agentVersion,
      ...(ctx.conversationKind !== undefined && { conversationKind: ctx.conversationKind }),
    });
    if (verdict.decision === "allow") {
      return { kind: "continue", review: allowRecord(verdict) };
    }
    if (verdict.decision === "deny") {
      return {
        kind: "result",
        content: commandDeniedText(verdict.reason, kind),
        review: denyRecord(verdict.by, verdict.rule, verdict.reason),
      };
    }
    // ask
    const command = kind === "command" ? textField(input, "command") : tool.key;
    if (!attended) {
      const reason = verdict.reason;
      return {
        kind: "result",
        content: commandUnattendedText(reason, kind),
        review: denyRecord(verdict.by, verdict.rule, reason),
      };
    }
    const detail: CommandAskDetail = {
      deviceId: facts.deviceId,
      deviceName: facts.deviceName,
      mode: facts.mode,
      kind,
      // the whole command the approval covers (the event keeps a clamped copy for display)
      command,
      ...(kind === "write" && { path: clipText(textField(input, "file_path"), 4096) }),
      rule: verdict.rule,
      reason: clipText(verdict.reason, COMMAND_ASK_TEXT_MAX_CHARS),
    };
    let ask: ApprovalRecord;
    try {
      ask = await this.deps.approvals.requestCommand({
        orgId: ctx.orgId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        step: ctx.step,
        callId: call.id,
        requestedFor: facts.ownerAccountId,
        detail,
        // `once` always; `session` only for a concrete rule class, never an `unsure.*` catch-all (P-D2)
        scopes: isSessionGrantableRule(verdict.rule) ? ["once", "session"] : ["once"],
      });
    } catch (err) {
      // fail closed: an ask that cannot be created is a deny, never a run of the held call
      this.deps.log.warn("command ask could not be created; denying the call", {
        conversationId: ctx.conversationId,
        callId: call.id,
        err,
      });
      const reason = "The approval could not be created";
      return {
        kind: "result",
        content: commandDeniedText(reason, kind),
        review: denyRecord(verdict.by, verdict.rule, reason),
      };
    }
    return { kind: "wait", wait: approvalWait(ask) };
  }

  /** The outcome of a call whose `command` approval was already asked (a resume). */
  private settledCommandAsk(ask: ApprovalRecord, toolKey: string): ReviewOutcome {
    const kind = reviewKindOf(toolKey);
    const rule = ask.command?.rule ?? null;
    if (ask.status === "pending") return { kind: "wait", wait: approvalWait(ask) };
    if (ask.status === "approved") {
      return { kind: "continue", commandAsk: ask, review: this.personAllowRecord(ask) };
    }
    if (ask.status === "denied") {
      const reason = ask.denyReason;
      return {
        kind: "result",
        content: commandDeclinedText(reason, kind),
        review: denyRecord("person", rule, reason ?? "The user declined."),
      };
    }
    const text =
      ask.status === "expired" ? approvalExpiredText(approvalHours(ask)) : APPROVAL_CANCELLED_TEXT;
    return { kind: "result", content: text, review: denyRecord("person", rule, text) };
  }

  /**
   * The review record of a command (or write) the person allowed: its scope, and for a shell
   * command the SHA-256 of the text the ask holds in full, so an audit can match record and text.
   */
  private personAllowRecord(ask: ApprovalRecord): ReviewRecord {
    return {
      decision: "allow",
      by: "person",
      rule: ask.command?.rule ?? null,
      reason: ask.command?.reason ?? "The user allowed this call.",
      ...((ask.scope === "once" || ask.scope === "session") && { scope: ask.scope }),
      ...(ask.command !== null &&
        ask.command.kind === "command" && {
          commandHash: sha256Hex(ask.command.command),
        }),
    };
  }

  /**
   * A foreground command's refused network hosts (network ask-to-allow spec §6.2, §6.8, §8.3):
   * the `network_blocked` event, the missing grants of an unattended run, and either notes for the
   * result written now, or (device-layer hosts worth asking) `network_blocked` and the call's
   * `tool.called` audit written now, the result kept in a network ask to the device's owner and
   * the run's wait. The kept result is the formatted one (≤ 16 KB: larger output is archived)
   * followed by the notes written now; it is written with the decision's note when the ask
   * settles (P-D2).
   */
  private async networkBlocked(
    ctx: ToolStepContext,
    callId: string,
    toolKey: string,
    input: unknown,
    report: { deviceId: string; blocked: NetworkBlockedHost[] },
    pre: readonly AppendEvent[],
    callAudit: CallAudit,
    result: NetworkAskDetail["result"] & { text: string; review?: ReviewRecord },
  ): Promise<
    | { kind: "wait"; wait: WaitingFor; content: string }
    | { kind: "write"; event: AppendEvent | null; notes: string[] }
  > {
    const hosts = blockedEventHosts(report.blocked);
    if (hosts.length === 0) return { kind: "write", event: null, notes: [] };
    const event: AppendEvent = {
      type: "network_blocked",
      runId: ctx.runId,
      idemKey: networkBlockedIdemKey(ctx.runId, callId),
      payload: { step: ctx.step, callId, hosts },
    };
    const network = this.deps.network;
    if (network === undefined) return { kind: "write", event, notes: [] };
    const device = await network.devices.summary(report.deviceId);
    const run = hosts.some((h) => h.layer === "device")
      ? await network.grants.runState(ctx.runId, report.deviceId)
      : null;
    const plan = planNetworkAsk(hosts, run, { device, unattended: ctx.unattended });
    if (ctx.unattended != null) {
      for (const key of plan.missingGrants) {
        await appendMissingGrant(this.deps.db, ctx.unattended.taskRunId, key);
      }
    }
    if (plan.ask.length === 0) return { kind: "write", event, notes: plan.notes };
    // the device's owner is the only person who may decide (spec §5.2)
    const owner = await this.deps.db
      .selectFrom("devices")
      .select("owner_account_id")
      .where("id", "=", report.deviceId)
      .where("org_id", "=", ctx.orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (owner === undefined) return { kind: "write", event, notes: plan.notes };

    let { content, outputId } = result;
    if (Buffer.byteLength(content, "utf8") > NETWORK_ASK_KEPT_MAX_BYTES && outputId === undefined) {
      // output under the spill threshold but over what an ask keeps: archive it after all
      const spilled = await spillIfLarge(
        result.text,
        { spillChars: 0, previewChars: this.config.get().tools.outputPreviewChars },
        (c) =>
          this.deps.outputs.save({
            orgId: ctx.orgId,
            conversationId: ctx.conversationId,
            callId,
            content: c,
          }),
      );
      content = spilled.content;
      outputId = spilled.outputId;
    }
    const { text: _text, ...rest } = result;
    const kept: NetworkAskDetail["result"] = {
      ...rest,
      content: withNetworkNotes(clipKept(content), plan.notes),
      ...(outputId !== undefined && { outputId }),
    };
    // the command ran: the call's display-only events (a `device_code`) and network_blocked with
    // its tool.called now, the result once the ask settles
    const written = await this.writeResultIn(
      ctx,
      callId,
      toolKey,
      { isError: result.isError },
      [...pre, event],
      callAudit,
      [],
    );
    await this.deps.eventLog.notify(ctx.conversationId, Math.max(...written.map((e) => e.seq)));
    const given = (input ?? {}) as { command?: unknown; description?: unknown };
    const ask = await this.deps.approvals.requestNetwork({
      orgId: ctx.orgId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      step: ctx.step,
      callId,
      requestedFor: owner.owner_account_id,
      detail: {
        deviceId: report.deviceId,
        hosts: plan.ask,
        command: typeof given.command === "string" ? clipText(given.command, 2000) : "",
        description: typeof given.description === "string" ? given.description : null,
        result: kept,
      },
      scopes: plan.scopes,
    });
    return { kind: "wait", wait: approvalWait(ask), content: kept.content };
  }

  /** Appends a sub-agent's connect card to its root conversation ({@link rootSurfaceOf}). */
  private async surfaceConnectInRoot(
    ctx: ToolStepContext,
    parent: SubagentParent,
    callId: string,
    toolKey: string,
  ): Promise<void> {
    const target = await rootSurfaceOf(this.deps.db, ctx.conversationId, ctx.runId, parent);
    if (!target) return;
    await this.deps.eventLog.append(target.conversationId, [
      {
        type: "subagent_waiting",
        runId: target.runId,
        idemKey: subagentWaitingIdemKey(ctx.runId, `connect-${callId}`),
        payload: {
          subagentId: ctx.conversationId,
          childRunId: ctx.runId,
          path: target.path,
          kind: "connect",
          toolKey,
        },
      },
    ]);
  }

  /**
   * Every tool key the request that issued this step's calls offered (`request.tools` plus the
   * `catalog` keys), in any mode; null when its model_call is not found. Used to tell a call to an
   * old key that was offered (in flight across the rename) from one that never was.
   */
  private async requestToolKeys(ctx: ToolStepContext): Promise<Set<string> | null> {
    // attempts can reach MAX_STEP_MODEL_CALLS after reactive overflow fix-ups; scan from the top
    for (let attempt = MAX_STEP_MODEL_CALLS; attempt >= 1; attempt--) {
      const e = await this.deps.eventLog.findByIdem(
        ctx.conversationId,
        modelCallIdemKey(ctx.runId, ctx.step, attempt),
      );
      if (e?.type !== "model_call") continue;
      const { tools, catalog } = e.payload.request;
      return new Set([...(tools ?? []), ...(catalog ?? [])].map((t) => t.key));
    }
    return null;
  }

  /**
   * 发出本步调用的请求里带了完整定义的工具 key：本步最后一次尝试的 `model_call.request.tools`
   * （`assistant_message` 来自最后一次尝试）。该请求不在 ToolSearch 模式（没有 `catalog`，工具全部发送）
   * 或找不到 model_call 时返回 null（不做加载检查）。已加载集合由此从日志得出，不放进程内存。
   */
  private async sentTools(ctx: ToolStepContext): Promise<Set<string> | null> {
    // attempts can reach MAX_STEP_MODEL_CALLS after reactive overflow fix-ups; the assistant_message
    // comes from the last attempt, so scan from the top
    for (let attempt = MAX_STEP_MODEL_CALLS; attempt >= 1; attempt--) {
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
        return approvalDeniedText(a.denyReason);
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
    // 插件处理函数只拿到 SDK 的 ToolCallContext；内置工具另外拿到本步解析出的工具（ToolSearch 用）
    const base: Omit<BuiltinCallContext, "signal"> = {
      orgId: ctx.orgId,
      accountId: ctx.accountId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      callId,
      ...(resume !== undefined && { resume }),
      // who and where (memory plugin spec §6.2): `accountId` stays the trigger account
      source: ctx.source,
      ownerAccountId: ctx.ownerAccountId,
      role: ctx.role,
      ...(tool.source.kind === "builtin" && stepTools !== undefined && { tools: stepTools }),
      ...(tool.source.kind === "builtin" && { runId: ctx.runId }),
      ...(tool.source.kind === "builtin" &&
        ctx.deadline !== undefined && { runDeadline: ctx.deadline }),
      // a sub-agent works in its root conversation's sandbox (spec §10.1, at every depth)
      ...(tool.source.kind === "builtin" &&
        ctx.parent !== undefined && { sandboxConversationId: ctx.parent.rootConversationId }),
      ...(tool.source.kind === "builtin" &&
        ctx.parent !== undefined && { parentRunId: ctx.parent.runId }),
      ...(tool.source.kind === "builtin" &&
        ctx.parent?.budgetRunId !== undefined && { budgetRunId: ctx.parent.budgetRunId }),
      // the hook scope of a builtin's own model call (the WebFetch extraction)
      ...(tool.source.kind === "builtin" && {
        step: ctx.step,
        agentVersion: ctx.agentVersion,
        ...(ctx.conversationKind !== undefined && { conversationKind: ctx.conversationKind }),
        ...(ctx.parent !== undefined && {
          parent: {
            conversationId: ctx.parent.conversationId,
            runId: ctx.parent.runId,
            callId: ctx.parent.callId,
          },
        }),
      }),
    };
    // 内置工具可按输入给自己的时限（沙箱 bash 按命令超时加余量）；缺省 tools.timeoutMs
    const timeoutMs = tool.timeoutMs?.(input) ?? this.config.get().tools.timeoutMs;
    try {
      // a plugin tool runs with the extension's effective config for the org, never without it
      // (layering spec A §6): one read per call, cached by EffectiveConfigs
      let config: { config?: unknown } = {};
      if (tool.source.kind === "plugin") {
        // turned off in the org since the step resolved its tools (spec A §7)
        if (await this.deps.switches.isToolOff(ctx.orgId, tool.source.plugin, tool.source.name)) {
          return { kind: "error", message: `${toolTurnedOffReason(tool.key)}.` };
        }
        const effective = await this.deps.effective.get(ctx.orgId, tool.source.plugin);
        if (!effective.ok) {
          // unloaded or disabled since the step resolved its tools: the documented unloaded error
          if (effective.notRunning) return { kind: "error", message: PLUGIN_UNLOADED_TOOL_ERROR };
          return { kind: "error", message: unavailableText(tool.key, NEEDS_CONFIG_REASON) };
        }
        config = { config: effective.config };
      }
      const r = await this.bounded(
        ctx.signal,
        (signal) => handler(input, { ...base, ...config, signal }),
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
    const { db, registry, breaker, credentials } = this.deps;
    const { orgId } = ctx;
    const connectorId = source.connectorId;
    const app = await db
      .selectFrom("connectors")
      .select(["name", "slug", "connector", "endpoint", "auth", "status"])
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
    // an unattended run in `fail` mode declines every elicitation: no one is there to answer
    const unattended = unattendedFails(ctx.unattended);
    const elicit = new ElicitationSession({
      resume,
      onSuspend: () => suspend.abort(),
      declineAll: source.resources === true || unattended,
      ...(unattended && { declineNote: UNATTENDED_ELICITATION_NOTE }),
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
            connectorSlug: app.slug,
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
                this.deps.onToolsChanged(orgId, connectorId);
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
        return { kind: "error", message: timeoutText(tool.key, this.config.get().tools.timeoutMs) };
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
    // an extension tool's ctx.models.embed denied by a policy hook (spec B §5.4): the model sees the
    // deny text (sanitized reason), as for a denied tool call, not a generic failure
    if (e instanceof ApiError && e.code === "model.hook_denied") {
      return { kind: "error", message: e.message };
    }
    // 提供工具的插件实例在调用进行中被撤销（停用 / 升级），排空时限到后中止（C17）
    if (e instanceof ExtensionUnloadedError) {
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
    timeoutMs: number = this.config.get().tools.timeoutMs,
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
   * A plugin tool's inline card (`ToolResult.card` → `tool_result.card`, display only): `view` must
   * be an `inline` ui contribution of the same extension and `key` at most 200 characters; anything
   * else is dropped with a warning and the result is written as usual.
   */
  private cardOf(result: unknown, plugin: string, toolKey: string): ToolCard | undefined {
    const c = (result as { card?: unknown } | null)?.card;
    if (c === undefined) return undefined;
    const x = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    const views = this.deps.inlineViews(plugin);
    const keyOk =
      x.key === undefined || (typeof x.key === "string" && x.key !== "" && x.key.length <= 200);
    if (typeof x.view !== "string" || !views?.has(x.view) || !keyOk) {
      this.deps.log.warn(
        "tool returned an inline card that is not an inline view of its extension; dropped",
        {
          toolKey,
          view: typeof x.view === "string" ? x.view.slice(0, 100) : undefined,
        },
      );
      return undefined;
    }
    return { plugin, view: x.view, ...(x.key !== undefined && { key: x.key as string }) };
  }

  /**
   * A builtin's structured view (`tool_result.view`, display only): checked against
   * {@link ToolViewSchema}; an invalid one is dropped with a warning and the result is written as usual.
   */
  private viewOf(result: unknown, toolKey: string): ToolView | undefined {
    const v = (result as { view?: unknown } | null)?.view;
    if (v === undefined) return undefined;
    const parsed = ToolViewSchema.safeParse(v);
    if (!parsed.success) {
      this.deps.log.warn("builtin tool returned an invalid view; dropped", { toolKey });
      return undefined;
    }
    return parsed.data;
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
      view?: ToolView;
      card?: ToolCard;
      review?: ReviewRecord;
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
    const written = await this.writeResultIn(ctx, callId, toolKey, r, events, callAudit, audits);
    await this.deps.eventLog.notify(ctx.conversationId, Math.max(...written.map((e) => e.seq)));
  }

  /** The result's events and audit rows in one transaction (see {@link writeResult}). */
  @Transactional()
  private async writeResultIn(
    ctx: ToolStepContext,
    callId: string,
    toolKey: string,
    r: { isError: boolean },
    events: AppendEvent[],
    callAudit: CallAudit | undefined,
    audits: AuditEntry[],
  ) {
    const t = this.deps.db;
    const out = await this.deps.eventLog.appendIn(ctx.conversationId, events);
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
  }
}
