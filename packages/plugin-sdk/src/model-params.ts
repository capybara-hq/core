/**
 * `model-provider@2` 的参数声明与校验（纯函数；issue / 错误信息用英文，供日志与 API 返回）。
 * 每个模型在 `ModelInfo.parameters` 中声明自己支持的参数，取值约束是受限的 JSON Schema 子集。
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 标准旋钮：平台统一语义，界面专门渲染，换模型或兜底时语义可迁移；插件负责映射到原生参数。
 * - `effort`：思考深度，`{ type: "string", enum }`，取值是 `low|medium|high|xhigh|max` 的子集；
 * - `thinking`：思考模式，`{ type: "string", enum }`，取值是 `off|on|summarized` 的子集；
 * - `temperature`：`{ type: "number" }`（可带范围）；
 * - `maxOutputTokens`：最大输出 token，`{ type: "integer" }`（可带范围）。
 */
export type StandardKnob = "effort" | "thinking" | "temperature" | "maxOutputTokens";

export const STANDARD_KNOBS: readonly StandardKnob[] = [
  "effort",
  "thinking",
  "temperature",
  "maxOutputTokens",
];
/** `effort` 旋钮允许的取值全集。 */
export const EFFORT_VALUES: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
/** `thinking` 旋钮允许的取值全集。 */
export const THINKING_VALUES: readonly string[] = ["off", "on", "summarized"];

/** 参数取值约束：受限的 JSON Schema 子集（可序列化后交给界面；内核自行校验，不依赖 ajv）。 */
export type ParamSchema =
  | { type: "string"; enum: string[] }
  | { type: "string"; maxLength?: number }
  | { type: "boolean" }
  | { type: "number" | "integer"; minimum?: number; maximum?: number };

export type ParamValue = string | number | boolean;

/** 模型声明的一个参数。 */
export interface ModelParameter {
  /** 标准旋钮名（见 {@link StandardKnob}），或厂商专有参数 `"<插件名>.<名称>"`。 */
  key: string;
  /** key 为标准旋钮时必填且必须等于 key；厂商专有参数不得填写。 */
  standard?: StandardKnob;
  schema: ParamSchema;
  /** 未设置时使用的值；必须满足 schema。 */
  default?: ParamValue;
  label: { zh: string; en: string };
  description?: { zh: string; en: string };
}

export interface ParamIssue {
  key: string;
  message: string;
}

const isStandardKnob = (k: string): k is StandardKnob =>
  (STANDARD_KNOBS as readonly string[]).includes(k);

const VENDOR_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** 值不满足 schema 时返回英文原因，满足时返回 undefined。 */
function checkValue(schema: ParamSchema, v: unknown): string | undefined {
  switch (schema.type) {
    case "boolean":
      return typeof v === "boolean" ? undefined : "must be a boolean";
    case "string":
      if (typeof v !== "string") return "must be a string";
      if ("enum" in schema) {
        return schema.enum.includes(v)
          ? undefined
          : `must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(", ")}`;
      }
      if (schema.maxLength !== undefined && v.length > schema.maxLength)
        return `must be at most ${schema.maxLength} characters`;
      return undefined;
    case "number":
    case "integer":
      if (typeof v !== "number" || !Number.isFinite(v)) return "must be a finite number";
      if (schema.type === "integer" && !Number.isInteger(v)) return "must be an integer";
      if (schema.minimum !== undefined && v < schema.minimum) return `must be >= ${schema.minimum}`;
      if (schema.maximum !== undefined && v > schema.maximum) return `must be <= ${schema.maximum}`;
      return undefined;
    default:
      return `has unsupported schema type ${JSON.stringify((schema as { type?: unknown }).type)}`;
  }
}

/** 按键查声明（用 Map，避免 `constructor` 等原型属性被当成已声明的键）。 */
const declMap = (decl: ModelParameter[]): Map<string, ModelParameter> =>
  new Map(decl.map((d) => [d.key, d]));

/**
 * 严格校验（保存 agent 时用）：未知键、类型不符、枚举越界、超出范围都算错，逐键报告。
 * 成功时 `value` 为传入的参数，不补默认值；值为 undefined 的键视为未设置。
 */
export function validateParams(
  decl: ModelParameter[],
  params: Record<string, unknown>,
): { ok: true; value: Record<string, ParamValue> } | { ok: false; issues: ParamIssue[] } {
  const byKey = declMap(decl);
  const value: Record<string, ParamValue> = {};
  const issues: ParamIssue[] = [];
  for (const [key, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const d = byKey.get(key);
    if (!d) {
      issues.push({ key, message: `unknown parameter "${key}"` });
      continue;
    }
    const why = checkValue(d.schema, v);
    if (why) issues.push({ key, message: `parameter "${key}" ${why}` });
    else value[key] = v as ParamValue;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/**
 * 宽松版（运行时用）：丢弃未知或不合法的项（键记入 `dropped`），再为未设置的已声明参数补默认值。
 * 用于插件升级后已保存的参数不再合法的情况，不让整轮运行失败。
 */
export function sanitizeParams(
  decl: ModelParameter[],
  params: Record<string, unknown>,
): { value: Record<string, ParamValue>; dropped: string[] } {
  const byKey = declMap(decl);
  const value: Record<string, ParamValue> = {};
  const dropped: string[] = [];
  for (const [key, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const d = byKey.get(key);
    if (!d || checkValue(d.schema, v) !== undefined) dropped.push(key);
    else value[key] = v as ParamValue;
  }
  for (const d of decl) {
    if (!Object.hasOwn(value, d.key) && d.default !== undefined) value[d.key] = d.default;
  }
  return { value, dropped };
}

function keyProblems(plugin: string, d: ModelParameter, key: string): string[] {
  if (isStandardKnob(key)) {
    return d.standard === key ? [] : [`standard knob "${key}" must set standard: "${key}"`];
  }
  const out: string[] = [];
  if (d.standard !== undefined) {
    out.push(`standard: "${d.standard}" requires key "${d.standard}"`);
  }
  const dot = key.indexOf(".");
  const prefix = dot < 0 ? "" : key.slice(0, dot);
  const name = dot < 0 ? key : key.slice(dot + 1);
  if (prefix !== plugin || !VENDOR_NAME.test(name)) {
    out.push(
      `vendor parameter key must be "${plugin}.<name>" (or a standard knob: ${STANDARD_KNOBS.join(", ")})`,
    );
  }
  return out;
}

function schemaProblems(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) return ["schema is required"];
  const s = schema as Record<string, unknown>;
  switch (s.type) {
    case "boolean":
      return [];
    case "string":
      if ("enum" in s) {
        const e = s.enum;
        if (!Array.isArray(e) || e.length === 0 || !e.every((x) => typeof x === "string"))
          return ["enum must be a non-empty array of strings"];
        return new Set(e).size === e.length ? [] : ["enum has duplicate values"];
      }
      if (s.maxLength !== undefined && !(Number.isInteger(s.maxLength) && Number(s.maxLength) >= 0))
        return ["maxLength must be a non-negative integer"];
      return [];
    case "number":
    case "integer": {
      const out: string[] = [];
      for (const b of ["minimum", "maximum"] as const) {
        const v = s[b];
        if (v !== undefined && !(typeof v === "number" && Number.isFinite(v)))
          out.push(`${b} must be a finite number`);
      }
      if (typeof s.minimum === "number" && typeof s.maximum === "number" && s.minimum > s.maximum)
        out.push("minimum must not exceed maximum");
      return out;
    }
    default:
      return [`unsupported schema type ${JSON.stringify(s.type)}`];
  }
}

/** 标准旋钮的取值约定（schema 本身已合法时才检查）。 */
function knobProblems(key: StandardKnob, schema: ParamSchema): string[] {
  const values = schema.type === "string" && "enum" in schema ? schema.enum : undefined;
  switch (key) {
    case "effort":
      return values?.every((x) => (EFFORT_VALUES as readonly string[]).includes(x))
        ? []
        : [`must be a string enum over a subset of ${EFFORT_VALUES.join("|")}`];
    case "thinking":
      return values?.every((x) => THINKING_VALUES.includes(x))
        ? []
        : [`must be a string enum over a subset of ${THINKING_VALUES.join("|")}`];
    case "temperature":
      return schema.type === "number" ? [] : ['must have schema type "number"'];
    case "maxOutputTokens":
      return schema.type === "integer" ? [] : ['must have schema type "integer"'];
  }
}

function textProblems(d: ModelParameter): string[] {
  const out: string[] = [];
  for (const f of ["label", "description"] as const) {
    const t = d[f] as { zh?: unknown; en?: unknown } | undefined;
    if (t === undefined && f === "description") continue;
    const ok =
      typeof t === "object" &&
      t !== null &&
      typeof t.zh === "string" &&
      typeof t.en === "string" &&
      t.zh.trim() !== "" &&
      t.en.trim() !== "";
    if (!ok) out.push(`${f} must have non-empty zh and en strings`);
  }
  return out;
}

/** 一个参数声明的全部问题；无问题返回空数组。 */
function declarationProblems(plugin: string, d: ModelParameter): string[] {
  if (typeof d !== "object" || d === null) return ["declaration must be an object"];
  if (typeof d.key !== "string") return ["key must be a string"];
  const out = [...keyProblems(plugin, d, d.key), ...schemaProblems(d.schema)];
  if (out.length === 0) {
    if (isStandardKnob(d.key)) out.push(...knobProblems(d.key, d.schema));
    if (d.default !== undefined) {
      const why = checkValue(d.schema, d.default);
      if (why) out.push(`default ${why}`);
    }
  }
  out.push(...textProblems(d));
  return out;
}

/**
 * 校验插件为一个模型声明的参数：键名是标准旋钮或 `<plugin>.<名称>`、`standard` 与键一致、
 * schema 属于受支持的子集、标准旋钮符合取值约定、默认值满足 schema、文案齐全、键不重复。
 * 有问题时抛错，信息点名插件与各个键（英文）。
 */
export function assertValidDeclarations(plugin: string, decl: ModelParameter[]): void {
  if (!Array.isArray(decl)) {
    throw new Error(`model provider ${plugin}: parameters must be an array`);
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const d of decl) {
    const key = typeof d?.key === "string" ? d.key : "<invalid>";
    if (seen.has(key)) problems.push(`"${key}": duplicate key`);
    seen.add(key);
    for (const p of declarationProblems(plugin, d)) problems.push(`"${key}": ${p}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `model provider ${plugin}: invalid parameter declarations: ${problems.join("; ")}`,
    );
  }
}
