import type { Logger, ToolSpec } from "@capybara-hq/plugin-sdk";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { canonicalJson } from "./registry.js";

/**
 * 编译结果缓存的上限：超过后整体丢弃（工具定义每步从库里重新读出，缓存不能无限增长）。
 * 缓存的是由定义推导出的只读数据，不是跨进程状态。
 */
const CACHE_MAX = 500;

/** 不受信任的 schema（应用工具，来自连接器）JSON 序列化后的字节上限：超过不编译、不校验。 */
export const UNTRUSTED_SCHEMA_MAX_BYTES = 64 * 1024;
/** 不受信任的 schema 的嵌套层数上限（对象 / 数组层数）：超过不编译、不校验。 */
export const UNTRUSTED_SCHEMA_MAX_DEPTH = 32;

/** 缓存键 → 编译结果（null = 不校验：无法编译或超限）。 */
const compiled = new Map<string, ValidateFunction | null>();

/**
 * 每个 schema 用自己的 Ajv 实例：不同工具的 schema 声明同一个 `$id` 时不会在共享实例里冲突
 * （共享实例会报「schema with key or id already exists」，后者就校验不了）。
 */
const newAjv = () => new Ajv2020({ strict: false, allErrors: true });

/** 值是「名字 → 子 schema」映射的关键字（键是属性名 / 定义名，不是关键字，不能按关键字剥）。 */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "dependentSchemas"]);
/** 值是数据而不是 schema 的关键字：原样保留。 */
const LITERALS = new Set(["enum", "const", "default", "examples", "required"]);

/**
 * 不受信任的 schema 去掉 Ajv 中有风险或不可控的部分：
 * - `pattern`（正则可能灾难性回溯，拖住事件循环）、`format`（未知格式 / 昂贵校验）直接去掉；
 * - `patternProperties` 去掉，并按 additionalProperties 语义放宽：原本 `additionalProperties: false` 时
 *   额外属性须符合其中某个模式的 schema，原本是 schema 时与之取 anyOf，原本缺省 / true 时不变。
 * 去掉的约束只会让校验更宽松（交给工具自己校验），不会误拦合法调用。
 */
function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "pattern" || k === "format" || k === "patternProperties") continue;
    if (LITERALS.has(k)) out[k] = v;
    else if (SCHEMA_MAPS.has(k) && v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, sanitize(sub)]));
    } else out[k] = sanitize(v);
  }
  const pp = src.patternProperties;
  if (pp !== null && typeof pp === "object" && !Array.isArray(pp)) {
    const subs = Object.values(pp).map(sanitize);
    const ap = src.additionalProperties;
    if (subs.length > 0 && ap === false) out.additionalProperties = { anyOf: subs };
    else if (subs.length > 0 && ap !== undefined && ap !== true) {
      out.additionalProperties = { anyOf: [out.additionalProperties, ...subs] };
    }
  }
  return out;
}

/** 嵌套层数（对象 / 数组），超过 `limit` 即停止计算并返回 `limit + 1`。 */
function depthOf(v: unknown, limit: number, d = 0): number {
  if (d > limit || v === null || typeof v !== "object") return d;
  let max = d + 1;
  for (const x of Array.isArray(v) ? v : Object.values(v)) {
    max = Math.max(max, depthOf(x, limit, d + 1));
    if (max > limit) return max;
  }
  return max;
}

/** 不受信任的 schema 超限的原因；不超限为 null。 */
function limitIssue(schema: Record<string, unknown>): string | null {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
  } catch {
    return "schema is not serializable";
  }
  if (bytes > UNTRUSTED_SCHEMA_MAX_BYTES) {
    return `schema larger than ${UNTRUSTED_SCHEMA_MAX_BYTES} bytes`;
  }
  if (depthOf(schema, UNTRUSTED_SCHEMA_MAX_DEPTH) > UNTRUSTED_SCHEMA_MAX_DEPTH) {
    return `schema nested deeper than ${UNTRUSTED_SCHEMA_MAX_DEPTH} levels`;
  }
  return null;
}

function remember(key: string, fn: ValidateFunction | null): ValidateFunction | null {
  if (compiled.size >= CACHE_MAX) compiled.clear();
  compiled.set(key, fn);
  return fn;
}

/**
 * 编译工具的 inputSchema；去掉 `$schema`（MCP 服务常声明 draft-07，Ajv 2020 实例不认它的元 schema）。
 * 不受信任的先查大小 / 层数（超限 → null，记一次 warn），再 {@link sanitize}。
 * 定义本身无法编译 → null（不拦截调用，交给工具自己校验），按缓存键只 warn 一次（缓存命中不再记）。
 */
function compile(
  toolKey: string,
  schema: Record<string, unknown>,
  untrusted: boolean,
  log: Pick<Logger, "warn"> | undefined,
): ValidateFunction | null {
  const { $schema: _ignored, ...rest } = schema;
  const raw = `${untrusted ? "u" : "t"}:${canonicalJson(rest)}`;
  if (compiled.has(raw)) return compiled.get(raw) ?? null;
  if (untrusted) {
    const issue = limitIssue(rest);
    if (issue !== null) {
      log?.warn("tool input schema not validated", { toolKey, reason: issue });
      return remember(raw, null);
    }
  }
  const target = untrusted ? (sanitize(rest) as Record<string, unknown>) : rest;
  let fn: ValidateFunction | null;
  try {
    fn = newAjv().compile(target);
  } catch (err) {
    log?.warn("tool input schema failed to compile; validation skipped", {
      toolKey,
      reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    fn = null;
  }
  return remember(raw, fn);
}

function describe(e: ErrorObject): string {
  const at = e.instancePath === "" ? "/" : e.instancePath;
  let msg = `${at} ${e.message ?? "is invalid"}`;
  const p = e.params as Record<string, unknown>;
  if (e.keyword === "additionalProperties" && typeof p.additionalProperty === "string") {
    msg += ` (${p.additionalProperty})`;
  } else if (e.keyword === "enum" && Array.isArray(p.allowedValues)) {
    msg += ` ${JSON.stringify(p.allowedValues)}`;
  }
  return msg;
}

export interface ValidateOptions {
  /**
   * schema 来自不受信任的来源（应用工具，由连接器提供）：编译前去掉 pattern / patternProperties / format，
   * 并限制大小与嵌套层数（超限不校验）。
   */
  untrusted?: boolean;
  /** 跳过校验（超限 / 无法编译）时记 warn（只含 toolKey 与原因）。 */
  log?: Pick<Logger, "warn">;
}

/**
 * 管线第 2 阶段：按工具的 inputSchema 校验参数（ajv，JSON Schema 2020-12，`strict: false`，`allErrors: true`）。
 * 合法 → null；不合法 → 给模型的英文说明：全部错误路径 + 完整 inputSchema（spec 6.3「给事实，不猜」）。
 * schema 自身无法编译或超限时不拦截（返回 null）。
 */
export function validateInput(
  key: string,
  spec: ToolSpec,
  input: unknown,
  opts: ValidateOptions = {},
): string | null {
  const fn = compile(key, spec.inputSchema, opts.untrusted === true, opts.log);
  if (!fn || fn(input)) return null;
  const errors = (fn.errors ?? []).map(describe);
  return `Invalid arguments for ${key}: ${errors.join("; ")}\nInput schema: ${JSON.stringify(spec.inputSchema)}`;
}
