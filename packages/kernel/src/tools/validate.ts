import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { canonicalJson } from "./registry.js";

/**
 * 编译结果缓存的上限：超过后整体丢弃并新建 Ajv 实例（Ajv 自己也按 schema 对象缓存，
 * 工具定义每步从库里重新读出，不重建实例会无限增长）。缓存的是由定义推导出的只读数据，不是跨进程状态。
 */
const CACHE_MAX = 500;

const newAjv = () => new Ajv2020({ strict: false, allErrors: true });
let ajv = newAjv();
const compiled = new Map<string, ValidateFunction | null>();

/**
 * 编译工具的 inputSchema；去掉 `$schema`（MCP 服务常声明 draft-07，Ajv 2020 实例不认它的元 schema）。
 * 定义本身无法编译 → null（不拦截调用，交给工具自己校验）。
 */
function compile(schema: Record<string, unknown>): ValidateFunction | null {
  const { $schema: _ignored, ...rest } = schema;
  const key = canonicalJson(rest);
  if (compiled.has(key)) return compiled.get(key) ?? null;
  if (compiled.size >= CACHE_MAX) {
    compiled.clear();
    ajv = newAjv();
  }
  let fn: ValidateFunction | null;
  try {
    fn = ajv.compile(rest);
  } catch {
    fn = null;
  }
  compiled.set(key, fn);
  return fn;
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

/**
 * 管线第 2 阶段：按工具的 inputSchema 校验参数（ajv，JSON Schema 2020-12，`strict: false`，`allErrors: true`）。
 * 合法 → null；不合法 → 给模型的英文说明：全部错误路径 + 完整 inputSchema（spec 6.3「给事实，不猜」）。
 * schema 自身无法编译时不拦截（返回 null）。
 */
export function validateInput(key: string, spec: ToolSpec, input: unknown): string | null {
  const fn = compile(spec.inputSchema);
  if (!fn || fn(input)) return null;
  const errors = (fn.errors ?? []).map(describe);
  return `Invalid arguments for ${key}: ${errors.join("; ")}\nInput schema: ${JSON.stringify(spec.inputSchema)}`;
}
