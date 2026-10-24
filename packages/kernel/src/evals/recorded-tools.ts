import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import { assistantIdemKey } from "../runtime/model-call.js";
import { RUN_STOPPED_TEXT, type ToolPipeline, type ToolStepContext } from "../tools/pipeline.js";
import type { CaseSnapshot } from "./snapshot.js";

/**
 * 整轮回放的工具管线（C6 / Review Focus 3）：只回放原运行记录的工具结果，**从不执行任何工具**——
 * 不经过策略、审批、沙箱、连接器，也不调用任何处理函数。每个调用按 (toolKey, 规范化参数) 精确匹配第一条未用的记录；
 * 匹配不上时写英文错误结果 {@link REPLAY_NO_RECORDING}（`isError: true`），什么都不执行。
 */

/** 没有匹配记录时模型看到的工具结果（模型可见，英文）。 */
export const REPLAY_NO_RECORDING =
  "[replay] No recorded result matches this tool call (same tool and arguments); the tool was not executed during replay.";

/** 原运行里一次有结果的工具调用。 */
export interface RecordedCall {
  toolKey: string;
  /** 参数的规范化 JSON（对象键递归排序，见 {@link canonicalJson}）。 */
  inputKey: string;
  content: string;
  isError: boolean;
  /** 原结果里的 `tool_search` 已加载工具（照抄：之后请求的已加载集合由日志还原）。 */
  loadedTools?: string[];
  contentTypes?: string[];
  /** 原 `tool_call_started` 的定义指纹（没有开始事件的调用为空串）。 */
  specHash: string;
}

/** 规范化 JSON：对象键递归按码点排序，数组保持顺序；`undefined` 按 JSON 规则省略。 */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x !== null && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = norm(o[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v) ?? null);
}

type Payload<T> = T & Record<string, unknown>;

/**
 * 快照运行里有结果的工具调用，按调用出现的顺序（assistant 消息的 seq、块的顺序）。
 * 没有 `tool_result` 的调用（运行中止等）不算记录。
 */
export function recordedCalls(s: CaseSnapshot): RecordedCall[] {
  const own = s.events.filter((e) => e.runId === s.runId);
  const results = new Map<
    string,
    Payload<{
      content: string;
      isError: boolean;
      loadedTools?: string[];
      contentTypes?: string[];
    }>
  >();
  const started = new Map<string, string>();
  for (const e of own) {
    if (e.type === "tool_result") {
      const p = e.payload as Payload<{ callId: string; content: string; isError: boolean }>;
      results.set(p.callId, p);
    } else if (e.type === "tool_call_started") {
      const p = e.payload as { callId: string; specHash: string };
      if (!started.has(p.callId)) started.set(p.callId, p.specHash);
    }
  }
  const out: RecordedCall[] = [];
  for (const e of own) {
    if (e.type !== "assistant_message") continue;
    const content = (e.payload as { content: { type: string }[] }).content;
    for (const b of content) {
      if (b.type !== "tool_call") continue;
      const call = b as unknown as { id: string; name: string; input: unknown };
      const r = results.get(call.id);
      if (!r) continue;
      out.push({
        toolKey: call.name,
        inputKey: canonicalJson(call.input),
        content: r.content,
        isError: r.isError,
        ...(r.loadedTools !== undefined && { loadedTools: r.loadedTools }),
        ...(r.contentTypes !== undefined && { contentTypes: r.contentTypes }),
        specHash: started.get(call.id) ?? "",
      });
    }
  }
  return out;
}

/** 与真实管线相同的幂等键（同一调用重入时不重复写）。 */
const idem = {
  started: (runId: string, callId: string) => `tool_started:${runId}:${callId}`,
  result: (runId: string, callId: string) => `tool_result:${runId}:${callId}`,
};

export interface RecordedToolPipelineDeps {
  eventLog: EventLog;
  recordings: RecordedCall[];
  /**
   * 每步处理工具调用之前调用（运行仍在执行、仍持有认领等）：返回 `stop` 时本步尚无结果的调用写
   * {@link RUN_STOPPED_TEXT}（保持「调用都有结果」），调用方负责让 loop 停下（中止信号）。
   */
  beforeStep(step: number): Promise<"continue" | "stop">;
}

export class RecordedToolPipeline implements Pick<ToolPipeline, "runStep"> {
  private readonly used = new Set<number>();
  private misses = 0;

  constructor(private readonly d: RecordedToolPipelineDeps) {}

  /** 至今没有匹配到记录的调用数。 */
  unmatched(): number {
    return this.misses;
  }

  async runStep(ctx: ToolStepContext): Promise<{ kind: "done" }> {
    const { eventLog } = this.d;
    const msg = await eventLog.findByIdem(
      ctx.conversationId,
      assistantIdemKey(ctx.runId, ctx.step),
    );
    if (msg?.type !== "assistant_message") return { kind: "done" };
    const calls = msg.payload.content.flatMap((b) =>
      b.type === "tool_call" ? [{ id: b.id, name: b.name, input: b.input }] : [],
    );
    if (calls.length === 0) return { kind: "done" };
    const stop = (await this.d.beforeStep(ctx.step)) === "stop";
    for (const call of calls) {
      if (await eventLog.findByIdem(ctx.conversationId, idem.result(ctx.runId, call.id))) continue;
      const result = (p: Record<string, unknown>): AppendEvent => ({
        type: "tool_result",
        runId: ctx.runId,
        idemKey: idem.result(ctx.runId, call.id),
        payload: { step: ctx.step, callId: call.id, toolKey: call.name, ...p },
      });
      if (stop) {
        await eventLog.append(ctx.conversationId, [
          result({ content: RUN_STOPPED_TEXT, isError: true }),
        ]);
        continue;
      }
      const rec = this.take(call.name, canonicalJson(call.input));
      if (!rec) this.misses++;
      await eventLog.append(ctx.conversationId, [
        {
          type: "tool_call_started",
          runId: ctx.runId,
          idemKey: idem.started(ctx.runId, call.id),
          payload: {
            step: ctx.step,
            callId: call.id,
            toolKey: call.name,
            specHash: rec?.specHash ?? "",
          },
        },
        result(
          rec
            ? {
                content: rec.content,
                isError: rec.isError,
                ...(rec.loadedTools !== undefined && { loadedTools: rec.loadedTools }),
                ...(rec.contentTypes !== undefined && { contentTypes: rec.contentTypes }),
              }
            : { content: REPLAY_NO_RECORDING, isError: true },
        ),
      ]);
    }
    return { kind: "done" };
  }

  /** 第一条未用、且工具与参数都相同的记录。 */
  private take(toolKey: string, inputKey: string): RecordedCall | undefined {
    const i = this.d.recordings.findIndex(
      (r, j) => !this.used.has(j) && r.toolKey === toolKey && r.inputKey === inputKey,
    );
    if (i < 0) return undefined;
    this.used.add(i);
    return this.d.recordings[i];
  }
}
