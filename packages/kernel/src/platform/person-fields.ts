import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";
import { hintedSecretPaths } from "../extensions/config-json-schema.js";

/**
 * Person fields (platform web parity spec §4.1, §4.2): the secret fields of a write's target config
 * schema that the person types on the approval card instead of the model passing them in params.
 * Pure rules shared by the Platform operations: find the secret fields of a JSON Schema produced by
 * the SDK's `configJsonSchema` (`"x-secret": true`), plan which ones one call asks for, and check
 * one typed value. Paths are the dot paths the config routes use in `values` (ruling R1); secret
 * records (`x-ui.secrets`, `secret(z.record(...))`) and secrets inside array items cannot be
 * addressed that way and are reported as `recordOnly` (entered on the web page).
 */

/** UTF-8 bytes of one value the person types. */
export const PERSON_FIELD_MAX_BYTES = 16 * 1024;
/** Person fields one call may ask for (one approval card). */
export const PERSON_FIELDS_MAX = 32;
/** Characters of one dot path in `askPerson` / `clearSecrets`. */
const PATH_MAX_CHARS = 200;

/** One secret field the person may enter on the approval card. */
export interface PersonFieldSpec {
  /** Dot path from the schema root (R1). */
  path: string;
  /** From the node's `title` / `x-ui.label`, else the path. */
  label: string;
  /** From the node's `description` / `x-ui.help`. */
  description?: string;
  /**
   * The node's `x-ui` widget is a textarea (or JSON) editor. `checkConfigUi` forbids widgets on
   * secret nodes of extension schemas, so their rows are single-line (JSON pastes fine into a
   * masked single-line input).
   */
  multiline: boolean;
  /** Listed in its parent's `required` along the whole path. */
  required: boolean;
  /** A stored value exists. */
  isSet: boolean;
  /** The JSON Schema node, scrubbed of value keywords (default / examples / const / enum). */
  schema: Record<string, unknown>;
}

/** What one operation writes: its name for the card and the person fields of its schema. */
export interface PersonFieldTarget {
  target: { zh: string; en: string };
  fields: PersonFieldSpec[];
  /** Secret paths the card cannot ask for (records, array items): entered on the web page. */
  recordOnly?: string[];
}

/** Path segments that would reach the prototype chain: never a field name. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

const pathList = (what: string) =>
  z
    .array(
      z
        .string()
        .min(1)
        .max(PATH_MAX_CHARS)
        .refine((p) => p.split(".").every((seg) => !FORBIDDEN_SEGMENTS.has(seg)), {
          message: "Not a field path: __proto__, prototype and constructor are not field names",
        }),
    )
    .max(PERSON_FIELDS_MAX)
    .default([])
    .describe(what);

/** The params every operation with person fields adds to its input schema. */
export const personFieldParams: {
  askPerson: z.ZodType<string[]>;
  clearSecrets: z.ZodType<string[]>;
} = {
  askPerson: pathList(
    "Dot paths of secret fields the person enters on the confirmation card. Never put a secret in values; required secrets without a stored value are asked even when not listed.",
  ),
  clearSecrets: pathList("Dot paths of stored secret fields to clear."),
};

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keywords that carry values, never kept in a person field's schema. */
const VALUE_KEYWORDS = new Set(["default", "examples", "const", "enum"]);
/** Hints that carry values, never kept in a person field's schema. */
const VALUE_HINTS = ["options", "presets"];
/** Keywords whose value maps names to sub-schemas: their keys are field names. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
/** Widgets drawn as a multi-line input. */
const MULTILINE_WIDGETS = new Set(["textarea", "json"]);

/** The non-null shape of a node: itself, or the one non-null branch of a nullable `anyOf` / `oneOf`. */
function shapeOf(node: Obj): Obj {
  const branches = node.anyOf ?? node.oneOf;
  if (node.type === undefined && Array.isArray(branches)) {
    const rest = branches.filter((b) => isObj(b) && b.type !== "null") as Obj[];
    if (rest.length === 1 && rest[0] !== undefined) return rest[0];
  }
  return node;
}

/** The node `$ref` points to inside `root` (`#/$defs/…` or `#/definitions/…`), if any. */
function resolveRef(root: Obj, ref: unknown): Obj | undefined {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(node) || !Object.hasOwn(node, seg)) return undefined;
    node = node[seg];
  }
  return isObj(node) ? node : undefined;
}

/** Whether a subtree holds `"x-secret": true` anywhere, following `$ref`s into `root`. */
function containsSecret(node: unknown, root: Obj, seen = new Set<unknown>()): boolean {
  if (seen.has(node)) return false;
  if (Array.isArray(node)) {
    seen.add(node);
    return node.some((n) => containsSecret(n, root, seen));
  }
  if (!isObj(node)) return false;
  seen.add(node);
  if (node["x-secret"] === true) return true;
  if (node.$ref !== undefined) {
    const target = resolveRef(root, node.$ref);
    // An unresolvable reference may hide a secret: fail closed.
    if (target === undefined || containsSecret(target, root, seen)) return true;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "x-ui" || VALUE_KEYWORDS.has(k)) continue;
    if (containsSecret(v, root, seen)) return true;
  }
  return false;
}

/** A shallow copy of a node without some keywords. */
function without(node: Obj, keys: readonly string[]): Obj {
  const out: Obj = { ...node };
  for (const k of keys) delete out[k];
  return out;
}

/** Whether the node only accepts strings (or strings and null). */
function isStringNode(shape: Obj): boolean {
  const t = shape.type;
  if (t === "string") return true;
  return Array.isArray(t) && t.includes("string") && t.every((x) => x === "string" || x === "null");
}

/** A deep copy without value keywords (and value hints). */
function scrub(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(scrub);
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) {
    if (VALUE_KEYWORDS.has(k)) continue;
    if (k === "x-ui" && isObj(v)) {
      const hints: Obj = JSON.parse(JSON.stringify(v));
      for (const h of VALUE_HINTS) delete hints[h];
      out[k] = hints;
    } else if (SCHEMA_MAPS.has(k) && isObj(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, scrub(sub)]));
    } else out[k] = scrub(v);
  }
  return out;
}

/** An English text of a hint: a plain string or the `en` of a localized one. */
function hintText(v: unknown): string | undefined {
  if (typeof v === "string" && v !== "") return v;
  if (isObj(v) && typeof v.en === "string" && v.en !== "") return v.en;
  return undefined;
}

function fieldOf(node: Obj, shape: Obj, path: string, required: boolean, isSet: boolean) {
  const hints = isObj(shape["x-ui"]) ? shape["x-ui"] : isObj(node["x-ui"]) ? node["x-ui"] : {};
  const label = hintText(shape.title) ?? hintText(node.title) ?? hintText(hints.label) ?? path;
  const description =
    hintText(shape.description) ?? hintText(node.description) ?? hintText(hints.help);
  const spec: PersonFieldSpec = {
    path,
    label,
    multiline: typeof hints.widget === "string" && MULTILINE_WIDGETS.has(hints.widget),
    required,
    isSet,
    schema: scrub(node) as Obj,
  };
  if (description !== undefined) spec.description = description;
  return spec;
}

/**
 * The secret fields of a config JSON Schema (`configJsonSchema` output): every string node marked
 * `"x-secret": true` (or under a secret object) reachable through `properties`, by dot path, in
 * declaration order. `required` holds when every object along the path lists the next name in
 * its `required`; `isSet` when `stored` holds the path. Secrets the card cannot address go to
 * `recordOnly`: the paths `x-ui.secrets` names, secret nodes that are not strings (records), and
 * secrets inside array items (as `list[].key`). It fails closed on shapes it cannot see through:
 * a `$ref`, an `allOf` or a union of two or more non-null branches whose subtree holds a secret
 * puts the node's own path into `recordOnly`.
 */
export function secretFieldsOf(
  jsonSchema: unknown,
  stored: ReadonlySet<string>,
): { fields: PersonFieldSpec[]; recordOnly: string[] } {
  const fields: PersonFieldSpec[] = [];
  const recordOnly = new Set<string>();
  if (!isObj(jsonSchema)) return { fields, recordOnly: [] };
  const hinted = hintedSecretPaths(jsonSchema);

  const walk = (
    node: Obj,
    path: string,
    required: boolean,
    inSecret: boolean,
    inArray: boolean,
  ) => {
    const shape = shapeOf(node);
    const secret = inSecret || node["x-secret"] === true || shape["x-secret"] === true;
    if (!secret) {
      // Fail closed: the walker descends only `properties` and `items`. A secret anywhere else
      // in the node (`$ref`, `allOf`, unions, `additionalProperties`, `patternProperties`,
      // `prefixItems`, `if` / `then` / `else`, `not`, …) makes the whole node web-only. `$defs` are
      // reached only through a `$ref`, which containsSecret follows.
      const descended = isObj(shape.properties)
        ? ["properties"]
        : isObj(shape.items)
          ? ["items"]
          : [];
      const outer = shape === node ? {} : without(node, ["anyOf", "oneOf"]);
      if (
        containsSecret(outer, jsonSchema) ||
        containsSecret(without(shape, [...descended, "x-ui", "$defs", "definitions"]), jsonSchema)
      ) {
        recordOnly.add(path);
        return;
      }
    }
    if (isObj(shape.properties)) {
      const req = Array.isArray(shape.required) ? shape.required : [];
      for (const [name, child] of Object.entries(shape.properties)) {
        if (!isObj(child)) continue;
        const childPath = path === "" ? name : `${path}.${name}`;
        walk(child, childPath, required && req.includes(name), secret, inArray);
      }
      return;
    }
    if (isObj(shape.items) && !secret) {
      walk(shape.items, `${path}[]`, false, false, true);
      return;
    }
    if (!secret || path === "") return;
    if (inArray || hinted.has(path) || !isStringNode(shape)) recordOnly.add(path);
    else fields.push(fieldOf(node, shape, path, required, stored.has(path)));
  };

  walk(jsonSchema, "", true, false, false);
  for (const p of hinted) recordOnly.add(p);
  const asked = new Set(fields.map((f) => f.path));
  return { fields, recordOnly: [...recordOnly].filter((p) => !asked.has(p)) };
}

/** The plan of one call: the fields the card asks for and the secrets to clear, or a refusal. */
export type PersonFieldPlan =
  | { ok: true; ask: PersonFieldSpec[]; clear: string[] }
  | { ok: false; message: string };

/**
 * Every (dot path, leaf value) pair of `values`, keyed by dot path or nesting objects: own
 * properties only, plain objects descended, arrays, scalars and null leaves.
 */
function flatten(values: Obj, prefix = "", out: [string, unknown][] = []): [string, unknown][] {
  for (const [key, v] of Object.entries(values)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    // An empty object carries nothing: no pair.
    if (isObj(v)) flatten(v, path, out);
    else out.push([path, v]);
  }
  return out;
}

/**
 * Whether a pair at `pairPath` touches the secret at `secretPath`: at it, below it, or above it
 * (a leaf in place of the object holding it). `""` (an opaque root) touches every pair.
 */
function touches(pairPath: string, secretPath: string): boolean {
  return (
    secretPath === "" ||
    pairPath === secretPath ||
    pairPath.startsWith(`${secretPath}.`) ||
    secretPath.startsWith(`${pairPath}.`)
  );
}

/** The path the values check guards for a recordOnly path: an array-item secret's array root. */
function guardedPath(path: string): string {
  const cut = path.indexOf("[]");
  return cut < 0 ? path : path.slice(0, cut).replace(/\.$/, "");
}

/**
 * Plans the person fields of one call (spec §4.1). Refusals are English for the model:
 * - a non-null value in `values` at, below or above a secret field or a recordOnly path (an
 *   array-item secret: its array root) -> the leaked-secret copy, naming only the path, never the
 *   value; `values` is flattened once, so flat, nested and prefix keys all count; a null at a
 *   secret field -> pointed to clearSecrets;
 * - an `askPerson` / `clearSecrets` path that is not a secret field of the target;
 * - a path both asked and cleared;
 * - more than {@link PERSON_FIELDS_MAX} fields to ask.
 * A required secret without a stored value joins `ask` even when not named (unless it is cleared).
 */
export function planPersonFields(
  t: PersonFieldTarget,
  p: { values?: Record<string, unknown>; askPerson: string[]; clearSecrets: string[] },
): PersonFieldPlan {
  const byPath = new Map(t.fields.map((f) => [f.path, f]));
  const pairs = flatten(p.values ?? {});
  const leaks = (secretPath: string) =>
    pairs.some(([path, v]) => v !== null && v !== undefined && touches(path, secretPath));
  for (const f of t.fields) {
    if (leaks(f.path)) {
      return {
        ok: false,
        message: `Secret fields are entered by the person on the confirmation card; leave \`${f.path}\` out of values and list it in askPerson. A value passed in params has been seen by the model and counts as leaked: tell the person to rotate it.`,
      };
    }
  }
  for (const path of t.recordOnly ?? []) {
    if (leaks(guardedPath(path))) {
      return {
        ok: false,
        message: `\`${path}\` is a secret record the person enters on the web page; leave it out of values. A value passed in params has been seen by the model and counts as leaked: tell the person to rotate it.`,
      };
    }
  }
  for (const f of t.fields) {
    if (pairs.some(([path, v]) => v === null && path === f.path)) {
      return {
        ok: false,
        message: `To clear \`${f.path}\`, leave it out of values and list it in clearSecrets.`,
      };
    }
  }
  const known = t.fields.map((f) => f.path).join(", ");
  const unknownIn = (paths: string[], verb: string): string | null => {
    const bad = paths.find((x) => !byPath.has(x));
    if (bad === undefined) return null;
    return known === ""
      ? `${bad} is not a secret field of this target; it has no secret fields the person can enter.`
      : `${bad} is not a secret field of this target; only these can be ${verb}: ${known}`;
  };
  const unknownAsk = unknownIn(p.askPerson, "asked");
  if (unknownAsk !== null) return { ok: false, message: unknownAsk };
  const unknownClear = unknownIn(p.clearSecrets, "cleared");
  if (unknownClear !== null) return { ok: false, message: unknownClear };
  const clear = new Set(p.clearSecrets);
  const both = p.askPerson.find((x) => clear.has(x));
  if (both !== undefined) {
    return {
      ok: false,
      message: `\`${both}\` is in both askPerson and clearSecrets; list it in one of them: askPerson to have the person enter a new value, clearSecrets to remove the stored one.`,
    };
  }
  const named = new Set(p.askPerson);
  const ask = t.fields.filter(
    (f) => named.has(f.path) || (f.required && !f.isSet && !clear.has(f.path)),
  );
  if (ask.length > PERSON_FIELDS_MAX) {
    return {
      ok: false,
      message: `This call would ask the person for ${ask.length} fields; one confirmation card holds at most ${PERSON_FIELDS_MAX}. Split the change into several calls.`,
    };
  }
  return { ok: true, ask, clear: t.fields.filter((f) => clear.has(f.path)).map((f) => f.path) };
}

/** One validator for every person field, configured like the tool pipeline's (`tools/validate.ts`). */
const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
/** Compiled validators by schema node (null: the node does not compile). */
const compiled = new WeakMap<object, ValidateFunction | null>();

function validatorOf(schema: Obj): ValidateFunction | null {
  const hit = compiled.get(schema);
  if (hit !== undefined) return hit;
  const { $schema: _ignored, $id: _id, ...node } = schema;
  let fn: ValidateFunction | null;
  try {
    fn = ajv.compile(node);
  } catch {
    fn = null;
  } finally {
    // Ajv keeps every compiled schema object; the WeakMap is the only cache.
    ajv.removeSchema(node);
  }
  compiled.set(schema, fn);
  return fn;
}

/**
 * Checks one value the person typed against its field: at most {@link PERSON_FIELD_MAX_BYTES}
 * UTF-8 bytes, not empty, and valid for the field's JSON Schema node (ajv, JSON Schema 2020-12,
 * as the tool pipeline validates inputs). Returns null when valid, else an English problem that
 * names the field and never echoes the value. A node ajv cannot compile accepts the value: the
 * write validates the whole config again.
 */
export function checkPersonValue(spec: PersonFieldSpec, value: string): string | null {
  if (Buffer.byteLength(value, "utf8") > PERSON_FIELD_MAX_BYTES) {
    return `${spec.label} is longer than 16 KiB.`;
  }
  if (value === "") return `${spec.label} is empty.`;
  const validate = validatorOf(spec.schema);
  if (validate === null || validate(value)) return null;
  const problems = (validate.errors ?? []).map((e) => e.message ?? "is invalid");
  return `${spec.label} ${[...new Set(problems)].join("; ")}.`;
}
