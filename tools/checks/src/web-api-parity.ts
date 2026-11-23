/**
 * `check:web-api-parity` (issue #117): the web's hand-written API types (`apiFetch<T>(…)` in
 * `apps/web/src`) against the kernel routes they call. `apps/web` never imports the kernel, so this
 * is a parity check, not a dependency: one TypeScript program per side (the repo's own TypeScript,
 * through its checker API), each type reduced to a neutral JSON shape ({@link Shape}), and the
 * shapes compared per route.
 *
 * - Kernel side: every `@Controller` class under the kernel source; a route's response is its
 *   method's declared return type (`Promise` unwrapped; a method writing the reply itself through
 *   `@Res()` without `passthrough` has none); its request body is the input type of the zod schema of its `@ZBody(Dto)`
 *   (`z.input`, so a field with a default is optional), the schema in the route's `*.schemas.ts`.
 * - Web side: every `apiFetch<T>(path, init)` call. The path is resolved statically (string
 *   constants, template literals, small helpers such as `org(orgId)`; an unknown part matches one
 *   path segment), the method and body from `init` (`{ method, body: JSON.stringify(x) }` or a helper
 *   such as `post(x)` that returns one).
 *
 * Rules (each finding names the route and the field path):
 * - `web-api-field-gone`: a field of `T` the kernel's response does not have;
 * - `web-api-type`: a kind the kernel can return that `T` does not allow (a type mismatch, `null`
 *   or an absent field where the web expects a value, a free string where the web expects an enum);
 * - `web-api-enum`: an enum value on one side only (the kernel can return a value `T` lacks, or
 *   `T` lists one the kernel never returns);
 * - `web-api-body-field`, `web-api-body-type`, `web-api-body-enum`, `web-api-body-required`: the same
 *   for the body the web sends (a field the route does not accept, a type or enum value it refuses,
 *   a field it requires that the web's type may leave out);
 * - `web-api-route-gone`: no kernel route has the call's method and path;
 * - `web-api-allow-stale`: an {@link WEB_API_PARITY_ALLOW} entry that matches no finding.
 *
 * A web property tagged `@clientOnly` ({@link CLIENT_ONLY_TAG}) is filled by the web and skipped.
 * Nothing here is per route: a changed route schema is fixed in the web type the finding names.
 */
import { readFileSync } from "node:fs";
import { join as join_, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Node,
  type NodeArray,
  type SourceFile,
  SyntaxKind,
  type TypeNode,
} from "typescript/unstable/ast";
import {
  API,
  type Checker,
  type LiteralType,
  type Project,
  SymbolFlags,
  type Symbol as TsSymbol,
  type Type,
  TypeFlags,
  type TypeReference,
  type UnionOrIntersectionType,
} from "typescript/unstable/sync";
import type { Finding } from "./source.js";

/** A node read for the fields one syntax kind has (checked by `kind` first). */
type Ast<T> = Node & T;

// ---------------------------------------------------------------------------------------------
// Shapes

/** A JSON value's type, as both sides are reduced to before comparing. */
export type Shape =
  | { k: "any" }
  | { k: "never" }
  | { k: "string" }
  | { k: "number" }
  | { k: "boolean" }
  | { k: "null" }
  | { k: "undefined" }
  | { k: "lit"; v: string | number | boolean }
  | { k: "array"; of: Shape }
  | { k: "object"; props: Map<string, Prop>; index?: Shape }
  | { k: "union"; of: Shape[] };

export interface Prop {
  optional: boolean;
  shape: Shape;
  /** The property's symbol id (one declaration however the type reaches it). */
  id?: number;
  /** Tagged `@clientOnly` on the web: set by the web itself, never on the wire (not compared). */
  clientOnly?: boolean;
}

/** The JSDoc tag a web property carries when the web fills it itself (never sent by the kernel). */
export const CLIENT_ONLY_TAG = "clientOnly";

const ANY: Shape = { k: "any" };

/** Types whose JSON form is not their structure. */
const AS_STRING = new Set(["Date", "URL"]);
const OPAQUE = new Set([
  "Map",
  "Set",
  "WeakMap",
  "Buffer",
  "Uint8Array",
  "ArrayBuffer",
  "Blob",
  "ReadableStream",
]);

class Shaper {
  private readonly memo = new Map<number, Shape>();
  private readonly tagged = new Map<string, boolean>();
  constructor(
    private readonly checker: Checker,
    /** Read the {@link CLIENT_ONLY_TAG} of properties (the web side). */
    private readonly readTags = false,
  ) {}

  private clientOnly(s: TsSymbol): boolean {
    if (!this.readTags) return false;
    const file = s.declarations[0]?.path;
    if (file === undefined) return false;
    // Only files that mention the tag pay for the tag lookup.
    let mentions = this.tagged.get(file);
    if (mentions === undefined) {
      try {
        mentions = readFileSync(file, "utf8").includes(`@${CLIENT_ONLY_TAG}`);
      } catch {
        mentions = false;
      }
      this.tagged.set(file, mentions);
    }
    return mentions && this.checker.getJsDocTagsOfSymbol(s).some((t) => t.name === CLIENT_ONLY_TAG);
  }

  of(type: Type | undefined): Shape {
    if (type === undefined) return ANY;
    const hit = this.memo.get(type.id);
    if (hit !== undefined) return hit;
    // A recursive type meets itself as `any` (no deeper comparison).
    this.memo.set(type.id, ANY);
    const shape = this.build(type);
    this.memo.set(type.id, shape);
    return shape;
  }

  private build(t: Type): Shape {
    const f = t.flags;
    if (f & (TypeFlags.Any | TypeFlags.Unknown)) return ANY;
    if (f & TypeFlags.Never) return { k: "never" };
    if (f & TypeFlags.Boolean) return { k: "boolean" };
    if (f & TypeFlags.Union) {
      return union((t as UnionOrIntersectionType).getTypes().map((m) => this.of(m)));
    }
    if (f & TypeFlags.StringLiteral) return { k: "lit", v: String((t as LiteralType).value) };
    if (f & TypeFlags.NumberLiteral) return { k: "lit", v: Number((t as LiteralType).value) };
    if (f & TypeFlags.BooleanLiteral) {
      const v =
        (t as LiteralType).value === true ||
        (t as { intrinsicName?: string }).intrinsicName === "true";
      return { k: "lit", v };
    }
    if (f & (TypeFlags.String | TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) {
      return { k: "string" };
    }
    if (f & (TypeFlags.Number | TypeFlags.BigInt | TypeFlags.BigIntLiteral)) return { k: "number" };
    if (f & TypeFlags.Null) return { k: "null" };
    if (f & (TypeFlags.Undefined | TypeFlags.Void)) return { k: "undefined" };
    if (f & TypeFlags.TypeParameter) {
      const c = this.checker.getBaseConstraintOfType(t);
      return c === undefined || c.id === t.id ? ANY : this.of(c);
    }
    if (f & TypeFlags.Intersection) {
      // A branded primitive (`string & { __brand }`) is the primitive.
      for (const m of (t as UnionOrIntersectionType).getTypes()) {
        if (m.flags & (TypeFlags.StringLike | TypeFlags.NumberLike | TypeFlags.BooleanLike)) {
          return this.of(m);
        }
      }
      return this.object(t);
    }
    if (f & (TypeFlags.Object | TypeFlags.NonPrimitive)) return this.object(t);
    return ANY;
  }

  private object(t: Type): Shape {
    const c = this.checker;
    const name = t.getSymbol?.()?.name;
    if (name !== undefined && AS_STRING.has(name)) return { k: "string" };
    if (name !== undefined && OPAQUE.has(name)) return ANY;
    if (c.isArrayType(t) || c.isTupleType(t)) {
      const args = c.getTypeArguments(t as TypeReference);
      return { k: "array", of: union(args.map((a) => this.of(a))) };
    }
    const symbols = c.getPropertiesOfType(t);
    const toJson = symbols.find((s) => s.name === "toJSON");
    if (toJson !== undefined) {
      const sig = c.getSignaturesOfType(c.getTypeOfSymbol(toJson) as Type, 0)[0];
      return sig === undefined ? ANY : this.of(c.getReturnTypeOfSignature(sig));
    }
    const data = symbols.filter((s) => !(s.flags & SymbolFlags.Method));
    const types = data.length > 0 ? c.getTypeOfSymbol(data) : [];
    const props = new Map<string, Prop>();
    data.forEach((s, i) => {
      const pt = types[i];
      // A function-valued property is not part of the JSON.
      if (
        pt !== undefined &&
        c.getSignaturesOfType(pt, 0).length > 0 &&
        c.getPropertiesOfType(pt).length === 0
      )
        return;
      props.set(s.name, {
        optional: (s.flags & SymbolFlags.Optional) !== 0,
        shape: this.of(pt),
        id: s.id,
        ...(this.clientOnly(s) ? { clientOnly: true } : {}),
      });
    });
    const index = c.getIndexInfosOfType(t).find((i) => i.keyType.flags & TypeFlags.String);
    if (props.size === 0 && symbols.length > 0 && index === undefined) return ANY; // only methods
    return { k: "object", props, ...(index ? { index: this.of(index.valueType) } : {}) };
  }
}

function union(members: Shape[]): Shape {
  const flat: Shape[] = [];
  const push = (s: Shape) => {
    if (s.k === "union") s.of.forEach(push);
    else if (s.k !== "never") flat.push(s);
  };
  members.forEach(push);
  if (flat.some((s) => s.k === "any")) return ANY;
  const hasTrue = flat.some((s) => s.k === "lit" && s.v === true);
  const hasFalse = flat.some((s) => s.k === "lit" && s.v === false);
  let out = flat;
  if (hasTrue && hasFalse) {
    out = flat.filter((s) => !(s.k === "lit" && typeof s.v === "boolean"));
    out.push({ k: "boolean" });
  }
  const seen = new Set<string>();
  out = out.filter((s) => {
    const key =
      s.k === "lit"
        ? `lit:${typeof s.v}:${String(s.v)}`
        : s.k === "object" || s.k === "array"
          ? ""
          : s.k;
    if (key === "") return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (out.length === 0) return { k: "never" };
  if (out.length === 1) return out[0] as Shape;
  return { k: "union", of: out };
}

const members = (s: Shape): Shape[] => (s.k === "union" ? s.of : [s]);

/** Renders a shape for a message (one level deep). */
export function showShape(s: Shape): string {
  switch (s.k) {
    case "lit":
      return JSON.stringify(s.v);
    case "array":
      return `${showShape(s.of)}[]`;
    case "object":
      return "object";
    case "union":
      return s.of.map(showShape).join(" | ");
    default:
      return s.k;
  }
}

// ---------------------------------------------------------------------------------------------
// Comparison

export interface Mismatch {
  rule: string;
  /**
   * For `web-api-field-gone` on an optional field: the web property's symbol id, so a field a
   * shared web type marks optional is only reported when no route compared with it returns it.
   */
  optionalOf?: number;
  /** The field path inside the response or body (`items[].scope`), `""` for the root. */
  field: string;
  message: string;
}

type Category = "string" | "number" | "boolean" | "null" | "undefined" | "array" | "object";

function categoryOf(s: Shape): Category | undefined {
  switch (s.k) {
    case "lit":
      return typeof s.v === "string" ? "string" : typeof s.v === "number" ? "number" : "boolean";
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "undefined":
    case "array":
    case "object":
      return s.k;
    default:
      return undefined;
  }
}

const join = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);
const fieldName = (path: string) => (path === "" ? "the response" : `\`${path}\``);

interface Side {
  free: boolean;
  lits: Set<string | number | boolean>;
}

function scalarSide(ms: Shape[], cat: "string" | "number" | "boolean"): Side | undefined {
  let found = false;
  let free = false;
  const lits = new Set<string | number | boolean>();
  for (const m of ms) {
    if (categoryOf(m) !== cat) continue;
    found = true;
    if (m.k === "lit") lits.add(m.v);
    else free = true;
  }
  if (cat === "boolean" && lits.size === 2) free = true;
  return found ? { free, lits } : undefined;
}

function mergeObjects(objs: Shape[]): Shape & { k: "object" } {
  const props = new Map<string, Prop>();
  const indexes: Shape[] = [];
  const os = objs.filter((o): o is Shape & { k: "object" } => o.k === "object");
  if (os.length === 1) return os[0] as Shape & { k: "object" };
  for (const o of os) {
    if (o.index) indexes.push(o.index);
    for (const [name, p] of o.props) {
      const prev = props.get(name);
      props.set(
        name,
        prev
          ? { optional: prev.optional || p.optional, shape: union([prev.shape, p.shape]) }
          : { ...p },
      );
    }
  }
  // A field only some members have may be absent.
  for (const [name, p] of props) {
    if (os.some((o) => !o.props.has(name) && o.index === undefined)) {
      props.set(name, { optional: true, shape: union([p.shape, { k: "undefined" }]) });
    }
  }
  return { k: "object", props, ...(indexes.length > 0 ? { index: union(indexes) } : {}) };
}

/**
 * A property every object member on both sides has as literals, different literals per member on
 * each side: the union's discriminant (`type`, `kind`).
 */
function discriminant(a: Shape[], b: Shape[]): string | undefined {
  const objs = [...a, ...b];
  if (a.length < 2 || b.length < 2 || objs.some((o) => o.k !== "object")) return undefined;
  const first = objs[0] as Shape & { k: "object" };
  const disjoint = (side: Shape[], name: string) => {
    const seen = new Set<string | number | boolean>();
    for (const o of side) {
      for (const v of litsOf(o, name)) {
        if (seen.has(v)) return false;
        seen.add(v);
      }
    }
    return true;
  };
  for (const name of first.props.keys()) {
    const ok = objs.every((o) => {
      const p = (o as Shape & { k: "object" }).props.get(name);
      return p !== undefined && !p.optional && members(p.shape).every((m) => m.k === "lit");
    });
    if (ok && disjoint(a, name) && disjoint(b, name)) return name;
  }
  return undefined;
}

const litsOf = (o: Shape, name: string): (string | number | boolean)[] => {
  const p = o.k === "object" ? o.props.get(name) : undefined;
  return p ? members(p.shape).flatMap((m) => (m.k === "lit" ? [m.v] : [])) : [];
};

/**
 * Compares what one side produces (`src`) with what the other side's type accepts (`dst`).
 * `response`: the kernel produces, the web accepts (enum values are compared both ways, a web field
 * the kernel lacks is reported); otherwise the web sends a body and the kernel accepts it.
 */
export function compareShapes(
  src: Shape,
  dst: Shape,
  response: boolean,
  /** Fields of web object types some route returns (filled here; see {@link Mismatch.optionalOf}). */
  present: Set<number> = new Set(),
): Mismatch[] {
  const out: Mismatch[] = [];
  const P = response ? "" : "body-";
  const who = response
    ? { src: "the kernel", dst: "the web type" }
    : { src: "the web", dst: "the kernel route" };

  const walk = (s: Shape, d: Shape, path: string, depth: number) => {
    if (depth > 12 || s.k === "any" || d.k === "any") return;
    const sm = members(s);
    const dm = members(d);
    const sCats = new Set(sm.map(categoryOf));
    const dCats = new Set(dm.map(categoryOf));
    for (const cat of sCats) {
      if (cat === undefined || dCats.has(cat)) continue;
      const what =
        cat === "undefined"
          ? response
            ? `the kernel may leave ${fieldName(path)} out, the web type expects it always`
            : `the web may leave ${fieldName(path)} out, the kernel route requires it`
          : `${who.src} ${response ? "can return" : "may send"} ${cat} at ${fieldName(path)}, ${who.dst} has ${dm.map(showShape).join(" | ")}`;
      out.push({
        rule: cat === "undefined" && !response ? "web-api-body-required" : `web-api-${P}type`,
        field: path,
        message: what,
      });
    }
    for (const cat of ["string", "number", "boolean"] as const) {
      const a = scalarSide(sm, cat);
      const b = scalarSide(dm, cat);
      if (!a || !b) continue;
      if (b.free) {
        continue;
      }
      if (a.free) {
        out.push({
          rule: `web-api-${P}type`,
          field: path,
          message: `${who.src} ${response ? "returns" : "sends"} any ${cat} at ${fieldName(path)}, ${who.dst} only allows ${[...b.lits].map((v) => JSON.stringify(v)).join(" | ")}`,
        });
        continue;
      }
      const missing = [...a.lits].filter((v) => !b.lits.has(v));
      if (missing.length > 0) {
        out.push({
          rule: `web-api-${P}enum`,
          field: path,
          message: response
            ? `the kernel can return ${missing.map((v) => JSON.stringify(v)).join(", ")} at ${fieldName(path)}, the web type lacks it`
            : `the web may send ${missing.map((v) => JSON.stringify(v)).join(", ")} at ${fieldName(path)}, the kernel route does not accept it`,
        });
      }
      if (response && cat !== "boolean") {
        const stale = [...b.lits].filter((v) => !a.lits.has(v));
        if (stale.length > 0) {
          out.push({
            rule: "web-api-enum",
            field: path,
            message: `the web type lists ${stale.map((v) => JSON.stringify(v)).join(", ")} at ${fieldName(path)}, which the kernel never returns`,
          });
        }
      }
    }
    const sa = sm.filter((m) => m.k === "array");
    const da = dm.filter((m) => m.k === "array");
    if (sa.length > 0 && da.length > 0) {
      walk(
        union(sa.map((m) => (m as { of: Shape }).of)),
        union(da.map((m) => (m as { of: Shape }).of)),
        `${path}[]`,
        depth + 1,
      );
    }
    const so = sm.filter((m) => m.k === "object");
    const dob = dm.filter((m) => m.k === "object");
    if (so.length === 0 || dob.length === 0) return;
    const disc = discriminant(so, dob);
    if (disc !== undefined) {
      for (const dObj of dob) {
        const vals = litsOf(dObj, disc);
        const matches = so.filter((o) => litsOf(o, disc).some((v) => vals.includes(v)));
        if (matches.length === 0) {
          if (response) {
            out.push({
              rule: "web-api-enum",
              field: join(path, disc),
              message: `the web type has a variant ${disc}: ${vals.map((v) => JSON.stringify(v)).join(" | ")}, which the kernel never returns`,
            });
          } else {
            out.push({
              rule: "web-api-body-enum",
              field: join(path, disc),
              message: `the web may send ${disc}: ${vals.map((v) => JSON.stringify(v)).join(" | ")}, which the kernel route does not accept`,
            });
          }
          continue;
        }
        objects(mergeObjects(matches), dObj as Shape & { k: "object" }, path, depth, disc);
      }
      if (response) {
        const known = new Set(dob.flatMap((o) => litsOf(o, disc)));
        const extra = so.flatMap((o) => litsOf(o, disc)).filter((v) => !known.has(v));
        if (extra.length > 0) {
          out.push({
            rule: "web-api-enum",
            field: join(path, disc),
            message: `the kernel can return ${disc}: ${[...new Set(extra)].map((v) => JSON.stringify(v)).join(", ")}, the web type has no such variant`,
          });
        }
      }
      return;
    }
    objects(mergeObjects(so), mergeObjects(dob), path, depth);
  };

  /** Response: every field the web reads must come from the kernel; body: every field sent must be accepted. */
  const objects = (
    s: Shape & { k: "object" },
    d: Shape & { k: "object" },
    path: string,
    depth: number,
    skip?: string,
  ) => {
    if (response) {
      for (const [name, wp] of d.props) {
        if (name === skip || wp.clientOnly) continue;
        const kp = s.props.get(name);
        const field = join(path, name);
        if (kp === undefined) {
          if (s.index !== undefined) walk(s.index, wp.shape, field, depth + 1);
          else {
            out.push({
              rule: "web-api-field-gone",
              field,
              message: `the web reads \`${field}\`, the kernel no longer returns it`,
              ...(wp.optional && wp.id !== undefined ? { optionalOf: wp.id } : {}),
            });
          }
          continue;
        }
        if (wp.id !== undefined) present.add(wp.id);
        walk(withOptional(kp), withOptional(wp), field, depth + 1);
      }
      if (d.index !== undefined) {
        for (const [name, kp] of s.props) {
          // an absent key is simply absent from a record
          if (!d.props.has(name)) walk(whenPresent(kp), d.index, join(path, name), depth + 1);
        }
        if (s.index) walk(s.index, d.index, join(path, "*"), depth + 1);
      }
      return;
    }
    for (const [name, wp] of s.props) {
      if (name === skip || wp.clientOnly) continue;
      const kp = d.props.get(name);
      const field = join(path, name);
      if (kp === undefined) {
        if (d.index !== undefined) walk(wp.shape, d.index, field, depth + 1);
        else {
          out.push({
            rule: "web-api-body-field",
            field,
            message: `the web sends \`${field}\`, the kernel route does not accept it`,
          });
        }
        continue;
      }
      walk(withOptional(wp), withOptional(kp), field, depth + 1);
    }
    for (const [name, kp] of d.props) {
      if (
        name === skip ||
        kp.optional ||
        members(kp.shape).some((m) => m.k === "undefined" || m.k === "any")
      )
        continue;
      if (!s.props.has(name) && s.index === undefined) {
        const field = join(path, name);
        out.push({
          rule: "web-api-body-required",
          field,
          message: `the kernel route requires \`${field}\`, the web type does not send it`,
        });
      }
    }
  };

  walk(src, dst, "", 0);
  return out;
}

/** A property's shape when it is there (an optional property's `undefined` dropped). */
const whenPresent = (p: Prop): Shape =>
  p.optional ? union(members(p.shape).filter((m) => m.k !== "undefined")) : p.shape;

const withOptional = (p: Prop): Shape =>
  p.optional ? union([p.shape, { k: "undefined" }]) : p.shape;

// ---------------------------------------------------------------------------------------------
// Kernel routes

export interface KernelRoute {
  method: string;
  path: string;
  key: string;
  file: string;
  line: number;
  /** Undefined when the method writes the reply itself (`@Res()`). */
  response?: Shape;
  body?: Shape;
}

const HTTP = new Set(["Get", "Post", "Put", "Patch", "Delete"]);

function decorators(node: Node): Node[] {
  const mods = (node as Ast<{ modifiers?: NodeArray<Node> }>).modifiers;
  return mods ? [...mods].filter((m) => m.kind === SyntaxKind.Decorator) : [];
}

/** `@Name(args)` or `@Name`: the name and the arguments. */
function decoratorCall(d: Node): { name: string; args: Node[] } | undefined {
  const e = (d as Ast<{ expression: Node }>).expression;
  if (e.kind === SyntaxKind.CallExpression) {
    const callee = (e as Ast<{ expression: Node }>).expression;
    if (callee.kind !== SyntaxKind.Identifier) return undefined;
    return {
      name: (callee as Ast<{ text: string }>).text,
      args: [...(e as Ast<{ arguments: NodeArray<Node> }>).arguments],
    };
  }
  if (e.kind === SyntaxKind.Identifier)
    return { name: (e as Ast<{ text: string }>).text, args: [] };
  return undefined;
}

/** `@Res({ passthrough: true })`: the method still returns the response body. */
function passthrough(arg: Node | undefined): boolean {
  if (arg?.kind !== SyntaxKind.ObjectLiteralExpression) return false;
  return [...(arg as Ast<{ properties: NodeArray<Node> }>).properties].some((p) => {
    if (p.kind !== SyntaxKind.PropertyAssignment) return false;
    const name = (p as Ast<{ name: Node }>).name;
    const value = (p as Ast<{ initializer: Node }>).initializer;
    return (
      name.kind === SyntaxKind.Identifier &&
      (name as Ast<{ text: string }>).text === "passthrough" &&
      value.kind === SyntaxKind.TrueKeyword
    );
  });
}

function stringLiteral(n: Node | undefined): string | undefined {
  if (n === undefined) return undefined;
  if (n.kind === SyntaxKind.StringLiteral || n.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return (n as Ast<{ text: string }>).text;
  }
  return undefined;
}

const joinPath = (...parts: string[]) =>
  `/${parts
    .flatMap((p) => p.split("/"))
    .filter((p) => p !== "")
    .join("/")}`;

function lineOf(sf: SourceFile, node: Node): number {
  return sf.getLineAndCharacterOfPosition(node.pos).line + 1;
}

function propertyType(c: Checker, t: Type | undefined, name: string): Type | undefined {
  if (t === undefined) return undefined;
  const p = c.getPropertyOfType(t, name);
  return p === undefined ? undefined : c.getTypeOfSymbol(p);
}

function unwrapPromise(c: Checker, t: Type | undefined): Type | undefined {
  if (t === undefined) return undefined;
  if (t.getSymbol?.()?.name === "Promise") return c.getTypeArguments(t as TypeReference)[0];
  return t;
}

function readKernelRoutes(project: Project, shaper: Shaper, srcDir: string): KernelRoute[] {
  const c = project.checker;
  const out: KernelRoute[] = [];
  for (const fileName of project.program.getSourceFileNames()) {
    if (
      !inside(fileName, srcDir) ||
      /\.(test|spec)\.ts$/.test(fileName) ||
      fileName.endsWith(".d.ts")
    )
      continue;
    if (!readFileSync(fileName, "utf8").includes("@Controller")) continue;
    const sf = project.program.getSourceFile(fileName);
    if (sf === undefined) continue;
    const visit = (node: Node): void => {
      if (node.kind === SyntaxKind.ClassDeclaration) {
        const ctrl = decorators(node)
          .map(decoratorCall)
          .find((d) => d?.name === "Controller");
        if (ctrl !== undefined) {
          const prefix = stringLiteral(ctrl.args[0]) ?? "";
          for (const m of (node as Ast<{ members: NodeArray<Node> }>).members) {
            if (m.kind !== SyntaxKind.MethodDeclaration) continue;
            const http = decorators(m)
              .map(decoratorCall)
              .find((d) => d !== undefined && HTTP.has(d.name));
            if (http === undefined) continue;
            const method = http.name.toUpperCase();
            const path = joinPath(prefix, stringLiteral(http.args[0]) ?? "");
            const params = [...(m as Ast<{ parameters: NodeArray<Node> }>).parameters];
            const raw = params.some((p) =>
              decorators(p).some((d) => {
                const call = decoratorCall(d);
                return call?.name === "Res" && !passthrough(call.args[0]);
              }),
            );
            let response: Shape | undefined;
            if (!raw) {
              const sig = c.getSignatureFromDeclaration(m);
              response = sig
                ? shaper.of(unwrapPromise(c, c.getReturnTypeOfSignature(sig)))
                : undefined;
            }
            let body: Shape | undefined;
            for (const p of params) {
              const zb = decorators(p)
                .map(decoratorCall)
                .find((d) => d?.name === "ZBody");
              const dto = zb?.args[0];
              if (dto === undefined) continue;
              const schema = propertyType(c, c.getTypeAtLocation(dto), "schema");
              const input = propertyType(c, propertyType(c, schema, "_zod"), "input");
              body = input ? shaper.of(input) : undefined;
            }
            out.push({
              method,
              path,
              key: `${method} ${path}`,
              file: fileName,
              line: lineOf(sf, m),
              ...(response ? { response } : {}),
              ...(body ? { body } : {}),
            });
          }
        }
      }
      node.forEachChild((n) => {
        visit(n);
        return undefined;
      });
    };
    visit(sf);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Web calls

export interface WebCall {
  file: string;
  line: number;
  /** The resolved paths (one per branch), `*` for a part not known statically; empty when unresolved. */
  paths: string[];
  method?: string;
  response: Shape;
  /** Whether `T` is `void` / `unknown` (nothing read). */
  readsNothing: boolean;
  body?: Shape;
}

const WILDCARD = "*";
const MAX_CANDIDATES = 8;

const product = (a: string[], b: string[]): string[] =>
  a.flatMap((x) => b.map((y) => x + y)).slice(0, MAX_CANDIDATES);

class WebResolver {
  constructor(
    private readonly project: Project,
    private readonly shaper: Shaper,
  ) {}

  private declarationOf(id: Node): Node | undefined {
    const c = this.project.checker;
    let s: TsSymbol | undefined = c.getSymbolAtLocation(id);
    if (s === undefined) return undefined;
    if (s.flags & SymbolFlags.Alias) s = c.getAliasedSymbol(s);
    const d = s.valueDeclaration ?? s.declarations[0];
    return d?.resolve(this.project);
  }

  /**
   * A string expression's possible values (both branches of a conditional; at most
   * {@link MAX_CANDIDATES}), `*` for an unknown part; empty when nothing is known.
   */
  paths(e: Node, subst: Map<string, string[]>, depth = 0): string[] {
    if (depth > 8) return [];
    const or = (n: Node) => {
      const v = this.paths(n, subst, depth + 1);
      return v.length > 0 ? v : [WILDCARD];
    };
    switch (e.kind) {
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        return [(e as Ast<{ text: string }>).text];
      case SyntaxKind.TemplateExpression: {
        const t = e as Ast<{ head: { text: string }; templateSpans: NodeArray<Node> }>;
        let out = [t.head.text];
        for (const span of t.templateSpans) {
          const sp = span as Ast<{ expression: Node; literal: { text: string } }>;
          out = product(out, or(sp.expression)).map((x) => x + sp.literal.text);
        }
        return out;
      }
      case SyntaxKind.ParenthesizedExpression:
      case SyntaxKind.AsExpression:
      case SyntaxKind.NonNullExpression:
        return this.paths((e as Ast<{ expression: Node }>).expression, subst, depth + 1);
      case SyntaxKind.ConditionalExpression: {
        const c = e as Ast<{ whenTrue: Node; whenFalse: Node }>;
        return [
          ...this.paths(c.whenTrue, subst, depth + 1),
          ...this.paths(c.whenFalse, subst, depth + 1),
        ].slice(0, MAX_CANDIDATES);
      }
      case SyntaxKind.BinaryExpression: {
        const b = e as Ast<{ left: Node; right: Node; operatorToken: Node }>;
        if (b.operatorToken.kind !== SyntaxKind.PlusToken) return [];
        return product(or(b.left), or(b.right));
      }
      case SyntaxKind.Identifier: {
        const name = (e as Ast<{ text: string }>).text;
        const sub = subst.get(name);
        if (sub !== undefined) return sub;
        const d = this.declarationOf(e);
        if (d?.kind === SyntaxKind.VariableDeclaration) {
          const init = (d as Ast<{ initializer?: Node }>).initializer;
          return init ? this.paths(init, new Map(), depth + 1) : [];
        }
        return [];
      }
      case SyntaxKind.CallExpression: {
        const call = e as Ast<{ expression: Node; arguments: NodeArray<Node> }>;
        if (call.expression.kind !== SyntaxKind.Identifier) return [];
        const fn = this.functionOf(call.expression);
        if (fn === undefined) return [];
        const inner = new Map<string, string[]>();
        fn.params.forEach((p, i) => {
          const a = call.arguments[i];
          inner.set(p, a ? or(a) : [WILDCARD]);
        });
        return this.paths(fn.result, inner, depth + 1);
      }
      default:
        return [];
    }
  }

  /** A function whose body is one expression (an arrow or `return x;`): its parameter names and result. */
  private functionOf(id: Node): { params: string[]; result: Node } | undefined {
    let d = this.declarationOf(id);
    if (d?.kind === SyntaxKind.VariableDeclaration)
      d = (d as Ast<{ initializer?: Node }>).initializer;
    if (d === undefined) return undefined;
    if (
      d.kind !== SyntaxKind.ArrowFunction &&
      d.kind !== SyntaxKind.FunctionDeclaration &&
      d.kind !== SyntaxKind.FunctionExpression
    ) {
      return undefined;
    }
    const fn = d as Ast<{ parameters: NodeArray<Node>; body?: Node }>;
    const params = [...fn.parameters].map((p) => {
      const n = (p as Ast<{ name: Node }>).name;
      return n.kind === SyntaxKind.Identifier ? (n as Ast<{ text: string }>).text : "";
    });
    let result = fn.body;
    if (result?.kind === SyntaxKind.Block) {
      const stmts = [...(result as Ast<{ statements: NodeArray<Node> }>).statements];
      const ret =
        stmts.length === 1 && stmts[0]?.kind === SyntaxKind.ReturnStatement ? stmts[0] : undefined;
      result = ret ? (ret as Ast<{ expression?: Node }>).expression : undefined;
    }
    while (result?.kind === SyntaxKind.ParenthesizedExpression)
      result = (result as Ast<{ expression: Node }>).expression;
    return result ? { params, result } : undefined;
  }

  /**
   * The method and the type of the JSON body of a `RequestInit` expression. `argOf` maps a
   * parameter name of the helper the expression sits in to its argument (`null`: none given).
   */
  init(
    e: Node | undefined,
    depth = 0,
    argOf: (name: string) => Node | null | undefined = () => undefined,
  ): { method?: string; body?: Type } {
    if (e === undefined) return { method: "GET" };
    if (depth > 6) return {};
    while (e.kind === SyntaxKind.ParenthesizedExpression || e.kind === SyntaxKind.AsExpression) {
      e = (e as Ast<{ expression: Node }>).expression;
    }
    if (e.kind === SyntaxKind.ObjectLiteralExpression) return this.literalInit(e, argOf, depth);
    if (e.kind === SyntaxKind.BinaryExpression) {
      // `...(body !== undefined && { body: JSON.stringify(body) })`
      const b = e as Ast<{ right: Node; operatorToken: Node }>;
      return b.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken
        ? this.init(b.right, depth + 1, argOf)
        : {};
    }
    if (e.kind === SyntaxKind.ConditionalExpression) {
      const t = this.init((e as Ast<{ whenTrue: Node }>).whenTrue, depth + 1, argOf);
      const f = this.init((e as Ast<{ whenFalse: Node }>).whenFalse, depth + 1, argOf);
      if (t.method === undefined || f.method === undefined) return {};
      if (t.method !== f.method && t.method !== "GET" && f.method !== "GET") return {};
      const method = t.method !== "GET" ? t.method : f.method;
      const body = t.body ?? f.body;
      return { method, ...(body ? { body } : {}) };
    }
    if (e.kind === SyntaxKind.Identifier) {
      const a = argOf((e as Ast<{ text: string }>).text);
      if (a !== undefined) return a === null ? { method: "GET" } : this.init(a, depth + 1);
      const d = this.declarationOf(e);
      const init =
        d?.kind === SyntaxKind.VariableDeclaration
          ? (d as Ast<{ initializer?: Node }>).initializer
          : undefined;
      return init ? this.init(init, depth + 1) : {};
    }
    if (e.kind === SyntaxKind.CallExpression) {
      const call = e as Ast<{ expression: Node; arguments: NodeArray<Node> }>;
      if (call.expression.kind !== SyntaxKind.Identifier) return {};
      const fn = this.functionOf(call.expression);
      if (fn === undefined) return {};
      // `post(x)` -> `{ method: "POST", body: JSON.stringify(x) }`: a parameter stands for its argument.
      return this.init(fn.result, depth + 1, (name) => {
        const i = fn.params.indexOf(name);
        if (i < 0) return argOf(name);
        const a = call.arguments[i];
        if (a === undefined) return null;
        // An argument that is itself a parameter of the outer helper.
        if (a.kind === SyntaxKind.Identifier) {
          const outer = argOf((a as Ast<{ text: string }>).text);
          if (outer !== undefined) return outer;
        }
        return a;
      });
    }
    return {};
  }

  /**
   * `{ method, body: JSON.stringify(x), ...rest }`. `argOf` maps a parameter name of the helper the
   * literal comes from to its argument (`null`: the parameter got no argument).
   */
  private literalInit(
    obj: Node,
    argOf: (name: string) => Node | null | undefined,
    depth: number,
  ): { method?: string; body?: Type } {
    const c = this.project.checker;
    const value = (n: Node | undefined): Node | undefined => {
      if (n?.kind === SyntaxKind.Identifier) {
        const a = argOf((n as Ast<{ text: string }>).text);
        if (a !== undefined) return a ?? undefined;
      }
      return n;
    };
    let method: string | undefined = "GET";
    let body: Type | undefined;
    for (const p of (obj as Ast<{ properties: NodeArray<Node> }>).properties) {
      if (p.kind === SyntaxKind.SpreadAssignment) {
        const inner = this.init((p as Ast<{ expression: Node }>).expression, depth + 1, argOf);
        if (inner.method === undefined) return {};
        if (inner.method !== "GET") method = inner.method;
        if (inner.body) body = inner.body;
        continue;
      }
      let name: string | undefined;
      let v: Node | undefined;
      if (p.kind === SyntaxKind.ShorthandPropertyAssignment) {
        const id = (p as Ast<{ name: Node }>).name;
        name = (id as Ast<{ text: string }>).text;
        v = value(id);
      } else if (p.kind === SyntaxKind.PropertyAssignment) {
        const nameNode = (p as Ast<{ name: Node }>).name;
        name =
          nameNode.kind === SyntaxKind.Identifier
            ? (nameNode as Ast<{ text: string }>).text
            : stringLiteral(nameNode);
        v = value((p as Ast<{ initializer: Node }>).initializer);
      } else continue;
      if (name === "method") {
        const ms = v === undefined ? [] : this.paths(v, new Map());
        const m = ms.length === 1 ? ms[0] : undefined;
        if (m === undefined || m.includes(WILDCARD)) return {};
        method = m.toUpperCase();
      }
      if (name === "body" && v?.kind === SyntaxKind.CallExpression) {
        const call = v as Ast<{ expression: Node; arguments: NodeArray<Node> }>;
        const callee = call.expression;
        const isStringify =
          callee.kind === SyntaxKind.PropertyAccessExpression &&
          (callee as Ast<{ name: { text: string } }>).name.text === "stringify";
        const arg = value(call.arguments[0]);
        if (isStringify && arg) body = c.getTypeAtLocation(arg);
      }
    }
    return { ...(method ? { method } : {}), ...(body ? { body } : {}) };
  }

  calls(srcDir: string): WebCall[] {
    const c = this.project.checker;
    const out: WebCall[] = [];
    for (const fileName of this.project.program.getSourceFileNames()) {
      if (
        !inside(fileName, srcDir) ||
        /\.(test|spec)\.tsx?$/.test(fileName) ||
        fileName.endsWith(".d.ts")
      )
        continue;
      if (!readFileSync(fileName, "utf8").includes("apiFetch<")) continue;
      const sf = this.project.program.getSourceFile(fileName);
      if (sf === undefined) continue;
      const visit = (node: Node): void => {
        if (node.kind === SyntaxKind.CallExpression) {
          const call = node as Ast<{
            expression: Node;
            typeArguments?: NodeArray<TypeNode>;
            arguments: NodeArray<Node>;
          }>;
          const t = call.typeArguments?.[0];
          if (
            call.expression.kind === SyntaxKind.Identifier &&
            (call.expression as Ast<{ text: string }>).text === "apiFetch" &&
            t !== undefined
          ) {
            const type = c.getTypeFromTypeNode(t);
            const readsNothing =
              type === undefined ||
              (type.flags & (TypeFlags.Void | TypeFlags.Unknown | TypeFlags.Undefined)) !== 0;
            const first = call.arguments[0];
            const paths = first
              ? this.paths(first, new Map()).map((x) => x.split("?")[0] as string)
              : [];
            const init = this.init(call.arguments[1]);
            out.push({
              file: fileName,
              line: lineOf(sf, node),
              paths,
              ...(init.method ? { method: init.method } : {}),
              response: readsNothing ? ANY : this.shaper.of(type),
              readsNothing,
              ...(init.body ? { body: this.shaper.of(init.body) } : {}),
            });
          }
        }
        node.forEachChild((n) => {
          visit(n);
          return undefined;
        });
      };
      visit(sf);
    }
    return out;
  }
}

const inside = (file: string, dir: string) =>
  file.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

// ---------------------------------------------------------------------------------------------
// Matching

function segmentMatches(webSeg: string, kernelSeg: string): boolean {
  if (kernelSeg.startsWith(":")) return webSeg !== "";
  if (!webSeg.includes(WILDCARD)) return webSeg === kernelSeg;
  const re = new RegExp(
    `^${webSeg
      .split(WILDCARD)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(kernelSeg);
}

/** The kernel route a web call reaches, by method and path segments (the surest match wins). */
export function matchRoute(
  routes: readonly KernelRoute[],
  method: string,
  path: string,
): KernelRoute | undefined {
  const ws = path.split("/").filter((s) => s !== "");
  let best: KernelRoute | undefined;
  let bestScore = -1;
  for (const r of routes) {
    if (r.method !== method) continue;
    const ks = r.path.split("/").filter((s) => s !== "");
    // A trailing unknown part (a query string built at runtime) may glue onto the last segment.
    const tryMatch = (segs: string[]) =>
      segs.length === ks.length && segs.every((s, i) => segmentMatches(s, ks[i] as string));
    const trimmed = ws.map((s, i) =>
      i === ws.length - 1 && s.length > 1 && s.endsWith(WILDCARD) ? s.slice(0, -1) : s,
    );
    // Equal literals and an unknown part for a param are sure; a literal for a param, or a partly
    // known segment, less so; an unknown part for a literal least (`/conversations/${id}` is
    // `:id`, not `groups`; `/conversations/groups${query}` is `groups`).
    const scoreOf = (segs: string[]) =>
      segs.reduce((n, w, i) => {
        const k = ks[i] as string;
        const kind = w === WILDCARD ? "unknown" : w.includes(WILDCARD) ? "partial" : "literal";
        if (k.startsWith(":")) return n + (kind === "unknown" ? 4 : 2);
        return n + (kind === "literal" ? 4 : kind === "partial" ? 3 : 0);
      }, 0);
    const scores = [ws, trimmed].filter(tryMatch).map(scoreOf);
    if (scores.length === 0) continue;
    const score = Math.max(...scores);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// The check

export interface AllowEntry {
  /** `<METHOD> <path>` of the kernel route. */
  route: string;
  field: string;
  rule: string;
  reason: string;
}

/**
 * Accepted differences, each with its reason. Prefer fixing the type on the side that drifted; an
 * entry here is for a difference that is intended (an entry matching no finding fails).
 */
export const WEB_API_PARITY_ALLOW: readonly AllowEntry[] = [
  {
    route: "POST /api/v1/admin/ui/actions/:plugin/:id",
    field: "conversationId",
    rule: "web-api-body-field",
    reason:
      "`postUiAction` serves both scopes: the context ids are set only inside an org (a platform page has no conversation or agent), and the platform route drops unknown keys",
  },
  {
    route: "POST /api/v1/admin/ui/actions/:plugin/:id",
    field: "agentId",
    rule: "web-api-body-field",
    reason:
      "`postUiAction` serves both scopes: the context ids are set only inside an org (a platform page has no conversation or agent), and the platform route drops unknown keys",
  },
];

export interface ParityOptions {
  /** The kernel's tsconfig and the source directory its controllers live in. */
  kernel: { tsconfig: string; src: string };
  /** The web app's tsconfig and the source directory its `apiFetch` calls live in. */
  web: { tsconfig: string; src: string };
  allow?: readonly AllowEntry[];
}

export interface ParityResult {
  findings: Finding[];
  /** Web calls compared with a kernel route. */
  compared: { route: string; file: string; line: number }[];
  /** Web calls not compared, with the reason. */
  uncovered: { file: string; line: number; reason: string }[];
  routes: KernelRoute[];
}

export function checkWebApiParity(opts: ParityOptions): ParityResult {
  const api = new API({ cwd: opts.web.src });
  try {
    const snap = api.updateSnapshot({ openProjects: [opts.kernel.tsconfig, opts.web.tsconfig] });
    const kernel = snap.getProject(opts.kernel.tsconfig);
    const web = snap.getProject(opts.web.tsconfig);
    if (kernel === undefined || web === undefined) {
      throw new Error(
        `web-api-parity: could not open ${opts.kernel.tsconfig} or ${opts.web.tsconfig}`,
      );
    }
    const routes = readKernelRoutes(kernel, new Shaper(kernel.checker), opts.kernel.src);
    const calls = new WebResolver(web, new Shaper(web.checker, true)).calls(opts.web.src);
    return compareAll(routes, calls, opts.allow ?? WEB_API_PARITY_ALLOW);
  } finally {
    api.close();
  }
}

function compareAll(
  routes: KernelRoute[],
  calls: WebCall[],
  allow: readonly AllowEntry[],
): ParityResult {
  const findings: Finding[] = [];
  const compared: ParityResult["compared"] = [];
  const uncovered: ParityResult["uncovered"] = [];
  const seen = new Set<string>();
  const used = new Set<AllowEntry>();
  const present = new Set<number>();
  const pending: { m: Mismatch; route: KernelRoute; call: WebCall }[] = [];
  for (const call of calls) {
    const paths = call.paths.filter((x) => x.startsWith("/api/"));
    if (paths.length === 0) {
      uncovered.push({ file: call.file, line: call.line, reason: "path not resolved statically" });
      continue;
    }
    if (call.method === undefined) {
      uncovered.push({
        file: call.file,
        line: call.line,
        reason: `${paths.join(" | ")}: method not resolved statically`,
      });
      continue;
    }
    const matched: KernelRoute[] = [];
    for (const path of paths) {
      const route = matchRoute(routes, call.method, path);
      if (route === undefined) {
        findings.push({
          file: call.file,
          line: call.line,
          rule: "web-api-route-gone",
          message: `${call.method} ${path}: no kernel route matches this call`,
        });
      } else if (!matched.includes(route)) matched.push(route);
    }
    for (const route of matched) {
      compared.push({ route: route.key, file: call.file, line: call.line });
      const ms: Mismatch[] = [];
      if (!call.readsNothing) {
        if (route.response === undefined) {
          uncovered.push({
            file: call.file,
            line: call.line,
            reason: `${route.key}: the route writes its reply itself (@Res)`,
          });
        } else if (route.response.k === "any") {
          uncovered.push({
            file: call.file,
            line: call.line,
            reason: `${route.key}: the route's return type is \`any\` / \`unknown\``,
          });
        } else {
          ms.push(...compareShapes(route.response, call.response, true, present));
        }
      }
      if (call.body !== undefined && route.body !== undefined)
        ms.push(...compareShapes(call.body, route.body, false));
      for (const m of ms) pending.push({ m, route, call });
    }
  }
  for (const { m, route, call } of pending) {
    // An optional field of a web type shared by several routes: fine while one of them returns it.
    if (m.optionalOf !== undefined && present.has(m.optionalOf)) continue;
    const key = `${route.key}|${m.rule}|${m.field}|${m.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = allow.find((e) => e.route === route.key && e.field === m.field && e.rule === m.rule);
    if (a) {
      used.add(a);
      continue;
    }
    findings.push({
      file: call.file,
      line: call.line,
      rule: m.rule,
      message: `${route.key} ${m.field === "" ? "(root)" : m.field}: ${m.message} (kernel: ${routeLocation(route)})`,
    });
  }
  for (const a of allow) {
    if (used.has(a)) continue;
    findings.push({
      file: fileURLToPath(import.meta.url),
      line: 1,
      rule: "web-api-allow-stale",
      message: `allow entry ${a.route} ${a.field} (${a.rule}) matches no finding: remove it`,
    });
  }
  return { findings, compared, uncovered, routes };
}

const routeLocation = (r: KernelRoute) => `${relative(process.cwd(), r.file)}:${r.line}`;

/** The check on the repository: the kernel's controllers against the web app's `apiFetch` calls. */
export function checkWebApiParityRepo(root: string): Finding[] {
  return checkWebApiParity({
    kernel: {
      tsconfig: join_(root, "packages/kernel/tsconfig.json"),
      src: join_(root, "packages/kernel/src"),
    },
    web: { tsconfig: join_(root, "apps/web/tsconfig.json"), src: join_(root, "apps/web/src") },
  }).findings;
}
