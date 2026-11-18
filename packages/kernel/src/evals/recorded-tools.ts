import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import { type ReviewRecord, ReviewRecordSchema } from "../conversations/events.js";
import { ApiError } from "../errors.js";
import {
  type DevicePathsPayload,
  devicePathsChangeFromPayload,
  devicePathsLevel,
} from "../runtime/context/device-paths.js";
import { assistantIdemKey } from "../runtime/model-call.js";
import { MATCH_IGNORED_FIELDS } from "../tools/builtin-names.js";
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
  /** 参数的规范化 JSON（对象键递归排序，见 {@link canonicalJson}；不含 {@link matchKey} 忽略的字段）。 */
  inputKey: string;
  content: string;
  isError: boolean;
  /** 原结果里的 `ToolSearch` 已加载工具（照抄：之后请求的已加载集合由日志还原）。 */
  loadedTools?: string[];
  contentTypes?: string[];
  /** 原 `tool_call_started` 的定义指纹（没有开始事件的调用为空串）。 */
  specHash: string;
  /**
   * The payload (roots, and the sandbox level when recorded) of the latest `device_paths` event
   * the original run had logged by this call's step (environments spec §13.1, ruling R22): set on
   * every recorded call from the step where an event was logged onward. A replay that matches the
   * call writes the event when the eval conversation's latest one differs, so a candidate whose
   * first sandbox call lands in another step still gets the line, once. A managed v1 payload
   * (`permissionContextVersion: 1`) is kept whole (permission context replay spec B4); older ones
   * keep their roots-and-level shape and change semantics.
   */
  devicePaths?: DevicePathsPayload;
  /**
   * The original result's command review record, copied exactly (spec B4): a matched replay result
   * carries it verbatim, so a recorded allow, deny or ask stays that decision; absent when the
   * original had none. Never part of matching, the content or any request.
   */
  review?: ReviewRecord;
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

/** The matching key of a call: the canonical JSON of its input without the ignored fields. */
export function matchKey(toolKey: string, input: unknown): string {
  const ignored = MATCH_IGNORED_FIELDS[toolKey];
  if (
    ignored === undefined ||
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return canonicalJson(input);
  }
  const rest = { ...(input as Record<string, unknown>) };
  for (const f of ignored) delete rest[f];
  return canonicalJson(rest);
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
      review?: unknown;
    }>
  >();
  const resultSeq = new Map<string, number>();
  const started = new Map<string, string>();
  for (const e of own) {
    if (e.type === "tool_result") {
      const p = e.payload as Payload<{ callId: string; content: string; isError: boolean }>;
      results.set(p.callId, p);
      resultSeq.set(p.callId, e.seq);
    } else if (e.type === "tool_call_started") {
      const p = e.payload as { callId: string; specHash: string };
      if (!started.has(p.callId)) started.set(p.callId, p.specHash);
    }
  }
  // a device_paths event belongs to the step of the assistant message before it, and holds
  // for that step's calls and every later step's (until the next one)
  const pathsOf = new Map<number, DevicePathsPayload>();
  const assistants = own.filter((e) => e.type === "assistant_message").map((e) => e.seq);
  let current: DevicePathsPayload | undefined;
  let next = 0;
  for (const [i, a] of assistants.entries()) {
    const end = assistants[i + 1] ?? Number.POSITIVE_INFINITY;
    for (; next < own.length && (own[next] as { seq: number }).seq < end; next++) {
      const e = own[next] as { seq: number; type: string; payload: unknown };
      if (e.type === "device_paths" && e.seq > a) {
        const p = e.payload as DevicePathsPayload;
        current =
          p.permissionContextVersion === 1
            ? structuredClone(p)
            : { roots: p.roots, ...devicePathsLevel(p) };
      }
    }
    if (current !== undefined) pathsOf.set(a, current);
  }
  const out: RecordedCall[] = [];
  for (const e of own) {
    if (e.type !== "assistant_message") continue;
    const paths = pathsOf.get(e.seq);
    const content = (e.payload as { content: { type: string }[] }).content;
    for (const b of content) {
      if (b.type !== "tool_call") continue;
      const call = b as unknown as { id: string; name: string; input: unknown };
      const r = results.get(call.id);
      if (!r) continue;
      out.push({
        toolKey: call.name,
        inputKey: matchKey(call.name, call.input),
        content: r.content,
        isError: r.isError,
        ...(r.loadedTools !== undefined && { loadedTools: r.loadedTools }),
        ...(r.contentTypes !== undefined && { contentTypes: r.contentTypes }),
        specHash: started.get(call.id) ?? "",
        ...(paths !== undefined && { devicePaths: paths }),
        ...(r.review !== undefined && {
          review: recordedReview(r.review, resultSeq.get(call.id) ?? 0),
        }),
      });
    }
  }
  return out;
}

/**
 * A recorded result's review, validated by the schema the log writes it with and copied, never
 * defaulted or repaired: an invalid one makes the snapshot unreplayable (`eval.snapshot_invalid`).
 */
function recordedReview(review: unknown, seq: number): ReviewRecord {
  const parsed = ReviewRecordSchema.safeParse(review);
  if (!parsed.success) {
    throw new ApiError(
      "eval.snapshot_invalid",
      `Recorded tool_result at seq ${seq} has an invalid review record`,
    );
  }
  return structuredClone(review as ReviewRecord);
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
      const rec = this.take(call.name, matchKey(call.name, call.input));
      if (!rec) this.misses++;
      // the original run had told the model the instance's directories by this call: so does the
      // replay, when the eval conversation's latest record differs (as the sandbox tools write it)
      // (a managed v1 payload whole; older ones by their old roots-and-level comparison)
      const paths = rec?.devicePaths;
      const change =
        paths === undefined
          ? null
          : devicePathsChangeFromPayload(
              await eventLog.latestOfType(ctx.conversationId, "device_paths"),
              paths,
              ctx.runId,
            );
      await eventLog.append(ctx.conversationId, [
        ...(change ? [change] : []),
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
                // the recorded decision, verbatim: nothing is reviewed or admitted again
                ...(rec.review !== undefined && { review: structuredClone(rec.review) }),
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
