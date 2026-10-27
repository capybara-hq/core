import {
  type ModelInfo,
  type ModelRequest,
  type ParamValue,
  sanitizeParams,
} from "@capybara-hq/plugin-sdk";
import {
  type AgentDefinition,
  AgentDefinitionSchema,
  normalizeStoredDefinition,
} from "../agents/definition.js";
import type { ConversationEvent, EventPayload } from "../conversations/events.js";
import { ApiError } from "../errors.js";
import {
  type MediaBytes,
  type MediaInfo,
  type ModelCallMeta,
  mediaRefs,
  planMedia,
  type RequestTool,
} from "../runtime/context/build.js";
import { assembleModelRequest, type MediaSourceDeps } from "../runtime/model-call.js";
import { CHILD_REMOVED_TOOLS } from "../runtime/subagents/definition.js";
import { PINNED_SKILLS_LIMITS } from "../skills/catalog.js";
import { canonicalJson } from "./recorded-tools.js";
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
 * - `pinned_changed` (phase B, never for a baseline): the candidate definition (or candidate agent
 *   version) pins other skills (`skills.pinned`, deduplicated and capped) than the original agent
 *   version's definition (the recorded snapshot's `pinned` ids when that definition is missing; not
 *   with `definition_missing`); the request still renders the recorded pinned bodies (Decision 1);
 * - `subagent_changed` (phase C, never for a baseline): a sub-agent's (child) case with a candidate
 *   whose effective definition differs from the one frozen in its `subagent_started` (see
 *   {@link subagentChanged}); the request still renders the logged definition and preamble. A child
 *   case never consults `definitions` (no `definition_missing`) and has no `pinned_changed` (its
 *   pins are part of the effective definition);
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
  /** The candidate pins other skills than the recorded snapshot rendered (phase B). */
  | "pinned_changed"
  /** A child case's candidate has another effective definition than the logged one (phase C). */
  | "subagent_changed"
  | "legacy_event"
  | "params_changed"
  | "media_missing"
  | "media_changed"
  /** 整轮回放（T5）：有工具调用没有匹配到记录（模型收到 REPLAY_NO_RECORDING）。 */
  | "tool_unmatched";

const DRIFT_ORDER: readonly DriftReason[] = [
  "system_hash",
  "tools_changed",
  "tool_spec_missing",
  "definition_missing",
  "pinned_changed",
  "subagent_changed",
  "legacy_event",
  "params_changed",
  "media_missing",
  "media_changed",
  "tool_unmatched",
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
  /**
   * A child case of a plugin template (phase C): the template version a new dispatch would use (the
   * eval worker reads the current one). Another version than the logged one is a candidate change
   * (`subagent_changed`).
   */
  subagentTemplate?: { id: string; version: number };
  /**
   * A child case under another agent version (`agentVersion` differs): that version's own
   * definition, compared with the logged sub-agent for `subagent_changed` (the candidate
   * `definition` is then the logged one with overrides). Defaults to the snapshot's definition of
   * that version.
   */
  subagentVersion?: AgentDefinition;
}

export interface ReconstructResult {
  request: ModelRequest;
  meta: ModelCallMeta;
  /** 按固定顺序、去重。基线（不传 definition / params / 不同的 agentVersion）为空 = 零漂移。 */
  drift: DriftReason[];
  /** 请求里媒体的估算 token（`estimateTokens` 用；回放失败时按估算计费）。 */
  mediaTokens: number;
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
  const started = subagentStartedOf(all);
  const templateMoved =
    started !== undefined &&
    opts.subagentTemplate !== undefined &&
    !sameTemplate(started.template, opts.subagentTemplate);
  const baseline =
    opts.definition === undefined &&
    opts.params === undefined &&
    version === origVersion &&
    !templateMoved;
  const stored = s.definitions[String(version)];
  let agent: AgentDefinition | undefined;
  if (started !== undefined) {
    // a sub-agent's request renders the definition and preamble of its subagent_started (the
    // build reads them from the events); the candidate is only compared with them
    agent = normalizeStoredDefinition(s.subagent?.definition ?? started.definition);
    if (!baseline) {
      const sameVersion = version === origVersion;
      const candidate = sameVersion
        ? (opts.definition ?? agent)
        : (opts.subagentVersion ??
          opts.definition ??
          (stored ? normalizeStoredDefinition(stored) : undefined));
      const original = s.definitions[String(origVersion)];
      if (
        templateMoved ||
        // an instructions override reaches every child, whatever the version (batch 14 m5)
        (!sameVersion &&
          opts.definition !== undefined &&
          opts.definition.instructions !== agent.instructions) ||
        (candidate !== undefined &&
          subagentChanged(
            started,
            agent,
            candidate,
            sameVersion,
            original && normalizeStoredDefinition(original),
          ))
      ) {
        drift.add("subagent_changed");
      }
    }
  } else {
    agent = opts.definition ?? (stored && normalizeStoredDefinition(stored));
  }
  if (agent === undefined) {
    drift.add("definition_missing");
    agent = AgentDefinitionSchema.parse({
      name: "missing",
      instructions: "",
      model: { provider: call.payload.provider, model: call.payload.model },
    });
  }

  // pinned_changed: the candidate pins other skills than the recorded agent version did. Compared
  // with the original version's definition, not the effective snapshot (which omits stale or
  // oversized pins), both deduplicated and capped like the run; the snapshot's ids only when that
  // definition is missing. The stub of definition_missing has no pins, so it is skipped then.
  if (!baseline && started === undefined && !drift.has("definition_missing")) {
    const norm = (ids: readonly string[] | undefined) =>
      [...new Set(ids ?? [])].slice(0, PINNED_SKILLS_LIMITS.count);
    const origDef = s.definitions[String(origVersion)];
    let recorded: string[];
    if (origDef) {
      recorded = norm(normalizeStoredDefinition(origDef).skills?.pinned);
    } else {
      const snap = inputEvents(all, call)
        .filter((e) => e.type === "skills_catalog")
        .at(-1) as Extract<ConversationEvent, { type: "skills_catalog" }> | undefined;
      recorded = (snap?.payload.pinned ?? []).map((p) => p.id);
    }
    const wanted = norm(agent.skills?.pinned);
    if (recorded.length !== wanted.length || recorded.some((id, i) => wanted[i] !== id)) {
      drift.add("pinned_changed");
    }
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

  const { request, meta, mediaTokens } = assembleModelRequest({
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

  return { request, meta, drift: DRIFT_ORDER.filter((r) => drift.has(r)), mediaTokens };
}

type SubagentStarted = EventPayload<"subagent_started">;

/** The `subagent_started` of a sub-agent's (child) log, or undefined for any other conversation. */
export function subagentStartedOf(
  events: readonly ConversationEvent[],
): SubagentStarted | undefined {
  const e = events.find((x) => x.type === "subagent_started");
  return e?.type === "subagent_started" ? e.payload : undefined;
}

const sameTemplate = (logged: SubagentStarted["template"], t: { id: string; version: number }) =>
  logged.source !== "plugin" || (logged.id === t.id && logged.version === t.version);

const pinsOf = (d: AgentDefinition): string[] =>
  [...new Set(d.skills?.pinned ?? [])].slice(0, PINNED_SKILLS_LIMITS.count);

/** Tool refs as a sub-agent gets them without template narrowing (general and org agents). */
const childToolsOf = (d: AgentDefinition): string =>
  canonicalJson(
    d.tools.filter(
      (t) => t.kind !== "builtin" || !(CHILD_REMOVED_TOOLS as readonly string[]).includes(t.name),
    ),
  );

/** The parent's selection a template child depends on: its tools, org skills and roster entry. */
const parentSide = (d: AgentDefinition, started: SubagentStarted): string =>
  canonicalJson({
    tools: d.tools,
    orgSkills: d.skills?.orgSkills ?? [],
    listed:
      started.template.source === "general"
        ? d.subagents?.general !== false
        : (d.subagents?.templates ?? []).includes(started.template.id ?? ""),
  });

/**
 * Does a candidate change what a sub-agent (child) case would run (`subagent_changed`, spec
 * §15.1)? Pure, from the snapshot alone, comparing the model-visible parts of the effective
 * definition (instructions, pinned skills, tools) with the logged one (`logged`, from its
 * `subagent_started`):
 * - the same agent version (`sameVersion`): the candidate is the logged definition with
 *   overrides (instructions, model, params), compared field by field;
 * - another version of the case's agent: for an org agent child (`source: "agent"`) that agent's
 *   version, as dispatch would use it (its own tools minus the child-removed ones); otherwise the
 *   parent's version: `general` takes its instructions and tools and pins nothing, `inline` its
 *   template of the same name (gone = changed), and a `plugin` template does not depend on the
 *   parent version (its own version is {@link ReconstructOptions.subagentTemplate}). Template
 *   narrowing that needs the database (inline and plugin tool allowlists, skill names) is not
 *   recomputed: those compare instructions only.
 * Models and params are not part of it: they are candidate axes of their own.
 */
export function subagentChanged(
  started: SubagentStarted,
  logged: AgentDefinition,
  candidate: AgentDefinition,
  sameVersion: boolean,
  /** The parent's definition at the case's version (the snapshot's), for template children. */
  original?: AgentDefinition,
): boolean {
  const differs = (instructions: string, pinned: string[] | null, tools: string | null): boolean =>
    instructions !== logged.instructions ||
    (pinned !== null && canonicalJson(pinned) !== canonicalJson(pinsOf(logged))) ||
    (tools !== null && tools !== childToolsOf(logged));
  if (sameVersion) {
    return differs(candidate.instructions, pinsOf(candidate), canonicalJson(candidate.tools));
  }
  switch (started.template.source) {
    case "agent":
      return differs(candidate.instructions, pinsOf(candidate), childToolsOf(candidate));
    case "general":
      return (
        differs(candidate.instructions, [], childToolsOf(candidate)) ||
        (original !== undefined && parentSide(original, started) !== parentSide(candidate, started))
      );
    case "inline": {
      const t = candidate.subagents?.inline?.find((x) => x.name === started.agentType);
      if (!t) return true;
      // conservative: any difference of the template between the two versions counts
      const o = original?.subagents?.inline?.find((x) => x.name === started.agentType);
      if (o !== undefined) return canonicalJson(o) !== canonicalJson(t);
      return differs(t.instructions ?? candidate.instructions, null, null);
    }
    case "plugin":
      return (
        original !== undefined && parentSide(original, started) !== parentSide(candidate, started)
      );
  }
}

/**
 * `subagent_changed` for a whole child case (full-run replay): the candidate (`definition` at
 * `agentVersion`, plus a plugin template's current version) against the case's logged sub-agent.
 * False for any other case and for an unchanged candidate.
 */
export function subagentCaseChanged(
  s: CaseSnapshot,
  c: {
    changed: boolean;
    definition: AgentDefinition;
    agentVersion: number;
    subagentTemplate?: { id: string; version: number };
    subagentVersion?: AgentDefinition;
  },
): boolean {
  const started = subagentStartedOf(toEvents(s));
  if (started === undefined || !c.changed) return false;
  if (c.subagentTemplate !== undefined && !sameTemplate(started.template, c.subagentTemplate)) {
    return true;
  }
  const logged = normalizeStoredDefinition(s.subagent?.definition ?? started.definition);
  const sameVersion = c.agentVersion === s.agentVersion;
  const candidate = sameVersion ? c.definition : (c.subagentVersion ?? c.definition);
  // an instructions override reaches every child, whatever the version (batch 14 m5): the
  // rendered definition is the logged one with the candidate's instructions
  if (!sameVersion && c.definition.instructions !== logged.instructions) return true;
  const original = s.definitions[String(s.agentVersion)];
  return subagentChanged(
    started,
    logged,
    candidate,
    sameVersion,
    original && normalizeStoredDefinition(original),
  );
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

/**
 * 按快照自己的 `orgId` / `conversationId` 取还原该请求要用的附件（C3：媒体不进快照，回放时取原附件）：
 * 先查行信息，按 `planMedia`（与运行时同一规则；预算缺省用记录的 `mediaBudgetBytes`）只取要发字节的，
 * `text/*` 只取开头。结果直接作 {@link ReconstructOptions} 的 `mediaInfo` / `media`。
 * 原对话或附件已删除 → 行不在结果里，还原时按「不再可用」占位（drift 记 `media_missing`）；
 * 暂时故障（存储不可用）由来源抛出，调用方按可重试处理。
 */
export async function loadSnapshotMedia(
  s: CaseSnapshot,
  modelCallSeq: number,
  model: ModelInfo,
  source: MediaSourceDeps,
  mediaBudgetBytes?: number,
): Promise<{ mediaInfo: Map<string, MediaInfo>; media: Map<string, MediaBytes | null> }> {
  const all = toEvents(s);
  const call = findCall(all, modelCallSeq);
  const events = inputEvents(all, call);
  const refs = mediaRefs(events, model);
  const media = new Map<string, MediaBytes | null>();
  if (refs.length === 0) return { mediaInfo: new Map(), media };
  const mediaInfo = await source.info(s.orgId, s.conversationId, refs);
  const budget = mediaBudgetBytes ?? call.payload.request.mediaBudgetBytes;
  const plan = planMedia(events, model, mediaInfo, budget);
  if (plan.fetch.length > 0) {
    const caps = new Map(
      plan.fetch.flatMap((id) => (plan.caps.has(id) ? [[id, plan.caps.get(id) as number]] : [])),
    );
    const got = await source.fetch(
      s.orgId,
      s.conversationId,
      plan.fetch,
      caps.size > 0 ? caps : undefined,
    );
    for (const id of plan.fetch) media.set(id, got.get(id) ?? null);
  }
  return { mediaInfo, media };
}
