import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { type AgentDefinition, normalizeStoredDefinition } from "../agents/definition.js";
import type { ConversationEvent, ConversationEventType } from "../conversations/events.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";

/**
 * 评测用例快照（C3）：复制截至某次运行终态的会话事件、这些事件引用的 agent 版本定义、请求用到的工具定义
 * （按 specHash）。回放只读快照，不改原对话的日志；媒体不复制字节，回放时按引用取原附件。
 */

/** 快照里的一条事件（`createdAt` 为 ISO 字符串，便于存成 JSON）。 */
export interface SnapshotEvent {
  seq: number;
  type: ConversationEventType;
  payload: unknown;
  runId: string | null;
  createdAt: string;
}

export interface CaseSnapshot {
  version: 1;
  orgId: string;
  conversationId: string;
  runId: string;
  agentId: string;
  agentVersion: number;
  /** seq ≤ 该运行终态事件的 seq，按 seq 升序。 */
  events: SnapshotEvent[];
  /** 事件里各次运行（`run_started`）与本运行引用的 agent 版本 → 定义。 */
  definitions: Record<string, AgentDefinition>;
  /** 各次 `model_call` 的 `tools` / `catalog` 引用的工具定义：specHash → 定义（`tool_specs` 里没有的不在其中）。 */
  toolSpecs: Record<string, ToolSpec>;
}

const TERMINAL = new Set<ConversationEventType>(["run_finished", "run_failed", "run_aborted"]);

/** 读事件的分页大小。 */
const PAGE = 1000;

type ModelCallEvent = Extract<ConversationEvent, { type: "model_call" }>;

/**
 * 给某次运行建用例快照。会话不在该组织、或运行不属于该会话 → `conversation.not_found`；
 * 运行还没有终态事件 → `eval.run_not_finished`（409）；序列化后超过 `maxBytes` 字节 → `eval.case_too_large`（413）。
 * `maxBytes` 由调用方传入（`evals.maxCaseBytes`）。
 */
export async function takeSnapshot(
  db: KernelDb,
  orgId: string,
  conversationId: string,
  runId: string,
  maxBytes: number,
): Promise<CaseSnapshot> {
  const conv = await db
    .selectFrom("conversations")
    .select("agent_id")
    .where("id", "=", conversationId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  const run = conv
    ? await db
        .selectFrom("runs")
        .select("agent_version")
        .where("id", "=", runId)
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst()
    : undefined;
  if (!conv || !run) {
    throw new ApiError("conversation.not_found", "Conversation or run not found");
  }

  const end = await db
    .selectFrom("conversation_events")
    .select("seq")
    .where("conversation_id", "=", conversationId)
    .where("run_id", "=", runId)
    .where("type", "in", [...TERMINAL])
    .orderBy("seq")
    .executeTakeFirst();
  if (!end) throw new ApiError("eval.run_not_finished", "The run has not finished yet");
  const endSeq = Number(end.seq);

  const tooLarge = () =>
    new ApiError(
      "eval.case_too_large",
      `The run's snapshot is larger than the ${maxBytes}-byte limit`,
    );
  const events: SnapshotEvent[] = [];
  /** 已读事件序列化后的字节数（快照总大小的下界）：一超过上限就停，不把超大的对话整个读进内存。 */
  let bytes = 0;
  let after = 0;
  for (;;) {
    const rows = await db
      .selectFrom("conversation_events")
      .select(["seq", "type", "run_id", "payload", "created_at"])
      .where("conversation_id", "=", conversationId)
      .where("seq", ">", String(after))
      .where("seq", "<=", String(endSeq))
      .orderBy("seq")
      .limit(PAGE)
      .execute();
    for (const r of rows) {
      const e: SnapshotEvent = {
        seq: Number(r.seq),
        type: r.type as ConversationEventType,
        payload: r.payload,
        runId: r.run_id,
        createdAt: new Date(r.created_at).toISOString(),
      };
      bytes += Buffer.byteLength(JSON.stringify(e));
      if (bytes > maxBytes) throw tooLarge();
      events.push(e);
    }
    const last = rows.at(-1);
    if (rows.length < PAGE || !last) break;
    after = Number(last.seq);
  }

  const versions = new Set<number>([run.agent_version]);
  const hashes = new Set<string>();
  for (const e of events) {
    if (e.type === "run_started") {
      versions.add((e.payload as { agentVersion: number }).agentVersion);
    } else if (e.type === "model_call") {
      const req = (e.payload as ModelCallEvent["payload"]).request;
      for (const t of [...(req.tools ?? []), ...(req.catalog ?? [])]) hashes.add(t.specHash);
    }
  }

  const definitions: Record<string, AgentDefinition> = {};
  const defRows = await db
    .selectFrom("agent_versions")
    .select(["version", "definition"])
    .where("agent_id", "=", conv.agent_id)
    .where("version", "in", [...versions])
    .orderBy("version")
    .execute();
  for (const r of defRows) {
    definitions[String(r.version)] = normalizeStoredDefinition(r.definition);
  }

  const toolSpecs: Record<string, ToolSpec> = {};
  if (hashes.size > 0) {
    const specRows = await db
      .selectFrom("tool_specs")
      .select(["spec_hash", "spec"])
      .where("spec_hash", "in", [...hashes].sort())
      .orderBy("spec_hash")
      .execute();
    for (const r of specRows) toolSpecs[r.spec_hash] = r.spec as ToolSpec;
  }

  const snapshot: CaseSnapshot = {
    version: 1,
    orgId,
    conversationId,
    runId,
    agentId: conv.agent_id,
    agentVersion: run.agent_version,
    events,
    definitions,
    toolSpecs,
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes) throw tooLarge();
  return snapshot;
}

/**
 * 读出库里存的快照（`eval_cases.snapshot`）：把各版本定义里改名前（D17）的 `{ kind: "app" }` 工具引用规范化为
 * connector 形（C27）。整轮回放会把定义交给实时注册表，不规范化的话连接器工具全部失效。其余字段原样。
 */
export function readSnapshot(raw: unknown): CaseSnapshot {
  const s = raw as CaseSnapshot;
  const definitions: Record<string, AgentDefinition> = {};
  for (const [v, d] of Object.entries(s.definitions ?? {})) {
    definitions[v] = normalizeStoredDefinition(d);
  }
  return { ...s, definitions };
}

/** 快照事件还原为日志事件（`createdAt` 转回 Date）。 */
export function toEvents(s: CaseSnapshot): ConversationEvent[] {
  return s.events.map(
    (e) =>
      ({
        conversationId: s.conversationId,
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        runId: e.runId,
        createdAt: new Date(e.createdAt),
      }) as ConversationEvent,
  );
}

/**
 * 快照运行里可单步回放的模型调用：每步的最后一次尝试（含收尾调用），且该步有回复（`assistant_message`）；
 * 没有回复的步骤（尝试都失败）不在其中。按 seq 升序。
 */
export function replayableCalls(
  s: CaseSnapshot,
): { seq: number; step: number; assistantSeq: number }[] {
  const lastCall = new Map<number, number>();
  const replies = new Map<number, number[]>();
  for (const e of s.events) {
    if (e.runId !== s.runId) continue;
    if (e.type === "model_call") {
      lastCall.set((e.payload as { step: number }).step, e.seq);
    } else if (e.type === "assistant_message") {
      const step = (e.payload as { step: number }).step;
      replies.set(step, [...(replies.get(step) ?? []), e.seq]);
    }
  }
  const out: { seq: number; step: number; assistantSeq: number }[] = [];
  for (const [step, seq] of lastCall) {
    const reply = replies.get(step)?.find((r) => r > seq);
    if (reply !== undefined) out.push({ seq, step, assistantSeq: reply });
  }
  return out.sort((a, b) => a.seq - b.seq);
}
