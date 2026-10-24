import type { ZodTypeAny } from "zod";

/** 不改变形状的包装（剥掉后看内层）。 */
const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "catch",
  "nonoptional",
  "success",
]);

interface Def {
  type: string;
  innerType?: ZodTypeAny;
  in?: ZodTypeAny;
  getter?: () => ZodTypeAny;
  shape?: Record<string, ZodTypeAny>;
  catchall?: ZodTypeAny;
  valueType?: ZodTypeAny;
  options?: ZodTypeAny[];
  left?: ZodTypeAny;
  right?: ZodTypeAny;
}

const defOf = (s: ZodTypeAny) => (s as unknown as { _zod: { def: Def } })._zod.def;

function unwrap(s: ZodTypeAny, depth: number): ZodTypeAny | undefined {
  let node = s;
  for (let i = 0; i < 50; i++) {
    const d = defOf(node);
    if (WRAPPERS.has(d.type) && d.innerType) node = d.innerType;
    else if (d.type === "pipe" && d.in) node = d.in;
    else if (d.type === "lazy" && d.getter && depth < 20) node = d.getter();
    else return node;
  }
  return undefined;
}

/**
 * zod schema（v4）里是否有点路径 `segs` 指向的字段（连接器模板的 `editableEndpoint` 用）：对象按 shape（或非 never 的
 * catchall）、记录类型的任意键、union / 交叉的任一分支；包装（optional、default、pipe 的输入端等）剥掉再看。
 * 空路径即 schema 本身，恒为 true。叶子之下还有路径 → false。
 */
export function schemaHasPath(schema: ZodTypeAny, segs: string[], depth = 0): boolean {
  if (depth > 40) return false;
  const node = unwrap(schema, depth);
  if (!node) return false;
  if (segs.length === 0) return true;
  const [head, ...rest] = segs as [string, ...string[]];
  const d = defOf(node);
  switch (d.type) {
    case "object": {
      const child = d.shape && Object.hasOwn(d.shape, head) ? d.shape[head] : undefined;
      if (child) return schemaHasPath(child, rest, depth + 1);
      if (d.catchall && defOf(d.catchall).type !== "never") {
        return schemaHasPath(d.catchall, rest, depth + 1);
      }
      return false;
    }
    case "record":
      return d.valueType ? schemaHasPath(d.valueType, rest, depth + 1) : false;
    case "union":
      return (d.options ?? []).some((o) => schemaHasPath(o, segs, depth + 1));
    case "intersection":
      return (
        (d.left !== undefined && schemaHasPath(d.left, segs, depth + 1)) ||
        (d.right !== undefined && schemaHasPath(d.right, segs, depth + 1))
      );
    default:
      return false;
  }
}
