import { checkParamValue, type ParamSchema } from "./model-params.js";

/** 工具注解（与 MCP 对齐的提示，用于推导默认策略）。 */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  requiresUserInteraction?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  /** 仅插件 / 内置工具可声明；缺省按注解推导。 */
  defaultPolicy?: "allow" | "ask";
  /**
   * 仅连接器工具：连接器自己的不透明数据（如 OpenAPI 的方法、路径模板、参数位置、服务器地址），可 JSON 序列化。
   * 内核把它与定义一起存进快照并计入指纹（变了即漂移、需复核），调用时经 `callTool` 的 `ctx.spec` 原样交回；
   * 绝不发给模型。
   */
  connectorData?: Record<string, unknown>;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

type Text = { zh: string; en: string } | string;

/** 交互表单：字段的 schema 只用 M2 的 ParamSchema 子集；枚举字段可设 multiSelect 与 allowOther。 */
export interface InputForm {
  /** 插件可给双语；内核内置工具给英文（模型生成的问题原样展示）。 */
  title: Text;
  fields: {
    key: string;
    label: Text;
    description?: Text;
    schema: ParamSchema;
    multiSelect?: boolean;
    allowOther?: boolean;
    required?: boolean;
  }[];
}

/**
 * 工具需要用户输入：内核暂停运行、渲染表单；用户提交后用同一 input 再次调用该工具，
 * 并在 ctx.resume 中带回 state 与 answer。state ≤ 16 KB，可 JSON 序列化。
 */
export interface InputRequired {
  kind: "input_required";
  form: InputForm;
  state?: unknown;
}

export type FormAnswer = Record<string, string | number | boolean | string[]>;

export interface ToolCallContext {
  orgId: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  callId: string;
  signal: AbortSignal;
  /** null = 用户取消或超时。 */
  resume?: { state: unknown; answer: FormAnswer | null };
}

export type ToolHandler = (
  input: unknown,
  ctx: ToolCallContext,
) => Promise<ToolResult | InputRequired>;

/**
 * 工具错误的类别：
 * - `error`（缺省）：远端可用、但这次调用失败（参数不对、业务错误、鉴权失败等），不计入应用熔断；
 * - `unavailable`：远端不可用（连接 / 传输错误、超时、HTTP 5xx），计入应用熔断（连接器用它告诉内核）。
 */
export type ToolErrorKind = "error" | "unavailable";

/** 工具执行失败：message 给模型看，须为英文且可操作。 */
export class ToolError extends Error {
  readonly kind: ToolErrorKind;

  constructor(message: string, opts?: { kind?: ToolErrorKind }) {
    super(message);
    this.name = "ToolError";
    this.kind = opts?.kind ?? "error";
  }
}

/** 插件工具名规则。 */
export const PLUGIN_TOOL_NAME = /^[a-zA-Z0-9_-]{1,40}$/;

/** 校验插件注册的工具声明，返回问题列表（空 = 合法）。 */
export function validateToolSpec(spec: ToolSpec): string[] {
  const out: string[] = [];
  if (typeof spec?.name !== "string" || !PLUGIN_TOOL_NAME.test(spec.name))
    out.push(`name must match ${PLUGIN_TOOL_NAME}`);
  if (typeof spec?.description !== "string" || spec.description.trim() === "")
    out.push("description must be a non-empty string");
  if (typeof spec?.inputSchema !== "object" || spec.inputSchema === null)
    out.push("inputSchema must be an object");
  if (
    spec?.defaultPolicy !== undefined &&
    spec.defaultPolicy !== "allow" &&
    spec.defaultPolicy !== "ask"
  )
    out.push('defaultPolicy must be "allow" or "ask"');
  return out;
}

const SCHEMA_KEYS: Record<string, readonly string[]> = {
  string: ["type", "enum", "maxLength"],
  boolean: ["type"],
  number: ["type", "minimum", "maximum"],
  integer: ["type", "minimum", "maximum"],
};

/** 检查 schema 是否落在 ParamSchema 子集内，返回问题列表。 */
function schemaProblems(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema))
    return ["schema must be an object"];
  const s = schema as Record<string, unknown>;
  const allowed = typeof s.type === "string" ? SCHEMA_KEYS[s.type] : undefined;
  if (!allowed) return [`unsupported schema type ${JSON.stringify(s.type)}`];
  const out: string[] = [];
  for (const k of Object.keys(s))
    if (!allowed.includes(k)) out.push(`unsupported schema keyword "${k}"`);
  if ("enum" in s) {
    if (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.some((x) => typeof x !== "string"))
      out.push("enum must be a non-empty array of strings");
    if ("maxLength" in s) out.push("enum and maxLength cannot be combined");
  }
  if ("maxLength" in s && (!Number.isInteger(s.maxLength) || (s.maxLength as number) < 0))
    out.push("maxLength must be a non-negative integer");
  for (const k of ["minimum", "maximum"]) {
    if (k in s && (typeof s[k] !== "number" || !Number.isFinite(s[k])))
      out.push(`${k} must be a finite number`);
  }
  if (typeof s.minimum === "number" && typeof s.maximum === "number" && s.minimum > s.maximum)
    out.push("minimum must be <= maximum");
  return out;
}

const isEnum = (s: ParamSchema): s is Extract<ParamSchema, { enum: string[] }> =>
  s.type === "string" && "enum" in s;

/** 校验交互表单的声明，返回问题列表（空 = 合法）。 */
export function validateInputForm(form: InputForm): string[] {
  const out: string[] = [];
  if (!form || !Array.isArray(form.fields)) return ["form.fields must be an array"];
  if (form.fields.length === 0) out.push("form must have at least one field");
  const seen = new Set<string>();
  for (const f of form.fields) {
    const at = `field ${JSON.stringify(f?.key)}`;
    if (typeof f?.key !== "string" || f.key === "") {
      out.push("field key must be a non-empty string");
      continue;
    }
    if (seen.has(f.key)) out.push(`${at}: duplicate key`);
    seen.add(f.key);
    const probs = schemaProblems(f.schema);
    for (const p of probs) out.push(`${at}: ${p}`);
    if (probs.length > 0) continue;
    if ((f.multiSelect || f.allowOther) && !isEnum(f.schema))
      out.push(`${at}: multiSelect and allowOther require a string enum schema`);
  }
  return out;
}

/** 校验用户提交的答案是否符合表单，返回问题列表（空 = 合法）。 */
export function validateAnswer(form: InputForm, answer: FormAnswer): string[] {
  const out: string[] = [];
  const byKey = new Map(form.fields.map((f) => [f.key, f]));
  for (const k of Object.keys(answer))
    if (!byKey.has(k)) out.push(`unknown field ${JSON.stringify(k)}`);
  for (const f of form.fields) {
    const at = `field ${JSON.stringify(f.key)}`;
    // 只认答案自身的键：`toString` / `constructor` 等继承属性不算已回答
    const v = Object.hasOwn(answer, f.key) ? answer[f.key] : undefined;
    if (v === undefined) {
      if (f.required) out.push(`${at}: is required`);
      continue;
    }
    if (f.multiSelect) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
        out.push(`${at}: must be an array of strings`);
        continue;
      }
      if (f.required && v.length === 0) out.push(`${at}: is required`);
      const seen = new Set<string>();
      for (const item of v) {
        if (seen.has(item)) {
          out.push(`${at}: duplicate value ${JSON.stringify(item)}`);
          continue;
        }
        seen.add(item);
        const why = otherOrValue(f, item);
        if (why) out.push(`${at}: ${why}`);
      }
      continue;
    }
    if (Array.isArray(v)) {
      out.push(`${at}: must not be an array`);
      continue;
    }
    if (f.required && v === "") {
      out.push(`${at}: is required`);
      continue;
    }
    const why = otherOrValue(f, v);
    if (why) out.push(`${at}: ${why}`);
  }
  return out;
}

/** allowOther 的枚举字段接受任意非空文本，其余按 schema 校验。 */
function otherOrValue(f: InputForm["fields"][number], v: unknown): string | undefined {
  if (f.allowOther && isEnum(f.schema)) {
    return typeof v === "string" && v !== "" ? undefined : "other text must be a non-empty string";
  }
  return checkParamValue(f.schema, v);
}
