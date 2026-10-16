import { isDeepStrictEqual } from "node:util";
import { type core, z } from "zod";
import type { FieldMeta } from "./schema.js";

/** 一个配置叶子字段：点路径与其元信息。 */
export interface ConfigField {
  path: string;
  meta: FieldMeta | undefined;
  /** 该叶子的原始 schema（含 default / optional 等包装），供生成文档读取类型与默认值。 */
  schema: core.$ZodType;
}

/** 剥掉包装后的内层 schema 类型与默认值（无 default 时 hasDefault 为 false）。 */
export function describeSchema(schema: core.$ZodType): {
  type: string;
  hasDefault: boolean;
  defaultValue: unknown;
} {
  let node = schema;
  let hasDefault = false;
  let defaultValue: unknown;
  for (;;) {
    const def = node._zod.def as unknown as {
      type: string;
      innerType?: core.$ZodType;
      defaultValue?: unknown;
    };
    if (def.type === "default" || def.type === "prefault") {
      if (!hasDefault) {
        hasDefault = true;
        defaultValue = def.defaultValue;
      }
    }
    if (!WRAPPERS.has(def.type) || !def.innerType) break;
    node = def.innerType;
  }
  const def = node._zod.def as unknown as {
    type: string;
    element?: core.$ZodType;
    entries?: Record<string, unknown>;
  };
  let type = def.type;
  if (type === "array" && def.element) type = `array<${describeSchema(def.element).type}>`;
  else if (type === "enum" && def.entries) {
    type = Object.values(def.entries)
      .map((v) => JSON.stringify(v))
      .join(" | ");
  }
  return { type, hasDefault, defaultValue };
}

const WRAPPERS = new Set(["default", "prefault", "optional", "nullable", "readonly", "catch"]);

/** 剥掉 default / optional 等包装，返回内层 schema 与沿途遇到的第一个（最外层）元信息。 */
function unwrap(schema: core.$ZodType): { inner: core.$ZodType; meta: FieldMeta | undefined } {
  let node = schema;
  let found = z.globalRegistry.get(node) as FieldMeta | undefined;
  while (WRAPPERS.has(node._zod.def.type)) {
    node = (node._zod.def as unknown as { innerType: core.$ZodType }).innerType;
    found ??= z.globalRegistry.get(node) as FieldMeta | undefined;
  }
  return { inner: node, meta: found };
}

/** 列出 schema 的所有叶子字段（对象递归展开；数组、record 等视作叶子）。 */
export function configFields(
  schema: core.$ZodType,
  prefix = "",
  inheritedSecret = false,
): ConfigField[] {
  const { inner, meta: own } = unwrap(schema);
  const secret = inheritedSecret || own?.secret === true;
  // 对象节点上标的 secret 对所有后代叶子生效，否则嵌套字段的默认值会被文档/日志漏出。
  const meta: FieldMeta | undefined =
    secret && own?.secret !== true
      ? { ...own, secret: true, description: own?.description ?? "" }
      : own;
  if (inner._zod.def.type === "object") {
    const shape = (inner._zod.def as unknown as { shape: Record<string, core.$ZodType> }).shape;
    return Object.entries(shape).flatMap(([k, v]) =>
      configFields(v, prefix ? `${prefix}.${k}` : k, secret),
    );
  }
  return [{ path: prefix, meta, schema }];
}

/** 按点路径取值。 */
export function getPath(obj: unknown, path: string): unknown {
  let node = obj;
  for (const seg of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** 按点路径设值（就地修改，中间对象必须已存在）。 */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let node = obj;
  for (const seg of segs.slice(0, -1)) node = node[seg] as Record<string, unknown>;
  node[segs[segs.length - 1] as string] = value;
}

/** 比较两份已校验配置，返回值发生变化的叶子点路径。 */
export function changedPaths(schema: core.$ZodType, a: unknown, b: unknown): string[] {
  return configFields(schema)
    .map((f) => f.path)
    .filter((p) => !isDeepStrictEqual(getPath(a, p), getPath(b, p)));
}

/** 收集标记为 secret 的字段的字符串值（数组逐项展开），供 logger 打码。 */
export function secretValues(schema: core.$ZodType, config: unknown): string[] {
  const out: string[] = [];
  for (const f of configFields(schema)) {
    if (!f.meta?.secret) continue;
    const v = getPath(config, f.path);
    for (const item of Array.isArray(v) ? v : [v]) if (typeof item === "string") out.push(item);
  }
  return out;
}
