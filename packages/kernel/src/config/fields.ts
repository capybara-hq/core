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

/**
 * 剥掉包装后的内层 schema 类型与默认值（无 default 时 hasDefault 为 false）；
 * `optional` 表示包装链上有 optional（可以不填，且没有默认值时值为 undefined）。
 */
export function describeSchema(schema: core.$ZodType): {
  type: string;
  hasDefault: boolean;
  defaultValue: unknown;
  optional: boolean;
} {
  let node = schema;
  let hasDefault = false;
  let optional = false;
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
    if (def.type === "optional") optional = true;
    if (!WRAPPERS.has(def.type) || !def.innerType) break;
    node = def.innerType;
  }
  const def = node._zod.def as unknown as {
    type: string;
    element?: core.$ZodType;
    entries?: Record<string, unknown>;
    options?: core.$ZodType[];
    in?: core.$ZodType;
    out?: core.$ZodType;
  };
  // z.preprocess(fn, T) is a pipe from a transform into T: document T.
  if (def.type === "pipe" && def.in?._zod.def.type === "transform" && def.out) {
    return { ...describeSchema(def.out), hasDefault, defaultValue, optional };
  }
  let type = def.type;
  if (type === "array" && def.element) type = `array<${describeSchema(def.element).type}>`;
  else if (type === "union" && def.options) {
    type = def.options.map((o) => describeSchema(o).type).join(" | ");
  } else if (type === "enum" && def.entries) {
    type = Object.values(def.entries)
      .map((v) => JSON.stringify(v))
      .join(" | ");
  }
  return { type, hasDefault, defaultValue, optional };
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

/**
 * 把一个密钥值展开成需要打码的字符串：字符串原样；数字、bigint 转成字符串；布尔不收集
 * （`true` / `false` 不携带秘密，登记只会误伤普通文本）；数组与对象（secret 叶子可能是 record / 数组 / 对象）
 * 递归展开所有标量。最短长度由 logger 把关。
 */
export function secretScalars(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "bigint") {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const v of value) secretScalars(v, out);
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) secretScalars(v, out);
  }
  return out;
}

/** 收集标记为 secret 的字段的值（嵌套的数组 / 对象展开为其中所有标量，数字转成字符串，布尔跳过），供 logger 打码。 */
export function secretValues(schema: core.$ZodType, config: unknown): string[] {
  const out: string[] = [];
  for (const f of configFields(schema)) {
    if (f.meta?.secret) secretScalars(getPath(config, f.path), out);
  }
  return out;
}

const isSecretNode = (node: core.$ZodType): boolean =>
  (z.globalRegistry.get(node) as FieldMeta | undefined)?.secret === true;

/**
 * 找出 `configFields` 拆不出来的 secret 标记：secret 只能标在「从根经对象字段（及 default / optional 等包装）
 * 可达」的节点上。标在 union / intersection / pipe（含 transform）/ lazy / array 元素 / record 值 /
 * tuple / map / set 等内部的 secret，内核既无法单独加密存储也无法打码，返回其描述路径
 * （如 `auth<union#1>.token`）。对象路径上的 secret 若未让对应叶子被视为 secret（被外层 meta 遮蔽）同样返回。
 */
export function unreachableSecrets(schema: core.$ZodType): string[] {
  const covered = configFields(schema)
    .filter((f) => f.meta?.secret)
    .map((f) => f.path);
  const isCovered = (p: string) =>
    covered.some((c) => p === "" || c === p || c.startsWith(`${p}.`));
  const out: string[] = [];
  // 只防 lazy 自引用造成的环：同一 schema 实例可能复用在多个位置，每个位置都要检查
  const stack = new Set<core.$ZodType>();
  const join = (prefix: string, seg: string) => (prefix ? `${prefix}.${seg}` : seg);
  const t = (v: unknown) => v as core.$ZodType;

  const walk = (node: core.$ZodType, label: string, onPath: boolean): void => {
    if (stack.has(node)) return;
    stack.add(node);
    try {
      visit(node, label, onPath);
    } finally {
      stack.delete(node);
    }
  };
  const visit = (node: core.$ZodType, label: string, onPath: boolean): void => {
    if (isSecretNode(node)) {
      if (onPath && isCovered(label)) return; // 整棵子树都按 secret 处理
      out.push(label || "<root>");
      return;
    }
    const def = node._zod.def as unknown as Record<string, unknown> & { type: string };
    switch (def.type) {
      case "object":
        for (const [k, v] of Object.entries(def.shape as Record<string, core.$ZodType>)) {
          walk(v, join(label, k), onPath);
        }
        if (def.catchall) walk(t(def.catchall), `${label}<catchall>`, false);
        return;
      case "union":
        (def.options as core.$ZodType[]).forEach((o, i) => {
          walk(o, `${label}<union#${i}>`, false);
        });
        return;
      case "intersection":
        walk(t(def.left), `${label}<intersection:left>`, false);
        walk(t(def.right), `${label}<intersection:right>`, false);
        return;
      case "pipe":
        walk(t(def.in), `${label}<pipe:in>`, false);
        walk(t(def.out), `${label}<pipe:out>`, false);
        return;
      case "lazy":
        walk((def.getter as () => core.$ZodType)(), `${label}<lazy>`, false);
        return;
      case "array":
        walk(t(def.element), `${label}[]`, false);
        return;
      case "set":
        walk(t(def.valueType), `${label}<set>`, false);
        return;
      case "record":
      case "map":
        walk(t(def.keyType), `${label}<${def.type}:key>`, false);
        walk(t(def.valueType), `${label}<${def.type}:value>`, false);
        return;
      case "tuple":
        (def.items as core.$ZodType[]).forEach((o, i) => {
          walk(o, `${label}[${i}]`, false);
        });
        if (def.rest) walk(t(def.rest), `${label}[...]`, false);
        return;
      default:
        // default / optional 等包装沿用 configFields 的对象路径；其余带 innerType 的包装（nonoptional、
        // promise 等）configFields 视作叶子，其内部的 secret 不可达。
        if (def.innerType) walk(t(def.innerType), label, onPath && WRAPPERS.has(def.type));
    }
  };
  walk(schema, "", true);
  return out;
}
