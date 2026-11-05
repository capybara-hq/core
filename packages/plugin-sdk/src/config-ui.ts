import { z } from "zod";
import type { LocalizedName } from "./plugin-package.js";

/**
 * Config UI hints (extension config forms spec §3): declarative presentation hints attached to an
 * extension's config schema with {@link ui}, serialized as `x-ui` into the JSON Schema
 * ({@link configJsonSchema}) and drawn by one generic renderer in the web app. Hints never change
 * what validates: the zod schema stays the single source of truth for shape and validation.
 */

/** A JSON Schema object (as produced by {@link configJsonSchema}). */
export type JsonSchema = Record<string, unknown>;

/** The input widget of a field. */
export type ConfigWidget =
  | "text"
  | "textarea"
  | "url"
  | "number"
  | "select"
  | "radio"
  | "switch"
  | "checkbox"
  | "tristate"
  | "tags"
  | "json";

/** A labelled value of an enum (or boolean) field. */
export interface ConfigUiOption {
  value: string | number | boolean;
  label: LocalizedName;
  help?: LocalizedName;
}

/** A root-level section that fields join with `section`. */
export interface ConfigUiSection {
  id: string;
  label: LocalizedName;
  help?: LocalizedName;
}

/** A prefilled item offered when adding an item to an array of objects. */
export interface ConfigUiPreset {
  id: string;
  label: LocalizedName;
  help?: LocalizedName;
  /** Prefilled item fields; never a secret. */
  values: Record<string, unknown>;
}

/** A secret drawn inside each item of an array, stored at a fixed record path keyed by an item field. */
export interface ConfigUiItemSecret {
  /** Dot path, from the schema root, of a `secret(z.record(z.string(), z.string()))` field. */
  path: string;
  /** The item's string field whose value is the record key (e.g. `name`). */
  keyBy: string;
  label: LocalizedName;
  help?: LocalizedName;
  placeholder?: string | LocalizedName;
  /** The item field the input is drawn after (default: last). */
  after?: string;
}

/** Presentation hints of one config schema node (zod meta `ui`, JSON Schema `x-ui`). */
export interface ConfigUiHints {
  label?: LocalizedName;
  help?: LocalizedName;
  placeholder?: string | LocalizedName;
  /** Shown after a number input ("tokens", "ms"). */
  unit?: LocalizedName;
  /** Sort key among siblings (default: declaration order). */
  order?: number;
  /** Root-level section id (`sections` on the root). */
  section?: string;
  /** Collapsed under "Advanced" in its object or item. */
  advanced?: boolean;
  widget?: ConfigWidget;
  options?: ConfigUiOption[];
  /** Objects (and array items): fields stacked (default) or one compact row. */
  layout?: "stack" | "row";
  /** Arrays: how each item is drawn and added. */
  item?: {
    /** `{field}` template from the item's own scalar fields, e.g. "{name}". */
    title?: string;
    subtitle?: string;
    addLabel?: LocalizedName;
    reorder?: boolean;
  };
  presets?: ConfigUiPreset[];
  secrets?: ConfigUiItemSecret[];
  /** Root only. */
  sections?: ConfigUiSection[];
  /** Root only: localized messages for custom issues (`params: { ui: key }`). */
  messages?: Record<string, LocalizedName>;
}

/** Limits of config UI hints and of the JSON Schemas a plugin package carries. */
export const CONFIG_UI_LIMITS = {
  /** Characters per language of a `label` (also `unit`, `item.addLabel`). */
  labelChars: 100,
  /** Characters per language of a `help` (also `messages` values). */
  helpChars: 500,
  /** Characters (per language) of a `placeholder`. */
  placeholderChars: 200,
  /** UTF-8 bytes of all `x-ui` JSON of one schema. */
  hintsBytes: 64 * 1024,
  /** Options per node. */
  options: 200,
  /** Presets per node. */
  presets: 20,
  /** Root sections. */
  sections: 20,
  /**
   * UTF-8 bytes of each JSON Schema in `plugin.json` `extension.configSchemas` (96 KiB: two of
   * them must fit in the 256 KiB `plugin.json` text with the rest of the manifest).
   */
  configSchemaBytes: 96 * 1024,
} as const;

/**
 * Attaches config UI hints to a schema (zod meta `ui`), merging with existing meta (`secret`,
 * `hot`, `description`). Returns the same schema type. Convention: put `ui()` outermost, after
 * `.default()` / `.optional()`.
 */
export function ui<T extends z.ZodTypeAny>(schema: T, hints: ConfigUiHints): T {
  return schema.meta({ ...(schema.meta() ?? {}), ui: hints }) as T;
}

/** zod types JSON Schema cannot express: emitted as `{}` with `x-unsupported`. */
const UNSUPPORTED = new Set([
  "bigint",
  "date",
  "symbol",
  "undefined",
  "void",
  "nan",
  "map",
  "set",
  "function",
  "promise",
  "custom",
  "file",
]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * An extension config schema as a JSON Schema for forms (the input side, defaults included, no
 * `$schema`):
 * - meta `secret: true` becomes `"x-secret": true`, `hot: true` becomes `"x-hot": true`, `ui`
 *   becomes `"x-ui"` (a JSON copy of the hints); `title` / `description` are filled from
 *   `x-ui.label.en` / `x-ui.help.en` when the node has none;
 * - unrepresentable types become `{ "x-unsupported": true }` instead of throwing;
 * - under a secret node no value is published: `default` / `examples` / `const` / `enum` and
 *   `x-ui.options` / `x-ui.presets` are removed from it and all its descendants.
 */
export function configJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const out = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: (ctx) => {
      const js = ctx.jsonSchema as JsonSchema;
      const def = (ctx.zodSchema as { _zod: { def: { type: string } } })._zod.def;
      if (js.secret === true) js["x-secret"] = true;
      delete js.secret;
      if (js.hot === true) js["x-hot"] = true;
      delete js.hot;
      if ("ui" in js) {
        // A JSON copy: hints are data, and the scrub must never mutate the schema's meta.
        const hints = JSON.parse(JSON.stringify(js.ui ?? null)) as unknown;
        delete js.ui;
        if (isObj(hints)) {
          js["x-ui"] = hints;
          const label = isObj(hints.label) ? hints.label.en : undefined;
          const help = isObj(hints.help) ? hints.help.en : undefined;
          if (js.title === undefined && typeof label === "string") js.title = label;
          if (js.description === undefined && typeof help === "string") js.description = help;
        }
      }
      if (UNSUPPORTED.has(def.type)) js["x-unsupported"] = true;
    },
  }) as JsonSchema;
  delete out.$schema;
  scrubSecrets(out);
  return out;
}

/** Keywords that would reveal values: never emitted for a secret. */
const VALUE_KEYWORDS = ["default", "examples", "const", "enum"];
/** Hints that would reveal values: never emitted for a secret. */
const VALUE_HINTS = ["options", "presets"];

/** Keywords whose value maps names to sub-schemas: their keys are field names, not keywords. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/**
 * Removes value-revealing keywords from secret nodes and all their descendants (`inSecret` passed
 * down). Only the keywords default / examples / const / enum are skipped as data; keys inside
 * `properties` and other maps are field names, so fields named default / enum are traversed.
 */
function scrubSecrets(node: unknown, inSecret = false): void {
  if (Array.isArray(node)) {
    for (const n of node) scrubSecrets(n, inSecret);
    return;
  }
  if (!isObj(node)) return;
  const secret = inSecret || node["x-secret"] === true;
  if (secret) {
    for (const k of VALUE_KEYWORDS) delete node[k];
    const hints = node["x-ui"];
    if (isObj(hints)) for (const k of VALUE_HINTS) delete hints[k];
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "x-ui") continue;
    if (SCHEMA_MAPS.has(k) && isObj(v)) {
      for (const child of Object.values(v)) scrubSecrets(child, secret);
    } else if (!VALUE_KEYWORDS.includes(k)) {
      scrubSecrets(v, secret);
    }
  }
}

/** One problem of the hints of a config schema. */
export interface ConfigUiProblem {
  /**
   * Dot path of the node holding the hint: property names, with `items` / `additionalProperties`
   * for array items and record values (`endpoints.items.models`); `""` is the root.
   */
  path: string;
  message: string;
}

const WIDGETS = new Set<string>([
  "text",
  "textarea",
  "url",
  "number",
  "select",
  "radio",
  "switch",
  "checkbox",
  "tristate",
  "tags",
  "json",
]);

const HINT_KEYS = new Set([
  "label",
  "help",
  "placeholder",
  "unit",
  "order",
  "section",
  "advanced",
  "widget",
  "options",
  "layout",
  "item",
  "presets",
  "secrets",
  "sections",
  "messages",
]);

/** The only hints a secret node may carry. */
const SECRET_HINT_KEYS = new Set(["label", "help", "placeholder", "order", "section", "advanced"]);

const ITEM_KEYS = new Set(["title", "subtitle", "addLabel", "reorder"]);

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** The JSON types a node accepts (`type`, a type list, or the branches of a nullable `anyOf`). */
function typesOf(node: JsonSchema): Set<string> {
  const t = node.type;
  if (typeof t === "string") return new Set([t]);
  if (Array.isArray(t)) return new Set(t.filter((x): x is string => typeof x === "string"));
  const branches = (node.anyOf ?? node.oneOf) as unknown;
  if (Array.isArray(branches)) {
    const out = new Set<string>();
    for (const b of branches) if (isObj(b)) for (const x of typesOf(b)) out.add(x);
    return out;
  }
  if ("const" in node) return new Set([jsonType(node.const)]);
  if (Array.isArray(node.enum)) return new Set(node.enum.map(jsonType));
  return new Set();
}

/** The non-null shape of a node: itself, or the one non-null branch of a nullable `anyOf`. */
function shapeOf(node: JsonSchema): JsonSchema {
  const branches = (node.anyOf ?? node.oneOf) as unknown;
  if (node.type === undefined && Array.isArray(branches)) {
    const rest = branches.filter((b) => isObj(b) && b.type !== "null") as JsonSchema[];
    if (rest.length === 1 && rest[0] !== undefined) return rest[0];
  }
  return node;
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** The enum values of a node (`enum`, `const`, or `anyOf` / `oneOf` branches of those), or null. */
function enumOf(node: JsonSchema): unknown[] | null {
  if (Array.isArray(node.enum)) return node.enum;
  if ("const" in node) return [node.const];
  const branches = (node.anyOf ?? node.oneOf) as unknown;
  if (Array.isArray(branches)) {
    const out: unknown[] = [];
    for (const b of branches) {
      if (!isObj(b)) return null;
      if (b.type === "null") continue;
      const e = enumOf(b);
      if (e === null) return null;
      out.push(...e);
    }
    return out.length > 0 ? out : null;
  }
  return null;
}

const isNumberType = (types: Set<string>) => types.has("number") || types.has("integer");
const only = (types: Set<string>, ...allowed: string[]) =>
  types.size > 0 && [...types].every((t) => t === "null" || allowed.includes(t));
const isScalar = (node: JsonSchema) => {
  const types = typesOf(node);
  return !types.has("object") && !types.has("array");
};

/** Does `value` fit the JSON type (and enum) of `node`? */
function fits(node: JsonSchema, value: unknown): boolean {
  const types = typesOf(node);
  const t = jsonType(value);
  const typeOk = types.size === 0 || types.has(t) || (t === "integer" && types.has("number"));
  if (!typeOk) return false;
  const e = enumOf(node);
  return e === null || e.some((x) => x === value);
}

function properties(node: JsonSchema): Record<string, JsonSchema> {
  const p = shapeOf(node).properties;
  return isObj(p) ? (p as Record<string, JsonSchema>) : {};
}

function itemsOf(node: JsonSchema): JsonSchema | null {
  const i = shapeOf(node).items;
  return isObj(i) ? i : null;
}

/**
 * Validates the `x-ui` hints of a JSON Schema produced by {@link configJsonSchema} (spec §3.3) at
 * a config level. Pure; used by the packer, `capybara-plugin check` and the kernel. Returns every
 * problem (empty = valid); never throws. Problem paths are dot paths of the node holding the hint.
 */
export function validateConfigUi(
  schema: JsonSchema,
  level: "deployment" | "org" | "connection",
): ConfigUiProblem[] {
  const problems: ConfigUiProblem[] = [];
  const L = CONFIG_UI_LIMITS;
  const rootHints = isObj(schema["x-ui"]) ? schema["x-ui"] : {};
  const sectionIds = new Set(
    Array.isArray(rootHints.sections)
      ? rootHints.sections.flatMap((s) => (isObj(s) && typeof s.id === "string" ? [s.id] : []))
      : [],
  );
  let hintsBytes = 0;

  const resolvePath = (dotPath: string): JsonSchema | null => {
    let node: JsonSchema | null = schema;
    for (const seg of dotPath.split(".")) {
      if (node === null) return null;
      const props = properties(node);
      node = Object.hasOwn(props, seg) ? (props[seg] ?? null) : null;
    }
    return node;
  };

  const visit = (node: JsonSchema, path: string, isRoot: boolean): void => {
    const report = (message: string) => problems.push({ path, message });
    const text = (value: unknown, what: string, max: number, plainOk = false) => {
      if (value === undefined) return;
      if (plainOk && typeof value === "string") {
        if (value.trim() === "") report(`${what} must not be empty`);
        else if (value.length > max) report(`${what} must be at most ${max} characters`);
        return;
      }
      if (!isObj(value)) {
        report(`${what} must be { zh, en }${plainOk ? " or a string" : ""}`);
        return;
      }
      for (const lang of ["zh", "en"] as const) {
        const v = value[lang];
        if (typeof v !== "string" || v.trim() === "") report(`${what}.${lang} must not be empty`);
        else if (v.length > max) report(`${what}.${lang} must be at most ${max} characters`);
      }
      for (const k of Object.keys(value)) {
        if (k !== "zh" && k !== "en") report(`${what} has an unknown key "${k}"`);
      }
    };

    const raw = node["x-ui"];
    if (raw !== undefined) {
      hintsBytes += utf8Bytes(JSON.stringify(raw));
      if (!isObj(raw)) report("x-ui must be an object");
      else checkHints(raw, node, isRoot, report, text);
    }

    const shape = shapeOf(node);
    const props = shape.properties;
    if (isObj(props)) {
      for (const [k, child] of Object.entries(props)) {
        if (isObj(child)) visit(child, path === "" ? k : `${path}.${k}`, false);
      }
    }
    if (isObj(shape.items)) visit(shape.items, path === "" ? "items" : `${path}.items`, false);
    if (isObj(shape.additionalProperties)) {
      visit(
        shape.additionalProperties,
        path === "" ? "additionalProperties" : `${path}.additionalProperties`,
        false,
      );
    }
  };

  const checkHints = (
    h: Record<string, unknown>,
    node: JsonSchema,
    isRoot: boolean,
    report: (message: string) => void,
    text: (value: unknown, what: string, max: number, plainOk?: boolean) => void,
  ): void => {
    const shape = shapeOf(node);
    const types = typesOf(node);
    const isArray = types.has("array");
    const items = itemsOf(node);
    const itemProps = items !== null && typesOf(items).has("object") ? properties(items) : null;

    for (const k of Object.keys(h)) {
      if (!HINT_KEYS.has(k)) report(`x-ui has an unknown hint "${k}"`);
    }
    if (node["x-secret"] === true) {
      const bad = Object.keys(h).filter((k) => HINT_KEYS.has(k) && !SECRET_HINT_KEYS.has(k));
      if (bad.length > 0) {
        report(
          `a secret field allows only label, help, placeholder, order, section and advanced hints, not ${bad.join(", ")}`,
        );
      }
    }

    text(h.label, "label", L.labelChars);
    text(h.help, "help", L.helpChars);
    text(h.placeholder, "placeholder", L.placeholderChars, true);
    text(h.unit, "unit", L.labelChars);
    if (h.order !== undefined && (typeof h.order !== "number" || !Number.isFinite(h.order))) {
      report("order must be a number");
    }
    if (h.advanced !== undefined && typeof h.advanced !== "boolean") {
      report("advanced must be a boolean");
    }

    if (h.section !== undefined) {
      if (typeof h.section !== "string" || !sectionIds.has(h.section)) {
        report(`section "${String(h.section)}" is not an id of the root's sections`);
      }
    }
    if (!isRoot && h.sections !== undefined) report("sections are allowed only on the root");
    if (!isRoot && h.messages !== undefined) report("messages are allowed only on the root");
    if (isRoot && h.sections !== undefined) {
      if (!Array.isArray(h.sections)) report("sections must be an array");
      else {
        if (h.sections.length > L.sections) report(`at most ${L.sections} sections`);
        const ids = new Set<string>();
        h.sections.forEach((s, i) => {
          if (!isObj(s) || typeof s.id !== "string" || s.id === "") {
            report(`sections[${i}].id must be a non-empty string`);
            return;
          }
          if (ids.has(s.id)) report(`duplicate section id "${s.id}"`);
          ids.add(s.id);
          text(s.label, `sections[${i}].label`, L.labelChars);
          if (s.label === undefined) report(`sections[${i}].label is required`);
          text(s.help, `sections[${i}].help`, L.helpChars);
        });
      }
    }
    if (isRoot && h.messages !== undefined) {
      if (!isObj(h.messages)) report("messages must be an object");
      else for (const [k, v] of Object.entries(h.messages)) text(v, `messages.${k}`, L.helpChars);
    }

    // widget fits the type
    if (h.widget !== undefined) {
      const w = h.widget;
      const enumValues = enumOf(shape);
      const ok =
        typeof w === "string" &&
        WIDGETS.has(w) &&
        (w === "json" ||
          (["switch", "checkbox", "tristate"].includes(w) && only(types, "boolean")) ||
          (["select", "radio"].includes(w) && enumValues !== null) ||
          (w === "tags" && isArray && items !== null && only(typesOf(items), "string")) ||
          (["url", "textarea", "text"].includes(w) && only(types, "string")) ||
          (w === "number" && isNumberType(types) && only(types, "number", "integer")));
      if (!ok) report(`widget "${String(w)}" does not fit this field's type`);
    }

    // options: members of the enum (or booleans), each once
    if (h.options !== undefined) {
      if (!Array.isArray(h.options)) report("options must be an array");
      else {
        if (h.options.length > L.options) report(`at most ${L.options} options`);
        const allowed =
          enumOf(shape) ??
          (isArray && items !== null ? enumOf(items) : null) ??
          (only(types, "boolean") ? [true, false] : null);
        const seen: unknown[] = [];
        h.options.forEach((o, i) => {
          if (!isObj(o)) {
            report(`options[${i}] must be an object`);
            return;
          }
          if (allowed === null) report(`options[${i}]: this field has no enum to label`);
          else if (!allowed.some((v) => v === o.value)) {
            report(`options[${i}].value ${JSON.stringify(o.value)} is not a value of the field`);
          }
          if (seen.some((v) => v === o.value)) {
            report(`options[${i}].value ${JSON.stringify(o.value)} is listed twice`);
          }
          seen.push(o.value);
          text(o.label, `options[${i}].label`, L.labelChars);
          if (o.label === undefined) report(`options[${i}].label is required`);
          text(o.help, `options[${i}].help`, L.helpChars);
        });
      }
    }

    // layout
    if (h.layout !== undefined) {
      if (h.layout !== "stack" && h.layout !== "row") report('layout must be "stack" or "row"');
      else if (h.layout === "row") {
        const target =
          isArray && items !== null && typesOf(items).has("object")
            ? items
            : types.has("object")
              ? node
              : null;
        if (target === null) report('layout "row" applies only to objects and arrays of objects');
        else {
          const nonScalar = Object.entries(properties(target))
            .filter(([, p]) => !isScalar(p))
            .map(([k]) => k);
          if (nonScalar.length > 0) {
            report(`layout "row" needs scalar fields; not scalar: ${nonScalar.join(", ")}`);
          }
        }
      }
    }

    // item / presets / secrets: arrays only; presets and secrets: arrays of objects
    for (const k of ["item", "presets", "secrets"] as const) {
      if (h[k] === undefined) continue;
      if (!isArray) report(`${k} applies only to arrays`);
      else if (k !== "item" && itemProps === null) {
        report(`${k} applies only to arrays of objects`);
      }
    }

    if (isObj(h.item) && isArray) {
      for (const k of Object.keys(h.item)) {
        if (!ITEM_KEYS.has(k)) report(`item has an unknown key "${k}"`);
      }
      for (const k of ["title", "subtitle"] as const) {
        const tpl = h.item[k];
        if (tpl === undefined) continue;
        if (typeof tpl !== "string") {
          report(`item.${k} must be a string`);
          continue;
        }
        for (const m of tpl.matchAll(/\{([^{}]*)\}/g)) {
          const field = m[1] ?? "";
          const p = itemProps !== null && Object.hasOwn(itemProps, field) ? itemProps[field] : null;
          if (p === null || p === undefined || !isScalar(p)) {
            report(`item.${k} names "${field}", which is not a scalar field of the item`);
          }
        }
      }
      text(h.item.addLabel, "item.addLabel", L.labelChars);
      if (h.item.reorder !== undefined && typeof h.item.reorder !== "boolean") {
        report("item.reorder must be a boolean");
      }
    } else if (h.item !== undefined && isArray) {
      report("item must be an object");
    }

    if (h.presets !== undefined && itemProps !== null) {
      if (!Array.isArray(h.presets)) report("presets must be an array");
      else {
        if (h.presets.length > L.presets) report(`at most ${L.presets} presets`);
        const ids = new Set<string>();
        h.presets.forEach((p, i) => {
          if (!isObj(p) || typeof p.id !== "string" || p.id === "") {
            report(`presets[${i}].id must be a non-empty string`);
            return;
          }
          if (ids.has(p.id)) report(`duplicate preset id "${p.id}"`);
          ids.add(p.id);
          text(p.label, `presets[${i}].label`, L.labelChars);
          if (p.label === undefined) report(`presets[${i}].label is required`);
          text(p.help, `presets[${i}].help`, L.helpChars);
          if (!isObj(p.values)) {
            report(`presets[${i}].values must be an object`);
            return;
          }
          for (const [k, v] of Object.entries(p.values)) {
            const prop = Object.hasOwn(itemProps, k) ? itemProps[k] : undefined;
            if (prop === undefined) report(`presets[${i}].values.${k} is not a field of the item`);
            else if (prop["x-secret"] === true) {
              report(`presets[${i}].values.${k} is a secret; presets never carry secrets`);
            } else if (!fits(prop, v)) {
              report(`presets[${i}].values.${k} does not match the field's type or values`);
            }
          }
        });
      }
    }

    if (h.secrets !== undefined && itemProps !== null) {
      if (level !== "deployment") {
        report("secrets drawn per item are allowed only in the deployment config");
      }
      if (!Array.isArray(h.secrets)) report("secrets must be an array");
      else
        h.secrets.forEach((s, i) => {
          if (!isObj(s)) {
            report(`secrets[${i}] must be an object`);
            return;
          }
          const target = typeof s.path === "string" ? resolvePath(s.path) : null;
          const ap = target === null ? null : shapeOf(target).additionalProperties;
          if (
            target === null ||
            target["x-secret"] !== true ||
            !typesOf(target).has("object") ||
            !isObj(ap) ||
            ap.type !== "string"
          ) {
            report(
              `secrets[${i}].path "${String(s.path)}" is not a secret record of strings (secret(z.record(z.string(), z.string())))`,
            );
          }
          const keyProp =
            typeof s.keyBy === "string" && Object.hasOwn(itemProps, s.keyBy)
              ? itemProps[s.keyBy]
              : undefined;
          if (keyProp === undefined || !only(typesOf(keyProp), "string")) {
            report(`secrets[${i}].keyBy "${String(s.keyBy)}" is not a string field of the item`);
          }
          if (
            s.after !== undefined &&
            (typeof s.after !== "string" || !Object.hasOwn(itemProps, s.after))
          ) {
            report(`secrets[${i}].after "${String(s.after)}" is not a field of the item`);
          }
          text(s.label, `secrets[${i}].label`, L.labelChars);
          if (s.label === undefined) report(`secrets[${i}].label is required`);
          text(s.help, `secrets[${i}].help`, L.helpChars);
          text(s.placeholder, `secrets[${i}].placeholder`, L.placeholderChars, true);
        });
    }
  };

  visit(schema, "", true);
  if (hintsBytes > L.hintsBytes) {
    problems.push({
      path: "",
      message: `x-ui hints total ${hintsBytes} bytes; at most ${L.hintsBytes} (64 KiB) per schema`,
    });
  }
  return problems;
}
