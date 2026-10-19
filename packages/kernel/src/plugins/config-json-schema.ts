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
  return out;
}
