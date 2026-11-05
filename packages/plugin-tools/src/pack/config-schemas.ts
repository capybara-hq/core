import {
  type ConfigUiProblem,
  configJsonSchema,
  type ExtensionManifest,
  type JsonSchema,
  validateConfigUi,
} from "@capybara-hq/plugin-sdk";

/**
 * The config JSON Schemas an extension's package carries (extension config forms spec §4.5) and
 * the checks the packer and `capybara-plugin check` ("Config forms") run on them.
 */

/** The config levels an extension declares a schema for. */
export type ConfigSchemaLevel = "deployment" | "org";

const LEVELS: ConfigSchemaLevel[] = ["deployment", "org"];

/** A problem of one level's schema (`path`: dot path of the node, `""` the root). */
export interface ConfigSchemaProblem extends ConfigUiProblem {
  level: ConfigSchemaLevel;
}

/** The JSON Schemas of an extension's config levels and the problems of their hints. */
export interface ExtensionConfigSchemas {
  schemas: { deployment?: JsonSchema; org?: JsonSchema };
  problems: ConfigSchemaProblem[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Keywords whose value is data, not a schema: never recursed into. */
const VALUE_KEYWORDS = new Set(["default", "const", "enum", "examples"]);

/** Hints that would reveal values; `configJsonSchema` drops them under a secret. */
const VALUE_HINTS = ["options", "presets"] as const;

const join = (path: string, seg: string) => (path === "" ? seg : `${path}.${seg}`);

/**
 * Value hints (`options`, `presets`) on a secret node or under one. `configJsonSchema` removes
 * them before `validateConfigUi` could see them, so a plugin would ship a hint that silently does
 * nothing; this reads the zod schema's own JSON Schema (meta `secret` / `ui` kept as written) with
 * the schema's own zod, so plugin-tools needs no zod at run time.
 */
function secretValueHints(schema: unknown): ConfigUiProblem[] {
  const toJson = (schema as { toJSONSchema?: (o: object) => unknown } | null)?.toJSONSchema;
  if (typeof toJson !== "function") return [];
  const raw = toJson.call(schema, { io: "input", unrepresentable: "any" });
  const out = new Map<string, ConfigUiProblem>();
  const walk = (node: unknown, path: string, inSecret: boolean): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, path, inSecret);
      return;
    }
    if (!isObj(node)) return;
    const secret = inSecret || node.secret === true;
    if (secret && isObj(node.ui)) {
      for (const k of VALUE_HINTS) {
        if (node.ui[k] === undefined) continue;
        const message = `x-ui.${k} on a secret field: secrets publish no values, so the form never shows them (remove ${k})`;
        out.set(`${path}\n${message}`, { path, message });
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "ui" || VALUE_KEYWORDS.has(k)) continue;
      if (k === "properties" && isObj(v)) {
        for (const [name, child] of Object.entries(v)) walk(child, join(path, name), secret);
      } else if (k === "items" || k === "additionalProperties") {
        walk(v, join(path, k), secret);
      } else {
        walk(v, path, secret);
      }
    }
  };
  walk(raw, "", false);
  return [...out.values()];
}

/**
 * The JSON Schemas (`configJsonSchema`) of an extension's deployment and org config, with every
 * problem of their hints: `validateConfigUi` at the level, plus value hints on secrets
 * ({@link secretValueHints}). The packer refuses a plugin with problems.
 */
export function extensionConfigSchemas(
  config: ExtensionManifest["config"] | undefined,
): ExtensionConfigSchemas {
  const result: ExtensionConfigSchemas = { schemas: {}, problems: [] };
  for (const level of LEVELS) {
    const zod = config?.[level];
    if (zod === undefined) continue;
    const schema = configJsonSchema(zod);
    result.schemas[level] = schema;
    for (const p of [...validateConfigUi(schema, level), ...secretValueHints(zod)]) {
      result.problems.push({ level, ...p });
    }
  }
  return result;
}

/** `<level> config: <path>: <message>` (the root as `(root)`). */
export const formatConfigSchemaProblem = (p: ConfigSchemaProblem) =>
  `${p.level} config: ${p.path === "" ? "(root)" : p.path}: ${p.message}`;

/** The non-null shape of a node: itself, or the one non-null branch of a nullable `anyOf`. */
function shapeOf(node: JsonSchema): JsonSchema {
  const branches = (node.anyOf ?? node.oneOf) as unknown;
  if (node.type === undefined && Array.isArray(branches)) {
    const rest = branches.filter((b) => isObj(b) && b.type !== "null") as JsonSchema[];
    if (rest.length === 1 && rest[0] !== undefined) return rest[0];
  }
  return node;
}

const hasText = (v: unknown) => typeof v === "string" && v.trim() !== "";

/** Does the node (or its non-null shape) carry `x-ui.label` with both zh and en? */
function hasLabel(node: JsonSchema): boolean {
  for (const n of [node, shapeOf(node)]) {
    const label = isObj(n["x-ui"]) ? n["x-ui"].label : undefined;
    if (isObj(label) && hasText(label.zh) && hasText(label.en)) return true;
  }
  return false;
}

/** Every `x-ui.secrets[].path` of a form schema (dot paths from the root). */
function itemSecretPaths(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) itemSecretPaths(n, out);
    return out;
  }
  if (!isObj(node)) return out;
  const hints = node["x-ui"];
  if (isObj(hints) && Array.isArray(hints.secrets)) {
    for (const s of hints.secrets) if (isObj(s) && typeof s.path === "string") out.add(s.path);
  }
  for (const [k, v] of Object.entries(node)) {
    if (k !== "x-ui" && !VALUE_KEYWORDS.has(k)) itemSecretPaths(v, out);
  }
  return out;
}

/**
 * The rendered fields of a form schema without a label in both languages (`plugin-config-labels`):
 * every property node the form draws, in nested objects, array items and record values. A secret
 * record named by some `x-ui.secrets[].path` is skipped (it is drawn inside each item with that
 * hint's own label); a secret node is drawn as one input, so its own properties are not visited.
 */
export function missingConfigLabels(schema: JsonSchema): ConfigUiProblem[] {
  const skip = itemSecretPaths(schema);
  const out: ConfigUiProblem[] = [];
  const visit = (node: JsonSchema, path: string): void => {
    const shape = shapeOf(node);
    if (isObj(shape.properties)) {
      for (const [k, child] of Object.entries(shape.properties)) {
        if (!isObj(child)) continue;
        const p = join(path, k);
        if (skip.has(p)) continue;
        if (!hasLabel(child)) {
          out.push({ path: p, message: "has no label (x-ui.label with zh and en)" });
        }
        if (child["x-secret"] !== true) visit(child, p);
      }
    }
    if (isObj(shape.items)) visit(shape.items, join(path, "items"));
    if (isObj(shape.additionalProperties)) {
      visit(shape.additionalProperties, join(path, "additionalProperties"));
    }
  };
  visit(schema, "");
  return out;
}
