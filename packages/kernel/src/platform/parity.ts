import { z } from "zod";
import type { PlatformOperation } from "./operation.js";
import type { RouteSchemas } from "./route-schemas.js";

/** One difference between an operation's input and its mirrored route (spec §14.5 item 3). */
export interface ParityFinding {
  op: string;
  route: string;
  /** The operation field (or declaration entry) it is about; absent when about the whole route. */
  field?: string;
  message: string;
}

/** What {@link inputParity} reads of an operation. */
export type ParityOperation = Pick<PlatformOperation, "id" | "input" | "mirrors"> &
  Partial<Pick<PlatformOperation, "omits" | "extras" | "renames" | "loosens">>;

type Json = Record<string, unknown>;

interface Field {
  schema: Json;
  required: boolean;
}

/** `:orgId` is the conversation's org: never an operation field, so never compared. */
const IMPLICIT = new Set(["orgId"]);
/** Bounds an operation may tighten but never loosen: the upper ones, then the lower ones. */
const UPPER = ["maxLength", "maximum", "exclusiveMaximum", "maxItems", "maxProperties"] as const;
const LOWER = ["minLength", "minimum", "exclusiveMinimum", "minItems", "minProperties"] as const;

const toJson = (s: z.ZodType): Json =>
  z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Json;

/** A schema's alternatives: the branches of `anyOf` / `oneOf` (flattened), else itself. */
function alternatives(s: Json): Json[] {
  const branches = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  return branches ? branches.flatMap(alternatives) : [s];
}

const propsOf = (s: Json): Record<string, Json> | undefined =>
  s.properties as Record<string, Json> | undefined;
const requiredOf = (s: Json): Set<string> => new Set((s.required ?? []) as string[]);

/**
 * The top-level fields of an object schema; of a union, each branch's fields (a field that
 * differs between branches is the `anyOf` of its branch schemas, required only when every
 * branch requires it).
 */
function fieldsOf(s: Json): Map<string, Field> {
  const branches = alternatives(s);
  const out = new Map<string, { schemas: Json[]; requiredIn: number }>();
  for (const branch of branches) {
    const req = requiredOf(branch);
    for (const [k, v] of Object.entries(propsOf(branch) ?? {})) {
      const f = out.get(k) ?? { schemas: [], requiredIn: 0 };
      f.schemas.push(v);
      if (req.has(k)) f.requiredIn += 1;
      out.set(k, f);
    }
  }
  return new Map(
    [...out].map(([k, f]) => {
      const distinct = [...new Map(f.schemas.map((v) => [JSON.stringify(v), v])).values()];
      const schema = distinct.length === 1 ? (distinct[0] as Json) : { anyOf: distinct };
      return [k, { schema, required: f.requiredIn === branches.length }];
    }),
  );
}

/** The route field at a dotted path (`definition.name`): required only when every step is. */
function fieldAt(fields: Map<string, Field>, path: string): Field | undefined {
  const [head, ...rest] = path.split(".");
  let f = fields.get(head as string);
  for (const seg of rest) {
    if (f === undefined) return undefined;
    const holder = alternatives(f.schema).find((a) => propsOf(a)?.[seg] !== undefined);
    const next = holder && propsOf(holder)?.[seg];
    if (!holder || !next) return undefined;
    f = { schema: next, required: f.required && requiredOf(holder).has(seg) };
  }
  return f;
}

const jsonType = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

/** The JSON types a schema accepts; `undefined` when it accepts anything. */
function typesOf(s: Json): Set<string> | undefined {
  if (s.type !== undefined) return new Set(Array.isArray(s.type) ? s.type : [s.type as string]);
  if ("const" in s) return new Set([jsonType(s.const)]);
  if (Array.isArray(s.enum)) return new Set(s.enum.map(jsonType));
  return undefined;
}

/** `integer` is a `number`; every other type only itself. */
const typeFits = (t: string, allowed: Set<string>): boolean =>
  allowed.has(t) || (t === "integer" && allowed.has("number"));

const describeTypes = (t: Set<string> | undefined): string =>
  t === undefined ? "any" : [...t].sort().join(" | ");

const valuesOf = (s: Json): unknown[] | undefined =>
  "const" in s ? [s.const] : Array.isArray(s.enum) ? s.enum : undefined;

/**
 * Why one operation alternative accepts more than one route alternative, or null when it accepts
 * no more (spec §14.5 item 3). Objects, arrays and records are compared recursively: every
 * operation property is a route property, every property the route requires the operation
 * requires, a closed route object is closed in the operation, items and values fit.
 */
function misfit(op: Json, route: Json, path: string, top: string): string | null {
  /** The reason, prefixed by the path inside the compared field (none at the field itself). */
  const at = (p: string, why: string): string => (p === top ? why : `${p}: ${why}`);
  const want = typesOf(route);
  const got = typesOf(op);
  if (want !== undefined && (got === undefined || [...got].some((t) => !typeFits(t, want)))) {
    return at(
      path,
      `type ${describeTypes(got)} in the operation, ${describeTypes(want)} in the route`,
    );
  }
  const allowed = valuesOf(route);
  if (allowed !== undefined) {
    const vs = valuesOf(op);
    const keys = new Set(allowed.map((v) => JSON.stringify(v)));
    if (vs === undefined || vs.some((v) => !keys.has(JSON.stringify(v)))) {
      return at(
        path,
        `values ${vs === undefined ? "any" : JSON.stringify(vs)} are looser than the route's ${JSON.stringify(allowed)}`,
      );
    }
  }
  for (const k of UPPER) {
    const r = route[k] as number | undefined;
    const o = op[k] as number | undefined;
    if (r !== undefined && (o === undefined || o > r)) {
      return at(path, `${k} ${o ?? "unbounded"} is looser than the route's ${r}`);
    }
  }
  for (const k of LOWER) {
    const r = route[k] as number | undefined;
    const o = op[k] as number | undefined;
    if (r !== undefined && (o === undefined || o < r)) {
      return at(path, `${k} ${o ?? "unbounded"} is looser than the route's ${r}`);
    }
  }
  for (const k of ["pattern", "format"] as const) {
    if (route[k] !== undefined && op[k] !== route[k]) {
      return at(
        path,
        `${k} ${op[k] === undefined ? "none" : JSON.stringify(op[k])} differs from the route's ${JSON.stringify(route[k])}`,
      );
    }
  }
  const sub = (k: string) => `${path}.${k}`;
  const rp = propsOf(route);
  if (rp !== undefined) {
    const opProps = propsOf(op) ?? {};
    const opReq = requiredOf(op);
    for (const k of requiredOf(route)) {
      if (!opReq.has(k)) return at(sub(k), "required by the route, optional or missing here");
    }
    for (const [k, v] of Object.entries(opProps)) {
      const r = rp[k];
      if (r === undefined) return at(sub(k), "no field of the route");
      const why = fieldMismatch(v, r, sub(k), top);
      if (why !== null) return why;
    }
  }
  if (route.additionalProperties === false && op.additionalProperties !== false) {
    return at(path, "accepts unknown keys, the route does not");
  }
  // a record's values: an operation closed to unknown keys accepts none, else its values must fit
  if (typeof route.additionalProperties === "object" && op.additionalProperties !== false) {
    const why = fieldMismatch(
      (op.additionalProperties ?? {}) as Json,
      route.additionalProperties as Json,
      sub("*"),
      top,
    );
    if (why !== null) return why;
  }
  if (typeof route.propertyNames === "object") {
    const why = fieldMismatch(
      (op.propertyNames ?? {}) as Json,
      route.propertyNames as Json,
      sub("<key>"),
      top,
    );
    if (why !== null) return why;
  }
  if (typeof route.items === "object" && route.items !== null) {
    const why = fieldMismatch((op.items ?? {}) as Json, route.items as Json, sub("[]"), top);
    if (why !== null) return why;
  }
  return null;
}

/** Why the operation's schema accepts more than the route's, or null: each op alternative fits one. */
function fieldMismatch(op: Json, route: Json, path: string, top: string): string | null {
  const routeAlts = alternatives(route);
  for (const a of alternatives(op)) {
    const reasons = routeAlts.map((b) => misfit(a, b, path, top));
    if (!reasons.includes(null)) return reasons[0] as string;
  }
  return null;
}

/**
 * Compares an operation's input with one mirrored route's body + query + path params (spec
 * §14.5 item 3), on their input JSON Schemas:
 * - each input field is compared with the route field of the same name, or the route path its
 *   `renames` entry names (`skillId` → `id`, `name` → `definition.name`): the same type (an
 *   operation `integer` fits a route `number`), enum values a subset, bounds no looser
 *   (`maxLength` / `maximum` / `maxItems` at most the route's, the lower bounds at least), the
 *   same `pattern` and `format`, and required where the route requires it; nested objects,
 *   arrays and records recursively (a nested optional route field the operation leaves out is
 *   allowed, a required one is not);
 * - a `loosens` entry names an input field allowed to accept more than the route (with the
 *   reason); it is still compared by type, and an entry that loosens nothing is stale;
 * - a top-level route field the input neither has nor renames into is listed in `omits`, an input
 *   field with no route counterpart in `extras`; stale entries of either are findings.
 */
export function inputParity(op: ParityOperation, route: RouteSchemas): ParityFinding[] {
  const out: ParityFinding[] = [];
  const add = (field: string, message: string) =>
    out.push({ op: op.id, route: route.route, field, message: `${op.id}: ${message}` });
  const opFields = fieldsOf(toJson(op.input));
  const routeFields = new Map<string, Field>();
  for (const part of [route.params, route.query, route.body]) {
    if (part === undefined) continue;
    for (const [k, v] of fieldsOf(toJson(part))) if (!IMPLICIT.has(k)) routeFields.set(k, v);
  }
  const omits = new Set(op.omits ?? []);
  const extras = new Set(op.extras ?? []);
  const renames = new Map(Object.entries(op.renames ?? {}));
  const loosens = new Map(Object.entries(op.loosens ?? {}));
  const r = `\`${route.route}\``;
  /** Top-level route fields an input field covers (by name or by a rename into it). */
  const covered = new Set<string>();

  for (const [k, opField] of opFields) {
    const target = renames.get(k) ?? k;
    const routeField = fieldAt(routeFields, target);
    if (routeField === undefined) {
      if (renames.has(k)) add(k, `\`renames\` maps \`${k}\` to \`${target}\`, no field of ${r}`);
      else if (!extras.has(k)) add(k, `\`${k}\` is no field of ${r} and not in \`extras\``);
      continue;
    }
    covered.add(target.split(".")[0] as string);
    if (extras.has(k)) add(k, `\`extras\` names \`${k}\`, which ${r} has as \`${target}\``);
    const reason = loosens.get(k);
    const name = target === k ? `\`${k}\`` : `\`${k}\` (\`${target}\`)`;
    if (reason !== undefined) {
      if (reason.trim() === "") add(k, `\`loosens\` names \`${k}\` without a reason`);
      const want = typesOf(routeField.schema);
      const got = typesOf(opField.schema);
      if (want !== undefined && (got === undefined || [...got].some((t) => !typeFits(t, want)))) {
        add(
          k,
          `${name}: type ${describeTypes(got)} in the operation, ${describeTypes(want)} in the route (${r}; \`loosens\` excuses bounds, never the type)`,
        );
      }
      const looser =
        (routeField.required && !opField.required) ||
        fieldMismatch(opField.schema, routeField.schema, target, target) !== null;
      if (!looser) add(k, `\`loosens\` names ${name}, which is no looser than ${r}`);
      continue;
    }
    if (routeField.required && !opField.required) {
      add(k, `${name} is required by ${r} but optional here (declare it in \`loosens\` if meant)`);
    }
    const why = fieldMismatch(opField.schema, routeField.schema, target, target);
    if (why !== null) add(k, `${name}: ${why} (${r})`);
  }
  for (const k of routeFields.keys()) {
    if (!covered.has(k) && !omits.has(k)) {
      add(k, `\`${k}\` of ${r} is missing from the input and not in \`omits\``);
    }
  }
  for (const k of omits) {
    if (!routeFields.has(k)) add(k, `\`omits\` names \`${k}\`, no field of ${r}`);
    else if (covered.has(k)) add(k, `\`omits\` names \`${k}\`, but the input has it`);
  }
  for (const k of extras) {
    if (!opFields.has(k)) add(k, `\`extras\` names \`${k}\`, which the input lacks`);
  }
  for (const k of renames.keys()) {
    if (!opFields.has(k)) add(k, `\`renames\` names \`${k}\`, which the input lacks`);
  }
  for (const k of loosens.keys()) {
    if (!opFields.has(k)) add(k, `\`loosens\` names \`${k}\`, which the input lacks`);
  }
  return out;
}

/**
 * {@link inputParity} of every operation against each route it mirrors; a mirrored route whose
 * schemas are not registered is a finding too (a removed route is `check:platform-ops`'s orphan).
 */
export function checkInputParity(
  ops: readonly ParityOperation[],
  routes: readonly RouteSchemas[],
): ParityFinding[] {
  const byRoute = new Map(routes.map((r) => [r.route, r]));
  return ops.flatMap((op) =>
    op.mirrors.flatMap((m) => {
      const r = byRoute.get(m);
      return r !== undefined
        ? inputParity(op, r)
        : [
            {
              op: op.id,
              route: m,
              message: `${op.id} mirrors \`${m}\`, whose schemas are not in ROUTE_SCHEMAS: export them from the controller's <domain>.schemas.ts and list them there`,
            },
          ];
    }),
  );
}
