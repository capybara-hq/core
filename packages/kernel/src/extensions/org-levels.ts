import { type JsonSchema, orgAccessOf } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * The org level of a deployment config field (spec A §5.1): `hidden` (platform only, orgs never
 * see it; a field without `orgAccess`), `readonly` (orgs see it, cannot change it) or `override`
 * (the platform sets the default, an org may bring its own value). Levels sit on top-level keys of
 * the deployment schema only (§5.2); a nested field has its top-level key's level.
 */
export type FieldLevel = "hidden" | "readonly" | "override";

/** The top-level keys of a `ZodObject` deployment schema with their level; empty otherwise. */
export function fieldLevels(schema: z.ZodTypeAny | undefined): Map<string, FieldLevel> {
  const out = new Map<string, FieldLevel>();
  if (!(schema instanceof z.ZodObject)) return out;
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
    out.set(key, orgAccessOf(field) ?? "hidden");
  }
  return out;
}

/**
 * The same levels read from a package's static form schema (`x-org` on top-level properties), for
 * an install record whose module this replica has not loaded.
 */
export function jsonSchemaFieldLevels(schema: JsonSchema | undefined): Map<string, FieldLevel> {
  const out = new Map<string, FieldLevel>();
  const props = (schema as { properties?: unknown } | undefined)?.properties;
  if (typeof props !== "object" || props === null) return out;
  for (const [key, prop] of Object.entries(props as Record<string, unknown>)) {
    const v = (prop as { "x-org"?: unknown } | null)?.["x-org"];
    out.set(key, v === "readonly" || v === "override" ? v : "hidden");
  }
  return out;
}

const overrideKeys = (schema: z.ZodTypeAny): string[] =>
  [...fieldLevels(schema)].filter(([, l]) => l === "override").map(([k]) => k);

/**
 * The platform's relaxed schema (§5.4a): a plain object rebuilt from the shape with every
 * `override` key optional, so the platform may leave overridable fields empty (each org then
 * brings its own); hidden and read-only fields stay as declared. Object-level refinements
 * (`.refine` / `.superRefine`) are not carried over: they may read the absent fields, and zod
 * refuses `.extend()` on a refined object. The identity when there is no `override` key. Parse
 * through {@link parseLoadGate}, which uses this only when an overridable field is missing.
 */
export function relaxOverridable(schema: z.ZodTypeAny): z.ZodTypeAny {
  const keys = overrideKeys(schema);
  if (keys.length === 0) return schema;
  const obj = schema as z.ZodObject;
  const shape = { ...(obj.shape as Record<string, z.ZodTypeAny>) };
  for (const k of keys) shape[k] = (shape[k] as z.ZodTypeAny).optional();
  const plain = z.object(shape);
  const catchall = obj._zod.def.catchall as z.ZodTypeAny | undefined;
  return catchall ? plain.catchall(catchall) : plain;
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
  if (keys.length === 0) return [];
  const shape = (schema as z.ZodObject).shape as Record<string, z.ZodTypeAny>;
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return keys.filter(
    (k) => value[k] === undefined && !(shape[k] as z.ZodTypeAny).safeParse(undefined).success,
  );
}
