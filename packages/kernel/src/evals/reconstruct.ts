import {
  type ModelInfo,
  type ModelRequest,
  type ParamValue,
  sanitizeParams,
} from "@capybara-hq/plugin-sdk";
import { type AgentDefinition, AgentDefinitionSchema } from "../agents/definition.js";
import type { ConversationEvent } from "../conversations/events.js";
import { ApiError } from "../errors.js";
import {
  type MediaBytes,
  type MediaInfo,
  type ModelCallMeta,
  mediaRefs,
  type RequestTool,
} from "../runtime/context/build.js";
import { assembleModelRequest } from "../runtime/model-call.js";
import { type CaseSnapshot, toEvents } from "./snapshot.js";

/**
 * 由用例快照还原某次模型请求（单步回放的基础，D2 / C5）。与运行时共用 {@link assembleModelRequest}，
 * 输入全部取自日志：参与构建的事件（seq ≤ 记录的 `toSeq`）、记录的 `absorbedUpToSeq` / `params` /
 * `toolChoice` / `maxOutputTokens` / `mediaBudgetBytes`，工具按记录的 specHash 从快照取（C5：工具集合不随候选变化）。
 *
 * 漂移原因：
 * - `system_hash` / `tools_changed`（只在基线判定）：system 指纹、工具序列（tools 与 catalog）与记录不同；
 * - `tool_spec_missing`：快照里缺某个工具定义（从请求里去掉）；
 * - `definition_missing`：快照里缺该 agent 版本的定义（用空指令）；
 * - `legacy_event`：记录缺 `tools` / `params` / `absorbedUpToSeq` / `maxOutputTokens`，或还原出媒体而记录里没有
 *   `media` / `mediaBudgetBytes`（较早的事件）；
 * - `params_changed`：没给候选参数时，记录的参数按所用模型的声明清洗后有键被丢弃或值变了（换了模型或模型声明变了）；
 * - `media_missing`：某附件记录里不是「不再可用」，还原时却取不到；
 * - `media_changed`（只在基线判定）：其余任何媒体结果与记录不同（按附件 id 比 outcome 与 etag：预算省略、
 *   图片数 / 页数上限、对象被替换后 etag 变了等）。
 */

/** 还原结果与原请求不一致的原因。 */
export type DriftReason =
  | "system_hash"
  | "tools_changed"
  | "tool_spec_missing"
  | "definition_missing"
  | "legacy_event"
  | "params_changed"
  | "media_missing"
  | "media_changed";

const DRIFT_ORDER: readonly DriftReason[] = [
  "system_hash",
  "tools_changed",
  "tool_spec_missing",
  "definition_missing",
  "legacy_event",
  "params_changed",
  "media_missing",
  "media_changed",
];

export interface ReconstructOptions {
  /** 发送用的模型（基线为原模型的当前信息）。 */
  model: ModelInfo;
  /** 候选定义（覆盖 system 指令）；缺省用快照里该运行版本的定义。 */
  definition?: AgentDefinition;
  /** 候选 agent 版本（缺省为该运行的版本）；没给 `definition` 时按它从快照取定义。 */
  agentVersion?: number;
  /** 候选参数（原样使用）；缺省用记录的 `params`，按 `model` 的声明清洗（见 `params_changed`）。 */
  params?: Record<string, ParamValue>;
  /** 附件行信息与字节（调用方按 {@link snapshotMediaRefs} 取）；缺省表示都取不到。 */
  mediaInfo?: ReadonlyMap<string, MediaInfo>;
  media?: ReadonlyMap<string, MediaBytes | null>;
  /** 单次请求的媒体字节预算；缺省用记录的 `mediaBudgetBytes`（较早的事件没有时不限）。 */
  mediaBudgetBytes?: number;
}

export interface ReconstructResult {
  request: ModelRequest;
  meta: ModelCallMeta;
  /** 按固定顺序、去重。基线（不传 definition / params / 不同的 agentVersion）为空 = 零漂移。 */
  drift: DriftReason[];
}

type ModelCallEvent = Extract<ConversationEvent, { type: "model_call" }>;
type Recorded = ModelCallEvent["payload"]["request"];

function findCall(events: readonly ConversationEvent[], seq: number): ModelCallEvent {
  const call = events.find((e): e is ModelCallEvent => e.seq === seq && e.type === "model_call");
  if (!call) {
    throw new ApiError("eval.call_not_found", `No model_call event at seq ${seq} in the snapshot`);
  }
  return call;
}

/** 参与构建该请求的事件：运行时构建时手里的就是 seq ≤ `toSeq` 的事件（`model_call` 本身在其后写入）。 */
function inputEvents(events: readonly ConversationEvent[], call: ModelCallEvent) {
  const upTo = Math.min(call.payload.request.toSeq, call.seq - 1);
  return events.filter((e) => e.seq <= upTo);
}

/** 该请求的 agent 版本：所属运行的 `run_started`；没有（不应出现）时用快照运行的版本。 */
function recordedVersion(
  s: CaseSnapshot,
  events: readonly ConversationEvent[],
  call: ModelCallEvent,
) {
  const started = events.find(
    (e): e is Extract<ConversationEvent, { type: "run_started" }> =>
      e.type === "run_started" && e.runId === call.runId,
  );
  return started?.payload.agentVersion ?? s.agentVersion;
}

const sameParams = (a: Record<string, ParamValue>, b: Record<string, unknown>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.is(a[k], b[k]));
};

const sameList = (
  a: readonly { key: string; specHash: string }[] | undefined,
  b: readonly { key: string; specHash: string }[] | undefined,
) =>
  (a ?? []).length === (b ?? []).length &&
  (a ?? []).every((x, i) => x.key === b?.[i]?.key && x.specHash === b?.[i]?.specHash);

export function reconstructRequest(
  s: CaseSnapshot,
  modelCallSeq: number,
  opts: ReconstructOptions,
): ReconstructResult {
  const all = toEvents(s);
  const call = findCall(all, modelCallSeq);
  const rec: Recorded = call.payload.request;
  const drift = new Set<DriftReason>();

  if (
    rec.tools === undefined ||
    rec.params === undefined ||
    rec.absorbedUpToSeq === undefined ||
    rec.maxOutputTokens === undefined
  ) {
    drift.add("legacy_event");
  }

  const origVersion = recordedVersion(s, all, call);
  const version = opts.agentVersion ?? origVersion;
  const baseline =
    opts.definition === undefined && opts.params === undefined && version === origVersion;
  let agent = opts.definition ?? s.definitions[String(version)];
  if (agent === undefined) {
    drift.add("definition_missing");
    agent = AgentDefinitionSchema.parse({
      name: "missing",
      instructions: "",
      model: { provider: call.payload.provider, model: call.payload.model },
    });
  }

  // 工具：按记录的顺序从快照取定义；取不到的从请求里去掉（基线与候选一样）
  const tools: RequestTool[] = [];
  const seen = new Set<string>();
  const kept = (list: Recorded["tools"]) =>
    (list ?? []).filter((t) => s.toolSpecs[t.specHash] !== undefined);
  for (const t of [...(rec.tools ?? []), ...(rec.catalog ?? [])]) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    const spec = s.toolSpecs[t.specHash];
    if (spec === undefined) {
      drift.add("tool_spec_missing");
      continue;
    }
    tools.push({ key: t.key, spec, specHash: t.specHash });
  }

  let params = opts.params;
  if (params === undefined) {
    const recorded = rec.params ?? {};
    const clean = sanitizeParams(opts.model.parameters, recorded);
    params = clean.value;
    if (clean.dropped.length > 0 || !sameParams(clean.value, recorded)) drift.add("params_changed");
  }
  const budget = opts.mediaBudgetBytes ?? rec.mediaBudgetBytes;

  const { request, meta } = assembleModelRequest({
    events: inputEvents(all, call),
    agent,
    agentVersion: version,
    model: opts.model,
    step: call.payload.step,
    ...(rec.absorbedUpToSeq !== undefined && { absorbedUpToSeq: rec.absorbedUpToSeq }),
    params,
    tools,
    toolSearch: rec.catalog !== undefined,
    ...(rec.toolChoice !== undefined && { toolChoice: rec.toolChoice }),
    ...(opts.mediaInfo !== undefined && { mediaInfo: opts.mediaInfo }),
    ...(opts.media !== undefined && { media: opts.media }),
    ...(budget !== undefined && { mediaBudgetBytes: budget }),
    defaultMaxOutputTokens: rec.maxOutputTokens ?? opts.model.maxOutputTokens,
  });

  if (baseline) {
    if (meta.systemHash !== rec.systemHash) drift.add("system_hash");
    // 与记录比较时排除快照里缺定义的工具（已记 tool_spec_missing）
    if (
      rec.tools !== undefined &&
      (!sameList(meta.tools, kept(rec.tools)) ||
        !sameList(meta.catalog, rec.catalog === undefined ? undefined : kept(rec.catalog)))
    ) {
      drift.add("tools_changed");
    }
  }

  // 媒体：按附件 id 与记录比较
  if (meta.media !== undefined && (rec.media === undefined || rec.mediaBudgetBytes === undefined)) {
    drift.add("legacy_event");
  }
  const recordedMedia = new Map((rec.media ?? []).map((m) => [m.attachmentId, m]));
  for (const m of meta.media ?? []) {
    const was = recordedMedia.get(m.attachmentId);
    if (m.outcome === "unavailable" && was?.outcome !== "unavailable") {
      drift.add("media_missing");
    } else if (
      baseline &&
      rec.media !== undefined &&
      (was === undefined || was.outcome !== m.outcome || was.etag !== m.etag)
    ) {
      drift.add("media_changed");
    }
  }
  if (baseline && rec.media !== undefined) {
    const now = new Set((meta.media ?? []).map((m) => m.attachmentId));
    if (rec.media.some((m) => !now.has(m.attachmentId))) drift.add("media_changed");
  }

  return { request, meta, drift: DRIFT_ORDER.filter((r) => drift.has(r)) };
}

/** 还原该请求要查的附件 id（该模型用得到的引用，去重、按出现顺序；见 `mediaRefs`）。 */
export function snapshotMediaRefs(
  s: CaseSnapshot,
  modelCallSeq: number,
  model: ModelInfo,
): string[] {
  const all = toEvents(s);
  return mediaRefs(inputEvents(all, findCall(all, modelCallSeq)), model);
}
