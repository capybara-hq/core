import { z } from "zod";
import type { PlatformOperation } from "./operation.js";
import type { RouteSchemas } from "./route-schemas.js";

/** One difference between an operation's input and its mirrored route (spec §14.5 item 3). */
export interface ParityFinding {
  op: string;
  route: string;
  /** The field it is about; absent when it is about the whole route. */
  field?: string;
  message: string;
}

/** What {@link inputParity} reads of an operation. */
export type ParityOperation = Pick<PlatformOperation, "id" | "input" | "mirrors"> &
  Partial<Pick<PlatformOperation, "omits" | "extras">>;

type Json = Record<string, unknown>;

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

/**
 * The top-level fields of an object schema; of a union, each branch's fields, a field that
 * differs between branches being the `anyOf` of its branch schemas.
 */
function fieldsOf(s: Json): Map<string, Json> {
  const out = new Map<string, Json[]>();
  for (const branch of alternatives(s)) {
    const props = (branch.properties ?? {}) as Record<string, Json>;
    for (const [k, v] of Object.entries(props)) out.set(k, [...(out.get(k) ?? []), v]);
  }
  return new Map(
    [...out].map(([k, vs]) => {
      const distinct = [...new Map(vs.map((v) => [JSON.stringify(v), v])).values()];
      return [k, distinct.length === 1 ? (distinct[0] as Json) : { anyOf: distinct }];
    }),
  );
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

/** Why one operation alternative does not fit one route alternative, or null when it fits. */
function misfit(op: Json, route: Json): string | null {
  const want = typesOf(route);
  const got = typesOf(op);
  if (want !== undefined && (got === undefined || [...got].some((t) => !typeFits(t, want)))) {
    return `type ${describeTypes(got)} in the operation, ${describeTypes(want)} in the route`;
  }
  const allowed = valuesOf(route);
  if (allowed !== undefined) {
    const vs = valuesOf(op);
    const keys = new Set(allowed.map((v) => JSON.stringify(v)));
    if (vs === undefined || vs.some((v) => !keys.has(JSON.stringify(v)))) {
      return `values ${vs === undefined ? "any" : JSON.stringify(vs)} are looser than the route's ${JSON.stringify(allowed)}`;
    }
  }
  for (const k of UPPER) {
    const r = route[k] as number | undefined;
    const o = op[k] as number | undefined;
    if (r !== undefined && (o === undefined || o > r)) {
      return `${k} ${o ?? "unbounded"} is looser than the route's ${r}`;
    }
  }
  for (const k of LOWER) {
    const r = route[k] as number | undefined;
    const o = op[k] as number | undefined;
    if (r !== undefined && (o === undefined || o < r)) {
      return `${k} ${o ?? "unbounded"} is looser than the route's ${r}`;
    }
  }
  return null;
}

/** Why the operation's field schema accepts more than the route's, or null (spec §14.5 item 3). */
function fieldMismatch(op: Json, route: Json): string | null {
  const routeAlts = alternatives(route);
  for (const a of alternatives(op)) {
    const reasons = routeAlts.map((b) => misfit(a, b));
    if (!reasons.includes(null)) return reasons[0] as string;
  }
  return null;
}

/**
 * Compares an operation's input with one mirrored route's body + query + path params (spec
 * §14.5 item 3), on their input JSON Schemas' top-level fields:
 * - a field in both has the same type (an operation `integer` fits a route `number`), its enum
 *   values a subset of the route's, and its bounds no looser (`maxLength` / `maximum` / `maxItems`
 *   at most the route's, the lower bounds at least);
 * - a route field the input leaves out is listed in `omits`, an input field the route lacks in
 *   `extras`; an entry of either naming nothing to declare is stale.
 * Required-ness is not compared: an operation may make a route field optional when its handler
 * fills it (`agents.create`'s `visibility`). Nested objects are compared by type only.
 */
export function inputParity(op: ParityOperation, route: RouteSchemas): ParityFinding[] {
  const out: ParityFinding[] = [];
  const add = (field: string, message: string) =>
    out.push({ op: op.id, route: route.route, field, message: `${op.id}: ${message}` });
  const opFields = fieldsOf(toJson(op.input));
  const routeFields = new Map<string, Json>();
  for (const part of [route.params, route.query, route.body]) {
    if (part === undefined) continue;
    for (const [k, v] of fieldsOf(toJson(part))) if (!IMPLICIT.has(k)) routeFields.set(k, v);
  }
  const omits = new Set(op.omits ?? []);
  const extras = new Set(op.extras ?? []);

  for (const [k, routeField] of routeFields) {
    const opField = opFields.get(k);
    if (opField === undefined) {
      if (!omits.has(k)) {
        add(k, `\`${k}\` of \`${route.route}\` is missing from the input and not in \`omits\``);
      }
      continue;
    }
    if (omits.has(k)) add(k, `\`omits\` names \`${k}\`, but the input has it`);
    const why = fieldMismatch(opField, routeField);
    if (why !== null) add(k, `\`${k}\`: ${why} (\`${route.route}\`)`);
  }
  for (const k of opFields.keys()) {
    if (!routeFields.has(k) && !extras.has(k)) {
      add(k, `\`${k}\` is no field of \`${route.route}\` and not in \`extras\``);
    }
  }
  for (const k of omits) {
    if (!routeFields.has(k)) add(k, `\`omits\` names \`${k}\`, no field of \`${route.route}\``);
  }
  for (const k of extras) {
    if (routeFields.has(k)) add(k, `\`extras\` names \`${k}\`, a field of \`${route.route}\``);
    else if (!opFields.has(k)) add(k, `\`extras\` names \`${k}\`, which the input lacks`);
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
