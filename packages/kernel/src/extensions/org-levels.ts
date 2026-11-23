import { isPlatformOnly, type JsonSchema } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * The org level of a deployment config field (unified config spec §5.1): `override` (the default:
 * the platform sets the default value, an org may save its own copy) or `platform` (marked
 * `platformOnly`: set by the platform only, never shown to an org). Levels sit on top-level keys of
 * the deployment schema only (spec A §5.2); a nested field has its top-level key's level. A
 * `platformOnly` root makes every key `platform`. The SDK refuses a mark below a top-level key,
 * but a hand-made package may carry one: such a mark fails closed, making its whole top-level key
 * `platform` (an org never gets a field the plugin meant for the platform alone).
 */
export type FieldLevel = "platform" | "override";

/**
 * The deployment schema's object: the schema itself, or the input object of a pipe or transform
 * root (`z.object({…}).transform(…)`), as zod's JSON Schema of the input shows its properties, so
 * a loaded replica and one reading the static form agree. undefined for anything else.
 */
export function deploymentObject(schema: z.ZodTypeAny | undefined): z.ZodObject | undefined {
  let node: z.ZodTypeAny | undefined = schema;
  for (let depth = 0; node !== undefined && depth < 16; depth++) {
    if (node instanceof z.ZodObject) return node;
    node = node instanceof z.ZodPipe ? (node.in as z.ZodTypeAny) : undefined;
  }
  return undefined;
}

/** Whether `schema` or any schema nested in it (fields, items, options, wrappers) is marked. */
function markedAnywhere(schema: z.ZodTypeAny, seen = new Set<unknown>()): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  if (isPlatformOnly(schema)) return true;
  const def = schema._zod.def as unknown as Record<string, unknown>;
  for (const v of Object.values(def)) {
    const children =
      v instanceof z.ZodType
        ? [v]
        : Array.isArray(v)
          ? v
          : typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype
            ? Object.values(v)
            : [];
    for (const c of children) {
      if (c instanceof z.ZodType && markedAnywhere(c as z.ZodTypeAny, seen)) return true;
    }
  }
  return false;
}

/**
 * The top-level keys of a `ZodObject` deployment schema (or the input object of a pipe or
 * transform root, {@link deploymentObject}) with their level; empty otherwise.
 */
export function fieldLevels(schema: z.ZodTypeAny | undefined): Map<string, FieldLevel> {
  const out = new Map<string, FieldLevel>();
  const obj = deploymentObject(schema);
  if (schema === undefined || obj === undefined) return out;
  const root = isPlatformOnly(schema) || isPlatformOnly(obj);
  for (const [key, field] of Object.entries(obj.shape as Record<string, z.ZodTypeAny>)) {
    out.set(key, root || markedAnywhere(field) ? "platform" : "override");
  }
  return out;
}

const markedPlatformOnly = (node: unknown): boolean =>
  (node as { "x-platform-only"?: unknown } | null)?.["x-platform-only"] === true;

/**
 * Whether a JSON Schema node or anything below it carries `"x-platform-only": true`, following
 * local `$ref`s (`#/…`) into `root`.
 */
function jsonMarkedAnywhere(node: unknown, root: unknown, seen = new Set<unknown>()): boolean {
  if (typeof node !== "object" || node === null || seen.has(node)) return false;
  seen.add(node);
  if (markedPlatformOnly(node)) return true;
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      const k = part.replace(/~1/g, "/").replace(/~0/g, "~");
      target = typeof target === "object" && target !== null ? (target as never)[k] : undefined;
    }
    if (jsonMarkedAnywhere(target, root, seen)) return true;
  }
  return Object.values(node).some((v) => jsonMarkedAnywhere(v, root, seen));
}

/**
 * The same levels read from a package's static form schema (`x-platform-only` on the root, a
 * top-level property or, failing closed, anywhere below one), for an install record whose module
 * this replica has not loaded.
 */
export function jsonSchemaFieldLevels(schema: JsonSchema | undefined): Map<string, FieldLevel> {
  const out = new Map<string, FieldLevel>();
  const props = (schema as { properties?: unknown } | undefined)?.properties;
  if (typeof props !== "object" || props === null) return out;
  const root = markedPlatformOnly(schema);
  for (const [key, prop] of Object.entries(props as Record<string, unknown>)) {
    out.set(key, root || jsonMarkedAnywhere(prop, schema) ? "platform" : "override");
  }
  return out;
}

const overrideKeys = (schema: z.ZodTypeAny): string[] =>
  [...fieldLevels(schema)].filter(([, l]) => l === "override").map(([k]) => k);

/**
 * The platform's relaxed schema (§5.4a): a plain object rebuilt from the shape with every
 * `override` key optional, so the platform may leave overridable fields empty (each org then
 * brings its own); platform-only fields stay as declared. Object-level refinements
 * (`.refine` / `.superRefine`) are not carried over: they may read the absent fields, and zod
 * refuses `.extend()` on a refined object. The identity when there is no `override` key. Parse
 * through {@link parseLoadGate}, which uses this only when an overridable field is missing.
 */
export function relaxOverridable(schema: z.ZodTypeAny): z.ZodTypeAny {
  const keys = overrideKeys(schema);
  if (keys.length === 0 || deploymentObject(schema) === undefined) return schema;
  // A pipe or transform root keeps its output side(s) on the relaxed input object
  const rebuild = (node: z.ZodTypeAny): z.ZodTypeAny => {
    if (node instanceof z.ZodPipe) {
      return rebuild(node.in as z.ZodTypeAny).pipe(node.out as z.ZodTypeAny);
    }
    const obj = node as z.ZodObject;
    const shape = { ...(obj.shape as Record<string, z.ZodTypeAny>) };
    for (const k of keys) shape[k] = (shape[k] as z.ZodTypeAny).optional();
    const plain = z.object(shape);
    const catchall = obj._zod.def.catchall as z.ZodTypeAny | undefined;
    return catchall ? plain.catchall(catchall) : plain;
  };
  return rebuild(schema);
}

/**
 * The platform's load gate (§5.4a): the original schema, refinements included, whenever the
 * platform config `raw` leaves no required overridable field empty; otherwise the relaxed plain
 * object ({@link relaxOverridable}). Following orgs are then `needsConfig` and never called, and
 * an org copy is parsed with the full schema.
 */
export function parseLoadGate(schema: z.ZodTypeAny, raw: unknown): z.ZodSafeParseResult<unknown> {
  if (missingOverridable(schema, raw).length === 0) return schema.safeParse(raw);
  return relaxOverridable(schema).safeParse(raw);
}

/**
 * The required `override` keys the platform config `raw` leaves empty (absent and refused by the
 * key's own schema), in schema order: orgs that follow the platform must configure them.
 */
export function missingOverridable(schema: z.ZodTypeAny, raw: unknown): string[] {
  const keys = overrideKeys(schema);
  const obj = deploymentObject(schema);
  if (keys.length === 0 || obj === undefined) return [];
  const shape = obj.shape as Record<string, z.ZodTypeAny>;
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return keys.filter(
    (k) => value[k] === undefined && !(shape[k] as z.ZodTypeAny).safeParse(undefined).success,
  );
}
