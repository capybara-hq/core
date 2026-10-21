import {
  type ContentBlock,
  type ModelUsage,
  type ParamValue,
  type StopReason,
  sanitizeParams,
} from "@capybara-hq/plugin-sdk";
import type { AgentDefinition, ModelRef } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import {
  consumeModelStream,
  type MediaSourceDeps,
  MediaUnavailableError,
} from "../runtime/model-call.js";
import type { ProviderRegistry } from "../runtime/providers.js";
import { type DriftReason, loadSnapshotMedia, reconstructRequest } from "./reconstruct.js";
import type { CaseSnapshot } from "./snapshot.js";

/**
 * 单步回放（D2 / C5）：由用例快照还原某一步的模型请求，换成候选（agent 版本 / 模型 / 参数 / 指令）重发，
 * 与快照里该步的回复（基线）比较。工具定义沿用记录（C5）；媒体按快照的组织与对话取原附件（C3）。
 * 只读快照，不写任何日志。
 */

/** 评测候选：各项都可缺省（缺省 = 沿用用例自己的）。 */
export interface EvalCandidate {
  agentVersion?: number;
  model?: ModelRef;
  modelParams?: Record<string, ParamValue>;
  instructions?: string;
}

/** 某个用例上的候选（{@link resolveCandidate}）。 */
export interface ResolvedCandidate {
  definition: AgentDefinition;
  agentVersion: number;
  model: ModelRef;
  /** 发送前再按候选模型的声明宽松处理（补默认值，见 {@link replayStep}）。 */
  params: Record<string, ParamValue>;
  /** 与用例的原版本、原定义完全相同时为 false：此时按基线还原（不改 system / 参数，漂移可比）。 */
  changed: boolean;
}

/** 候选一次请求的输出。 */
export interface ReplayOutput {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: ModelUsage;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface StepReplayDeps {
  registry: Pick<ProviderRegistry, "resolve">;
  config: () => KernelConfig;
  /** 附件来源（与运行时同一个，按组织 + 对话取）；不给时媒体一律按「不再可用」占位。 */
  media?: MediaSourceDeps;
}

const sameModel = (a: ModelRef, b: ModelRef) => a.provider === b.provider && a.model === b.model;

/** 键排序后的 JSON（比较参数是否相同）。 */
const canonical = (v: Record<string, ParamValue>) =>
  JSON.stringify(
    Object.keys(v)
      .sort()
      .map((k) => [k, v[k]]),
  );

/**
 * 候选落到某个用例上：定义取候选版本的（`versionDef`，由调用方按 `agentVersion` 查好），否则用例自己的版本；
 * 指令、模型覆盖其上。参数：给了用候选的；没给时模型未变沿用定义的 `modelParams`，换了模型为空（原参数属于原模型）。
 */
export function resolveCandidate(
  base: { definition: AgentDefinition; agentVersion: number },
  c: EvalCandidate,
  versionDef?: AgentDefinition,
): ResolvedCandidate {
  const agentVersion = c.agentVersion ?? base.agentVersion;
  const from =
    c.agentVersion !== undefined && versionDef !== undefined ? versionDef : base.definition;
  const model = c.model ?? from.model;
  const params =
    c.modelParams ?? (sameModel(model, from.model) ? { ...(from.modelParams ?? {}) } : {});
  const definition: AgentDefinition = {
    ...from,
    model,
    modelParams: params,
    ...(c.instructions !== undefined && { instructions: c.instructions }),
  };
  const changed =
    agentVersion !== base.agentVersion ||
    !sameModel(model, base.definition.model) ||
    definition.instructions !== base.definition.instructions ||
    canonical(params) !== canonical(base.definition.modelParams ?? {});
  return { definition, agentVersion, model, params, changed };
}

type SnapshotEvent = CaseSnapshot["events"][number];

/** 快照里该步的回复（`assistantSeq`）与其后同一步的第一条 usage。 */
function baselineOf(
  s: CaseSnapshot,
  call: { seq: number; step: number; assistantSeq: number },
): { content: ContentBlock[]; stopReason: StopReason; usage: ModelUsage | null } {
  const reply = s.events.find((e) => e.seq === call.assistantSeq);
  const p = (reply?.payload ?? { content: [], stopReason: "end_turn" }) as {
    content: ContentBlock[];
    stopReason: StopReason;
  };
  const usage = s.events.find(
    (e: SnapshotEvent) =>
      e.type === "usage" &&
      e.runId === s.runId &&
      e.seq > call.seq &&
      (e.payload as { step: number }).step === call.step,
  );
  let u: ModelUsage | null = null;
  if (usage) {
    const x = usage.payload as ModelUsage;
    u = {
      inputTokens: x.inputTokens,
      outputTokens: x.outputTokens,
      cacheReadTokens: x.cacheReadTokens,
      cacheWriteTokens: x.cacheWriteTokens,
    };
  }
  return { content: p.content, stopReason: p.stopReason, usage: u };
}

/**
 * 回放一步：基线取快照里该步的回复与用量；候选请求 = `reconstructRequest`（候选未变时按基线还原，
 * 否则带候选的定义、版本与参数——参数按候选模型的声明宽松处理，与运行时一致），用 `consumeModelStream` 收完。
 * 错误原样抛出（模型错误、`agent.model_unavailable`、取附件暂时失败为 `MediaUnavailableError`），由调用方分类重试。
 */
export async function replayStep(
  d: StepReplayDeps,
  s: CaseSnapshot,
  call: { seq: number; step: number; assistantSeq: number },
  candidate: ResolvedCandidate,
  signal: AbortSignal,
): Promise<{
  baseline: { content: ContentBlock[]; stopReason: StopReason; usage: ModelUsage | null };
  candidate: ReplayOutput;
  drift: DriftReason[];
}> {
  const baseline = baselineOf(s, call);
  const { provider, info } = await d.registry.resolve(candidate.model);
  let media: Awaited<ReturnType<typeof loadSnapshotMedia>> | undefined;
  if (d.media) {
    try {
      media = await loadSnapshotMedia(s, call.seq, info, d.media);
    } catch (err) {
      throw new MediaUnavailableError(err);
    }
  }
  const { request, drift } = reconstructRequest(s, call.seq, {
    model: info,
    ...(candidate.changed && {
      definition: candidate.definition,
      agentVersion: candidate.agentVersion,
      params: sanitizeParams(info.parameters, candidate.params).value,
    }),
    ...(media !== undefined && { mediaInfo: media.mediaInfo, media: media.media }),
  });
  const idleMs = info.streamIdleTimeoutMs ?? d.config().runtime.streamIdleMs;
  const started = Date.now();
  const out = await consumeModelStream(provider, request, idleMs, signal, () => {});
  return {
    baseline,
    candidate: {
      content: out.content,
      stopReason: out.stopReason,
      usage: out.usage,
      provider: candidate.model.provider,
      model: candidate.model.model,
      latencyMs: Date.now() - started,
    },
    drift,
  };
}
