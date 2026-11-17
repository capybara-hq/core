/**
 * Parameter declarations and validation for `model-provider@2` (pure functions; issues / error
 * messages are in English, for logs and API responses).
 * Each model declares in `ModelInfo.parameters` the parameters it supports; value constraints are a
 * restricted JSON Schema subset.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Standard knobs: uniform platform semantics, rendered specially by the UI, with semantics that
 * carry over when switching models or falling back; the plugin maps them to native parameters.
 * - `effort`: thinking depth, `{ type: "string", enum }`, values a subset of
 *   `low|medium|high|xhigh|max`;
 * - `thinking`: thinking mode, `{ type: "string", enum }`, values a subset of `off|on|summarized`;
 * - `temperature`: `{ type: "number" }` (may carry a range);
 * - `maxOutputTokens`: maximum output tokens, `{ type: "integer" }` (may carry a range).
 */
export type StandardKnob = "effort" | "thinking" | "temperature" | "maxOutputTokens";

export const STANDARD_KNOBS: readonly StandardKnob[] = [
  "effort",
  "thinking",
  "temperature",
  "maxOutputTokens",
];
/** The full set of values the `effort` knob allows. */
export const EFFORT_VALUES: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
/** The full set of values the `thinking` knob allows. */
export const THINKING_VALUES: readonly string[] = ["off", "on", "summarized"];

/**
 * Parameter value constraints: a restricted JSON Schema subset (serializable for the UI; the kernel
 * validates it itself, without ajv).
 */
export type ParamSchema =
  | { type: "string"; enum: string[] }
  | { type: "string"; maxLength?: number }
  | { type: "boolean" }
  | { type: "number" | "integer"; minimum?: number; maximum?: number };

export type ParamValue = string | number | boolean;

/** One parameter a model declares. */
export interface ModelParameter {
  /**
   * A standard knob name (see {@link StandardKnob}), or a vendor-specific parameter `"<plugin
   * name>.<name>"`.
   */
  key: string;
  /**
   * Required when key is a standard knob and must equal key; vendor-specific parameters must not
   * set it.
   */
  standard?: StandardKnob;
  schema: ParamSchema;
  /** The value used when unset; must satisfy the schema. */
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

/** Returns an English reason when the value does not satisfy the schema, undefined when it does. */
export function checkParamValue(schema: ParamSchema, v: unknown): string | undefined {
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

/**
 * Looks up a declaration by key (uses a Map so that prototype properties such as `constructor` are
 * not mistaken for declared keys).
 */
const declMap = (decl: ModelParameter[]): Map<string, ModelParameter> =>
  new Map(decl.map((d) => [d.key, d]));

/**
 * Strict validation (used when saving an agent): unknown keys, type mismatches, enum violations and
 * out-of-range values are all errors, reported per key.
 * On success `value` is the input parameters, with no defaults filled in; a key whose value is
 * undefined counts as unset.
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
    const why = checkParamValue(d.schema, v);
    if (why) issues.push({ key, message: `parameter "${key}" ${why}` });
    else value[key] = v as ParamValue;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/**
 * The lenient variant (used at runtime): drops unknown or invalid entries (their keys go into
 * `dropped`), then fills defaults for declared parameters that are unset.
 * For the case where saved parameters are no longer valid after a plugin upgrade, so that the whole
 * run does not fail.
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
    if (!d || checkParamValue(d.schema, v) !== undefined) dropped.push(key);
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

/**
 * The value conventions of standard knobs (checked only when the schema itself is already valid).
 */
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

/** All problems of one parameter declaration; an empty array when there are none. */
function declarationProblems(plugin: string, d: ModelParameter): string[] {
  if (typeof d !== "object" || d === null) return ["declaration must be an object"];
  if (typeof d.key !== "string") return ["key must be a string"];
  const out = [...keyProblems(plugin, d, d.key), ...schemaProblems(d.schema)];
  if (out.length === 0) {
    if (isStandardKnob(d.key)) out.push(...knobProblems(d.key, d.schema));
    if (d.default !== undefined) {
      const why = checkParamValue(d.schema, d.default);
      if (why) out.push(`default ${why}`);
    }
  }
  out.push(...textProblems(d));
  return out;
}

/**
 * Validates the parameters a plugin declares for a model: the key is a standard knob or
 * `<plugin>.<name>`, `standard` agrees with the key,
 * the schema belongs to the supported subset, standard knobs satisfy the value conventions,
 * defaults satisfy the schema, copy is complete, keys do not repeat.
 * Throws when there is a problem, with a message naming the plugin and each key (in English).
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
