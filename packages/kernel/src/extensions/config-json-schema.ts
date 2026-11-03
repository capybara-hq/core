/**
 * Config schema → JSON Schema for forms. The conversion (and the secret scrub) lives in the SDK
 * (`configJsonSchema`, extension config forms spec §4.1) so the packer, the checks and the kernel
 * share one implementation; the kernel keeps no copy.
 */
import {
  type ConfigUiProblem,
  configJsonSchema,
  type JsonSchema,
  validateConfigUi,
} from "@capybara-hq/plugin-sdk";
import type { z } from "zod";

export { configJsonSchema as configToJsonSchema, type JsonSchema } from "@capybara-hq/plugin-sdk";

/** The config level a schema belongs to (which hints `validateConfigUi` allows). */
export type ConfigLevel = "deployment" | "org" | "connection";

/** A config schema as served to forms, with the problems of its hints (empty = kept). */
export interface ConfigFormSchema {
  /** Shared by every caller: clone it before handing it out or changing it. */
  readonly schema: JsonSchema;
  readonly problems: ConfigUiProblem[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Keywords whose value maps names to sub-schemas: their keys are field names, not keywords. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/** Keywords whose value is data, not a schema: never recursed into. */
const VALUE_KEYWORDS = new Set(["default", "const", "enum", "examples"]);

/**
 * Removes every `x-ui` from a JSON Schema in place (a property named `x-ui` is kept, and so are
 * values: `default`, `const`, `enum` and `examples` are left as they are).
 */
export function stripConfigUi(node: unknown): void {
  if (Array.isArray(node)) {
    for (const n of node) stripConfigUi(n);
    return;
  }
  if (!isObj(node)) return;
  delete node["x-ui"];
  for (const [k, v] of Object.entries(node)) {
    if (VALUE_KEYWORDS.has(k)) continue;
    if (SCHEMA_MAPS.has(k) && isObj(v)) for (const child of Object.values(v)) stripConfigUi(child);
    else stripConfigUi(v);
  }
}

/**
 * Validates the hints of a JSON Schema at a level and strips every `x-ui` when there is any
 * problem (in place): invalid hints never reach a form, and never fail a load (spec §4.1).
 */
export function checkConfigUi(schema: JsonSchema, level: ConfigLevel): ConfigUiProblem[] {
  const problems = validateConfigUi(schema, level);
  if (problems.length > 0) stripConfigUi(schema);
  return problems;
}

/** Manifests are immutable: one conversion per zod schema object and level (read-only, per replica). */
const caches: Record<ConfigLevel, WeakMap<object, ConfigFormSchema>> = {
  deployment: new WeakMap(),
  org: new WeakMap(),
  connection: new WeakMap(),
};

/** A config schema's form JSON Schema ({@link checkConfigUi} applied), cached per schema object. */
export function configFormSchema(schema: z.ZodTypeAny, level: ConfigLevel): ConfigFormSchema {
  const cache = caches[level];
  let r = cache.get(schema);
  if (!r) {
    const js = configJsonSchema(schema);
    r = { schema: js, problems: checkConfigUi(js, level) };
    cache.set(schema, r);
  }
  return r;
}

/** The root `x-ui.messages` of a form schema (the localized texts of custom issues), if any. */
export function configMessages(schema: JsonSchema): Record<string, unknown> | undefined {
  const hints = schema["x-ui"];
  return isObj(hints) && isObj(hints.messages) ? hints.messages : undefined;
}

/** A short text of hint problems for a status detail or a log (the first few). */
export function describeConfigUiProblems(level: ConfigLevel, problems: ConfigUiProblem[]): string {
  const shown = problems.slice(0, 5).map((p) => `${p.path || "<root>"}: ${p.message}`);
  const more = problems.length > shown.length ? `; and ${problems.length - shown.length} more` : "";
  return `${level} config UI hints ignored (${shown.join("; ")}${more})`;
}
