import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

/** JSON Schema 无法表达的 zod 类型：降级为 `{}` 并标注 `x-unsupported`。 */
const UNSUPPORTED = new Set([
  "bigint",
  "date",
  "symbol",
  "undefined",
  "void",
  "nan",
  "map",
  "set",
  "function",
  "promise",
  "custom",
  "file",
]);

/**
 * 把插件配置 schema 转成 JSON Schema（供界面渲染表单）：
 * - `secret()` 字段带 `"x-secret": true`（去掉 zod 附带的 `secret` 元数据键）；
 * - 无法表达的类型为 `{ "x-unsupported": true }`，不抛错；
 * - 以输入侧形态输出（含 default），不带 `$schema`。
 */
export function configToJsonSchema(schema: z.ZodType): JsonSchema {
  const out = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: (ctx) => {
      const js = ctx.jsonSchema as JsonSchema;
      const def = (ctx.zodSchema as { _zod: { def: { type: string } } })._zod.def;
      if (js.secret === true) {
        delete js.secret;
        js["x-secret"] = true;
      }
      if (UNSUPPORTED.has(def.type)) js["x-unsupported"] = true;
    },
  }) as JsonSchema;
  delete out.$schema;
  scrubSecrets(out);
  return out;
}

/** 会泄露取值的关键字：密钥字段一律不输出。 */
const VALUE_KEYWORDS = ["default", "examples", "const", "enum"];

/** 值为「名字 -> 子 schema」映射的关键字：其键是用户字段名，不是关键字。 */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/**
 * 递归清掉密钥节点及其所有后代上会暴露取值的关键字（`inSecret` 随递归下传）；无环（输出为纯 JSON 树）。
 * 只有 schema 关键字 default / examples / const / enum 的值被当作数据跳过；
 * `properties` 等映射里的键是字段名，名为 default / enum 的字段照常遍历。
 */
function scrubSecrets(node: unknown, inSecret = false): void {
  if (Array.isArray(node)) {
    for (const n of node) scrubSecrets(n, inSecret);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const o = node as JsonSchema;
  const secret = inSecret || o["x-secret"] === true;
  if (secret) for (const k of VALUE_KEYWORDS) delete o[k];
  for (const [k, v] of Object.entries(o)) {
    if (SCHEMA_MAPS.has(k) && typeof v === "object" && v !== null) {
      for (const child of Object.values(v)) scrubSecrets(child, secret);
    } else if (!VALUE_KEYWORDS.includes(k)) {
      scrubSecrets(v, secret);
    }
  }
}
