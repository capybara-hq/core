import type { ConfigIssue, JsonSchema } from "../../lib/json-schema";

/**
 * The config form model (extension config forms spec §5): a JSON Schema with `x-ui` hints becomes a
 * tree of nodes; a value becomes a draft (what the inputs hold: text for numbers, rows for records,
 * secret operations) and back, with the client-side checks; server issues map onto the nodes by
 * their path. Pure: no React, no i18n (problem kinds are translated by the form).
 *
 * Node ids are value paths: property names and array indexes (`endpoints/#0/models/#1/id`, see
 * {@link nodeId}); a secret drawn per item adds `$secret:<record path>` after the item's path.
 */

export type Locale = "zh" | "en";
export type Segment = string | number;
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

interface NodeBase {
  /** The property key (`""` for the root and array items). */
  key: string;
  label: string;
  help?: string;
  placeholder?: string;
  /** Listed in the parent's `required` (array items always are). */
  required: boolean;
  advanced: boolean;
  /** Root-level section id. */
  section?: string;
  hot: boolean;
  /**
   * The dot path of the config field this node belongs to: object keys from the root down to the
   * first array / record / leaf (nodes inside an array share the array's). Keys the `meta` prop.
   */
  fieldPath: string;
  default?: unknown;
}

export interface ScalarOption {
  /** The `<select>` / radio value: the JSON text of `value`. */
  token: string;
  value: unknown;
  label: string;
  help?: string;
}

export interface ScalarNode extends NodeBase {
  kind: "scalar";
  type: "string" | "number" | "integer" | "boolean";
  widget: ConfigWidget;
  options?: ScalarOption[];
  unit?: string;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
}

/** A secret stored as a whole at a fixed path: set / replace / clear, never shown. */
export interface SecretNode extends NodeBase {
  kind: "secret";
  shape: "string" | "number" | "record" | "json";
}

export interface ConfigSection {
  id: string;
  label: string;
  help?: string;
}

export interface ObjectNode extends NodeBase {
  kind: "object";
  children: ConfigNode[];
  layout: "stack" | "row";
  /** Root only: `x-ui.sections`, localized. */
  sections: ConfigSection[];
  /** Root only: `x-ui.messages`, localized. */
  messages: Record<string, string>;
}

export interface ConfigPreset {
  id: string;
  label: string;
  help?: string;
  values: Record<string, unknown>;
}

export interface ArrayNode extends NodeBase {
  kind: "array";
  /** An object (a repeater) or a scalar (one item per line). */
  item: ConfigNode;
  title?: string;
  subtitle?: string;
  addLabel?: string;
  reorder: boolean;
  presets: ConfigPreset[];
  minItems?: number;
  maxItems?: number;
}

/** A record of scalars: key / value rows. */
export interface RecordNode extends NodeBase {
  kind: "record";
  value: ScalarNode;
}

/** A secret record entry drawn inside each array item (`x-ui.secrets[]`), keyed by `keyBy`. */
export interface ItemSecretNode extends NodeBase {
  kind: "itemSecret";
  /** The record's dot path from the root (`apiKeys`). */
  path: string;
  keyBy: string;
}

/** Unions, tuples, `x-unsupported` and anything else: a JSON textarea. */
export interface JsonNode extends NodeBase {
  kind: "json";
}

export type ConfigNode =
  | ObjectNode
  | ArrayNode
  | RecordNode
  | ScalarNode
  | SecretNode
  | ItemSecretNode
  | JsonNode;

export type SecretOp = "keep" | "clear" | "set";

export type Draft =
  | { t: "text"; text: string }
  | { t: "bool"; value: boolean | undefined }
  | { t: "object"; fields: Record<string, Draft> }
  | { t: "array"; items: ItemDraft[] }
  | { t: "record"; rows: [string, string][] }
  | { t: "secret"; op: SecretOp; text: string; rows: [string, string][] }
  | {
      t: "itemSecret";
      op: SecretOp;
      text: string;
      /** The item's key when the form opened (renames send `renameFrom`); undefined for new items. */
      origKey: string | undefined;
    };

export interface ItemDraft {
  /** Stable identity across edits and moves. */
  key: string;
  draft: Draft;
}

export type ProblemKind =
  | "required"
  | "number"
  | "integer"
  | "json"
  | "min"
  | "gt"
  | "max"
  | "lt"
  | "minLength"
  | "maxLength"
  | "minItems"
  | "maxItems";

export interface NodeProblem {
  id: string;
  segments: Segment[];
  kind: ProblemKind;
  /** The node's label (the pending-config callout lists missing fields by it). */
  label: string;
  limit?: number;
}

/** One operation on a secret record drawn per item (kernel `SecretEntry`). */
export interface ConfigSecretEntry {
  path: string;
  key: string;
  value?: string | null;
  renameFrom?: string;
}

/** Per-field facts the adapter knows (keyed by {@link NodeBase.fieldPath}). */
export interface FieldMeta {
  /** Given by the startup config: the source (`file` / `nacos` / `env`); the field is read-only. */
  readonly?: string;
  /** A secret already has a value. */
  secretSet?: boolean;
  /** A secret record drawn per item: the keys that are set. */
  secretKeys?: string[];
  /** Saving applies at once (no reload). */
  hot?: boolean;
  /**
   * What orgs may do with the field (the platform form's level tag): `hidden` (orgs never see it),
   * `readonly` or `override`.
   */
  level?: "hidden" | "readonly" | "override";
  /**
   * The field shows the platform's value (an org form: a read-only field, or an overridable one
   * while the org follows the platform), labelled as set by the platform.
   */
  platform?: { value?: unknown; set?: boolean };
  /** An org form's secret: the platform's, this org's own, or not configured. Never a value. */
  secretState?: "platform" | "own" | "unset";
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The id of the node at a value path. */
export function nodeId(segments: readonly Segment[]): string {
  return segments.map((s) => (typeof s === "number" ? `#${s}` : encodeURIComponent(s))).join("/");
}

/** `id` is `ancestor` or inside it. */
export const within = (id: string, ancestor: string): boolean =>
  ancestor === "" || id === ancestor || id.startsWith(`${ancestor}/`);

const secretSeg = (path: string) => `$secret:${path}`;

function localized(v: unknown, locale: Locale): string | undefined {
  if (typeof v === "string") return v;
  if (isObj(v)) {
    const s = v[locale];
    return typeof s === "string" ? s : undefined;
  }
  return undefined;
}

const hintsOf = (js: Obj): Obj => (isObj(js["x-ui"]) ? js["x-ui"] : {});

/** Every `x-ui.secrets[].path` in the schema: those records are drawn per item, not on their own. */
function itemSecretPaths(js: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(js)) {
    for (const x of js) itemSecretPaths(x, out);
  } else if (isObj(js)) {
    for (const [k, v] of Object.entries(js)) {
      if (k === "x-ui") {
        const secrets = isObj(v) && Array.isArray(v.secrets) ? v.secrets : [];
        for (const s of secrets) if (isObj(s) && typeof s.path === "string") out.add(s.path);
      } else itemSecretPaths(v, out);
    }
  }
  return out;
}

interface BuildCtx {
  locale: Locale;
  hidden: Set<string>;
}

interface Place {
  key: string;
  required: boolean;
  fieldPath: string;
  underArray: boolean;
  secret: boolean;
}

/** `anyOf` / `oneOf` with one non-null member is that member (nullable); other unions are JSON. */
function unwrapUnion(js: Obj): Obj | null {
  const union = Array.isArray(js.anyOf) ? js.anyOf : Array.isArray(js.oneOf) ? js.oneOf : null;
  if (union === null) return js;
  const members = union.filter((m) => !(isObj(m) && m.type === "null"));
  const only = members[0];
  if (members.length !== 1 || !isObj(only)) return null;
  const { anyOf: _a, oneOf: _o, ...rest } = js;
  return { ...only, ...rest };
}

function base(js: Obj, place: Place, ctx: BuildCtx, labelFallback?: string): NodeBase {
  const h = hintsOf(js);
  const label =
    localized(h.label, ctx.locale) ??
    (typeof js.title === "string" ? js.title : undefined) ??
    (place.key || labelFallback || "");
  const help =
    localized(h.help, ctx.locale) ??
    (typeof js.description === "string" ? js.description : undefined);
  const placeholder = localized(h.placeholder, ctx.locale);
  return {
    key: place.key,
    label,
    ...(help !== undefined && { help }),
    ...(placeholder !== undefined && { placeholder }),
    required: place.required,
    advanced: h.advanced === true,
    ...(typeof h.section === "string" && { section: h.section }),
    hot: js["x-hot"] === true,
    fieldPath: place.fieldPath,
    ...(js.default !== undefined && { default: js.default }),
  };
}

const typeOf = (js: Obj): string | undefined =>
  typeof js.type === "string"
    ? js.type
    : Array.isArray(js.type)
      ? (js.type.find((t) => t !== "null") as string | undefined)
      : undefined;

function scalarType(js: Obj): ScalarNode["type"] | undefined {
  const t = typeOf(js);
  if (t === "string" || t === "number" || t === "integer" || t === "boolean") return t;
  if (Array.isArray(js.enum) && js.enum.length > 0) {
    const first = js.enum[0];
    if (typeof first === "string") return "string";
    if (typeof first === "number") return "number";
    if (typeof first === "boolean") return "boolean";
  }
  return undefined;
}

function buildScalar(js: Obj, place: Place, ctx: BuildCtx, labelFallback?: string): ScalarNode {
  const h = hintsOf(js);
  const type = scalarType(js) ?? "string";
  const hinted = Array.isArray(h.options) ? h.options.filter(isObj) : [];
  const enumValues = Array.isArray(js.enum) ? js.enum : undefined;
  const options = enumValues?.map((value): ScalarOption => {
    const o = hinted.find((x) => x.value === value);
    const label = (o && localized(o.label, ctx.locale)) ?? String(value);
    const help = o ? localized(o.help, ctx.locale) : undefined;
    return { token: JSON.stringify(value), value, label, ...(help !== undefined && { help }) };
  });
  const wanted = typeof h.widget === "string" ? (h.widget as ConfigWidget) : undefined;
  const widget: ConfigWidget =
    options !== undefined
      ? wanted === "radio"
        ? "radio"
        : "select"
      : type === "boolean"
        ? wanted === "checkbox" || wanted === "tristate"
          ? wanted
          : "switch"
        : type === "string"
          ? wanted === "url" || wanted === "textarea"
            ? wanted
            : "text"
          : "number";
  const unit = localized(h.unit, ctx.locale);
  return {
    ...base(js, place, ctx, labelFallback),
    kind: "scalar",
    type,
    widget,
    ...(options !== undefined && { options }),
    ...(unit !== undefined && { unit }),
    ...(isNum(js.minimum) && { minimum: js.minimum }),
    ...(isNum(js.exclusiveMinimum) && { exclusiveMinimum: js.exclusiveMinimum }),
    ...(isNum(js.maximum) && { maximum: js.maximum }),
    ...(isNum(js.exclusiveMaximum) && { exclusiveMaximum: js.exclusiveMaximum }),
    ...(isNum(js.minLength) && { minLength: js.minLength }),
    ...(isNum(js.maxLength) && { maxLength: js.maxLength }),
  };
}

const isScalarSchema = (js: unknown): js is Obj => {
  if (!isObj(js)) return false;
  const u = unwrapUnion(js);
  return u !== null && u["x-unsupported"] !== true && scalarType(u) !== undefined;
};

/** Stable sort by `x-ui.order` (default 0): equal keys keep declaration order. */
function ordered(entries: { node: ConfigNode; order: number }[]): ConfigNode[] {
  return entries
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map((e) => e.node);
}

function buildNode(
  raw: unknown,
  place: Place,
  ctx: BuildCtx,
  labelFallback?: string,
): ConfigNode | null {
  if (!place.underArray && place.fieldPath !== "" && ctx.hidden.has(place.fieldPath)) return null;
  const outer = isObj(raw) ? raw : {};
  const js = unwrapUnion(outer);
  if (js === null) return { ...base(outer, place, ctx, labelFallback), kind: "json" };
  const secret = place.secret || js["x-secret"] === true;
  const type = typeOf(js);
  const props = isObj(js.properties) ? js.properties : undefined;
  const addl = js.additionalProperties;

  if (js["x-unsupported"] === true) return { ...base(js, place, ctx, labelFallback), kind: "json" };

  if (type === "object" && props !== undefined && Object.keys(props).length > 0) {
    return buildObject(js, { ...place, secret }, ctx, labelFallback);
  }
  if (secret) {
    const shape: SecretNode["shape"] =
      type === "string"
        ? "string"
        : type === "number" || type === "integer"
          ? "number"
          : type === "object" && isObj(addl) && scalarType(addl) === "string"
            ? "record"
            : "json";
    return { ...base(js, place, ctx, labelFallback), kind: "secret", shape };
  }
  if (type === "object") {
    if (isObj(addl) && isScalarSchema(addl)) {
      const value = buildScalar(
        unwrapUnion(addl) ?? addl,
        { ...place, key: "", required: true },
        ctx,
      );
      return { ...base(js, place, ctx, labelFallback), kind: "record", value };
    }
    return { ...base(js, place, ctx, labelFallback), kind: "json" };
  }
  if (type === "array") {
    if (!isObj(js.items) || Array.isArray(js.prefixItems))
      return { ...base(js, place, ctx, labelFallback), kind: "json" };
    return buildArray(js, place, ctx, labelFallback);
  }
  if (scalarType(js) !== undefined) return buildScalar(js, place, ctx, labelFallback);
  return { ...base(js, place, ctx, labelFallback), kind: "json" };
}

function buildObject(js: Obj, place: Place, ctx: BuildCtx, labelFallback?: string): ObjectNode {
  const h = hintsOf(js);
  const props = js.properties as Obj;
  const required = new Set(Array.isArray(js.required) ? js.required.map(String) : []);
  const entries: { node: ConfigNode; order: number }[] = [];
  for (const [key, child] of Object.entries(props)) {
    const node = buildNode(
      child,
      {
        key,
        required: required.has(key),
        fieldPath: place.underArray
          ? place.fieldPath
          : place.fieldPath === ""
            ? key
            : `${place.fieldPath}.${key}`,
        underArray: place.underArray,
        secret: place.secret,
      },
      ctx,
    );
    if (node === null) continue;
    const ui = isObj(child) ? hintsOf(child) : {};
    entries.push({ node, order: isNum(ui.order) ? ui.order : 0 });
  }
  const sections = (Array.isArray(h.sections) ? h.sections.filter(isObj) : []).flatMap(
    (s): ConfigSection[] => {
      if (typeof s.id !== "string") return [];
      const label = localized(s.label, ctx.locale) ?? s.id;
      const help = localized(s.help, ctx.locale);
      return [{ id: s.id, label, ...(help !== undefined && { help }) }];
    },
  );
  const messages: Record<string, string> = {};
  if (isObj(h.messages)) {
    for (const [k, v] of Object.entries(h.messages)) {
      const text = localized(v, ctx.locale);
      if (text !== undefined) messages[k] = text;
    }
  }
  return {
    ...base(js, place, ctx, labelFallback),
    kind: "object",
    children: ordered(entries),
    layout: h.layout === "row" ? "row" : "stack",
    sections,
    messages,
  };
}

function buildArray(js: Obj, place: Place, ctx: BuildCtx, labelFallback?: string): ConfigNode {
  const h = hintsOf(js);
  const own = base(js, place, ctx, labelFallback);
  const itemPlace: Place = { ...place, key: "", required: true, underArray: true };
  let item = buildNode(js.items, itemPlace, ctx, own.label) ?? {
    ...base({}, itemPlace, ctx, own.label),
    kind: "json" as const,
  };
  // Arrays of arrays, records or secrets have no list control: one JSON textarea for the array.
  if (item.kind !== "object" && item.kind !== "scalar") return { ...own, kind: "json" };
  if (item.kind === "object" && Array.isArray(h.secrets)) {
    const children = [...item.children];
    for (const s of h.secrets.filter(isObj)) {
      if (typeof s.path !== "string" || typeof s.keyBy !== "string") continue;
      const help = localized(s.help, ctx.locale);
      const placeholder = localized(s.placeholder, ctx.locale);
      const node: ItemSecretNode = {
        kind: "itemSecret",
        key: secretSeg(s.path),
        label: localized(s.label, ctx.locale) ?? s.path,
        ...(help !== undefined && { help }),
        ...(placeholder !== undefined && { placeholder }),
        required: false,
        advanced: false,
        hot: false,
        fieldPath: s.path,
        path: s.path,
        keyBy: s.keyBy,
      };
      const after = typeof s.after === "string" ? children.findIndex((c) => c.key === s.after) : -1;
      children.splice(after >= 0 ? after + 1 : children.length, 0, node);
    }
    item = { ...item, children };
  }
  const itemHints = isObj(h.item) ? h.item : {};
  const addLabel = localized(itemHints.addLabel, ctx.locale);
  const presets = (Array.isArray(h.presets) ? h.presets.filter(isObj) : []).flatMap(
    (p): ConfigPreset[] => {
      if (typeof p.id !== "string" || !isObj(p.values)) return [];
      const help = localized(p.help, ctx.locale);
      return [
        {
          id: p.id,
          label: localized(p.label, ctx.locale) ?? p.id,
          ...(help !== undefined && { help }),
          values: p.values,
        },
      ];
    },
  );
  return {
    ...own,
    kind: "array",
    item,
    ...(typeof itemHints.title === "string" && { title: itemHints.title }),
    ...(typeof itemHints.subtitle === "string" && { subtitle: itemHints.subtitle }),
    ...(addLabel !== undefined && { addLabel }),
    reorder: itemHints.reorder === true,
    presets,
    ...(isNum(js.minItems) && { minItems: js.minItems }),
    ...(isNum(js.maxItems) && { maxItems: js.maxItems }),
  };
}

/** JSON Schema + `x-ui` → the node tree (always an object root; an empty schema has no children). */
export function buildTree(schema: JsonSchema | null | undefined, locale: Locale): ObjectNode {
  const js = isObj(schema) ? schema : {};
  const ctx: BuildCtx = { locale, hidden: itemSecretPaths(js) };
  const place: Place = { key: "", required: true, fieldPath: "", underArray: false, secret: false };
  const props = isObj(js.properties) ? js.properties : {};
  return buildObject({ ...js, properties: props }, place, ctx);
}

// ---------------------------------------------------------------------------------------------
// Drafts

let seq = 0;
/** A fresh item key. */
export const newItemKey = (): string => `item-${++seq}`;

const toText = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : String(v);

/** A value → the draft the inputs hold (secrets always start as "keep"). */
export function toDraft(node: ConfigNode, value: unknown): Draft {
  const v = value === undefined ? node.default : value;
  switch (node.kind) {
    case "scalar":
      if (node.type === "boolean" && node.options === undefined)
        return { t: "bool", value: typeof v === "boolean" ? v : undefined };
      if (node.options !== undefined) {
        const o = v === undefined ? undefined : node.options.find((x) => x.value === v);
        return { t: "text", text: o?.token ?? "" };
      }
      return { t: "text", text: toText(v) };
    case "object": {
      const obj = isObj(v) ? v : {};
      const fields: Record<string, Draft> = {};
      for (const c of node.children) {
        if (c.kind === "itemSecret") {
          const k = obj[c.keyBy];
          fields[c.key] = {
            t: "itemSecret",
            op: "keep",
            text: "",
            origKey: typeof k === "string" && k !== "" ? k : undefined,
          };
        } else fields[c.key] = toDraft(c, obj[c.key]);
      }
      return { t: "object", fields };
    }
    case "array": {
      const list = Array.isArray(v) ? v : [];
      if (node.item.kind === "scalar") return { t: "text", text: list.map(toText).join("\n") };
      return {
        t: "array",
        items: list.map((x) => ({ key: newItemKey(), draft: toDraft(node.item, x) })),
      };
    }
    case "record":
      return {
        t: "record",
        rows: Object.entries(isObj(v) ? v : {}).map(([k, x]): [string, string] => [k, toText(x)]),
      };
    case "secret":
      // A secret never comes back from the kernel: a value here is one typed and not saved yet
      // (a wizard step drawn again), so it starts as that new value.
      if (typeof value === "string" || typeof value === "number")
        return { t: "secret", op: "set", text: String(value), rows: [] };
      if (isObj(value) && node.shape === "record")
        return {
          t: "secret",
          op: "set",
          text: "",
          rows: Object.entries(value).map(([k, x]): [string, string] => [k, toText(x)]),
        };
      if (value !== undefined && value !== null && node.shape === "json")
        return { t: "secret", op: "set", text: JSON.stringify(value, null, 2), rows: [] };
      return { t: "secret", op: "keep", text: "", rows: [] };
    case "itemSecret":
      return { t: "itemSecret", op: "keep", text: "", origKey: undefined };
    case "json":
      return { t: "text", text: v === undefined ? "" : JSON.stringify(v, null, 2) };
  }
}

/** The draft of a new array item: prefilled from a preset's values; its secrets are new keys. */
export function newItemDraft(node: ArrayNode, values?: Record<string, unknown>): Draft {
  const draft = toDraft(node.item, values);
  if (draft.t !== "object") return draft;
  const fields: Record<string, Draft> = {};
  for (const [k, d] of Object.entries(draft.fields))
    fields[k] = d.t === "itemSecret" ? { ...d, origKey: undefined } : d;
  return { t: "object", fields };
}

export interface FromDraftOptions {
  /** A secret field already has a value (a required secret left as "keep" is then fine). */
  secretSet?(fieldPath: string): boolean;
}

type Result = { value: unknown; problems: NodeProblem[] };

function problem(
  node: ConfigNode,
  segments: Segment[],
  kind: ProblemKind,
  limit?: number,
): NodeProblem {
  return {
    id: nodeId(segments),
    segments,
    kind,
    label: node.label,
    ...(limit !== undefined && { limit }),
  };
}

const mustHave = (node: ConfigNode) => node.required && node.default === undefined;

function parseScalar(
  node: ScalarNode,
  text: string,
  segs: Segment[],
): { value?: unknown; problem?: NodeProblem } {
  if (node.options !== undefined) {
    const o = node.options.find((x) => x.token === text);
    return o ? { value: o.value } : { value: text };
  }
  if (node.type === "number" || node.type === "integer") {
    const n = Number(text.trim());
    if (text.trim() === "" || !Number.isFinite(n))
      return { problem: problem(node, segs, "number") };
    if (node.type === "integer" && !Number.isInteger(n))
      return { problem: problem(node, segs, "integer") };
    if (node.minimum !== undefined && n < node.minimum)
      return { problem: problem(node, segs, "min", node.minimum) };
    if (node.exclusiveMinimum !== undefined && n <= node.exclusiveMinimum)
      return { problem: problem(node, segs, "gt", node.exclusiveMinimum) };
    if (node.maximum !== undefined && n > node.maximum)
      return { problem: problem(node, segs, "max", node.maximum) };
    if (node.exclusiveMaximum !== undefined && n >= node.exclusiveMaximum)
      return { problem: problem(node, segs, "lt", node.exclusiveMaximum) };
    return { value: n };
  }
  if (node.type === "boolean") return { value: text === "true" };
  if (node.minLength !== undefined && text.length < node.minLength)
    return { problem: problem(node, segs, "minLength", node.minLength) };
  if (node.maxLength !== undefined && text.length > node.maxLength)
    return { problem: problem(node, segs, "maxLength", node.maxLength) };
  return { value: text };
}

/** A draft → the value to save and the client-side problems (required, type, limits). */
export function fromDraft(
  node: ConfigNode,
  draft: Draft,
  opts: FromDraftOptions = {},
  segments: Segment[] = [],
): Result {
  const none: Result = { value: undefined, problems: [] };
  const missing = (): Result =>
    mustHave(node) ? { value: undefined, problems: [problem(node, segments, "required")] } : none;
  switch (node.kind) {
    case "scalar": {
      if (draft.t === "bool") {
        if (draft.value !== undefined) return { value: draft.value, problems: [] };
        return mustHave(node) ? { value: false, problems: [] } : none;
      }
      const text = draft.t === "text" ? draft.text : "";
      if (text === "" || (node.type !== "string" && text.trim() === "")) return missing();
      const r = parseScalar(node, text, segments);
      return r.problem
        ? { value: undefined, problems: [r.problem] }
        : { value: r.value, problems: [] };
    }
    case "object": {
      const fields = draft.t === "object" ? draft.fields : {};
      const out: Obj = {};
      const problems: NodeProblem[] = [];
      for (const c of node.children) {
        if (c.kind === "itemSecret") continue;
        const r = fromDraft(c, fields[c.key] ?? toDraft(c, undefined), opts, [...segments, c.key]);
        if (r.value !== undefined) out[c.key] = r.value;
        problems.push(...r.problems);
      }
      // An optional object left entirely empty is absent (its own required fields don't apply).
      if (segments.length > 0 && !node.required && Object.keys(out).length === 0) return none;
      return { value: out, problems };
    }
    case "array": {
      if (node.item.kind === "scalar") {
        const item = node.item;
        const lines = (draft.t === "text" ? draft.text : "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "");
        const values: unknown[] = [];
        const problems: NodeProblem[] = [];
        for (const l of lines) {
          const r = parseScalar(item, l, segments);
          if (r.problem) problems.push({ ...r.problem, label: node.label });
          else values.push(r.value);
        }
        problems.push(...countProblems(node, values.length, segments));
        if (values.length === 0 && !node.required && problems.length === 0) return none;
        return { value: values, problems };
      }
      const items = draft.t === "array" ? draft.items : [];
      const values: unknown[] = [];
      const problems: NodeProblem[] = [];
      items.forEach((it, i) => {
        const r = fromDraft(node.item, it.draft, opts, [...segments, i]);
        values.push(r.value ?? {});
        problems.push(...r.problems);
      });
      problems.push(...countProblems(node, values.length, segments));
      if (values.length === 0 && !node.required && problems.length === 0) return none;
      return { value: values, problems };
    }
    case "record": {
      const rows = draft.t === "record" ? draft.rows : [];
      const out: Obj = {};
      const problems: NodeProblem[] = [];
      for (const [k, text] of rows) {
        if (k.trim() === "") continue;
        const r = parseScalar(node.value, text, [...segments, k]);
        if (r.problem) problems.push({ ...r.problem, id: nodeId(segments), label: node.label });
        else out[k] = r.value;
      }
      if (Object.keys(out).length === 0 && !node.required && problems.length === 0) return none;
      return { value: out, problems };
    }
    case "secret": {
      if (draft.t !== "secret") return none;
      const isSet = opts.secretSet?.(node.fieldPath) === true;
      if (draft.op === "clear") return { value: null, problems: [] };
      if (draft.op === "set") {
        if (node.shape === "record") {
          const out: Obj = {};
          for (const [k, v] of draft.rows) if (k.trim() !== "" && v !== "") out[k] = v;
          if (Object.keys(out).length > 0) return { value: out, problems: [] };
        } else if (draft.text !== "") {
          if (node.shape === "string") return { value: draft.text, problems: [] };
          if (node.shape === "number") {
            const n = Number(draft.text);
            return Number.isFinite(n)
              ? { value: n, problems: [] }
              : { value: undefined, problems: [problem(node, segments, "number")] };
          }
          try {
            return { value: JSON.parse(draft.text), problems: [] };
          } catch {
            return { value: undefined, problems: [problem(node, segments, "json")] };
          }
        }
      }
      return isSet ? none : missing();
    }
    case "itemSecret":
      return none;
    case "json": {
      const text = draft.t === "text" ? draft.text : "";
      if (text.trim() === "") return missing();
      try {
        return { value: JSON.parse(text), problems: [] };
      } catch {
        return { value: undefined, problems: [problem(node, segments, "json")] };
      }
    }
  }
}

function countProblems(node: ArrayNode, n: number, segments: Segment[]): NodeProblem[] {
  if (node.minItems !== undefined && n < node.minItems)
    return [problem(node, segments, "minItems", node.minItems)];
  if (node.maxItems !== undefined && n > node.maxItems)
    return [problem(node, segments, "maxItems", node.maxItems)];
  return [];
}

// ---------------------------------------------------------------------------------------------
// Secret entries

interface ItemSecretState {
  path: string;
  name: string;
  op: SecretOp;
  text: string;
  origKey: string | undefined;
}

/** Every secret drawn per item in a draft, with the item's current key (`keyBy`). */
function itemSecrets(node: ConfigNode, draft: Draft | undefined, out: ItemSecretState[] = []) {
  if (draft === undefined) return out;
  if (node.kind === "object" && draft.t === "object") {
    for (const c of node.children) {
      const d = draft.fields[c.key];
      if (c.kind === "itemSecret" && d?.t === "itemSecret") {
        const nameDraft = draft.fields[c.keyBy];
        out.push({
          path: c.path,
          name: nameDraft?.t === "text" ? nameDraft.text : "",
          op: d.op,
          text: d.text,
          origKey: d.origKey,
        });
      } else itemSecrets(c, d, out);
    }
  } else if (node.kind === "array" && draft.t === "array") {
    for (const it of draft.items) itemSecrets(node.item, it.draft, out);
  }
  return out;
}

/**
 * The `secretEntries` of a deployment save: keys set or cleared in an item, renamed items
 * (`renameFrom`, keeping the value), removed items (`value: null`). `baseline` is the draft the
 * form opened with (which keys belonged to an item then).
 */
export function secretEntries(
  root: ConfigNode,
  draft: Draft,
  baseline: Draft,
  meta: Record<string, FieldMeta> = {},
): ConfigSecretEntry[] {
  const now = itemSecrets(root, draft);
  const before = itemSecrets(root, baseline);
  const out: ConfigSecretEntry[] = [];
  for (const path of new Set([...before, ...now].map((x) => x.path))) {
    const keys = new Set(meta[path]?.secretKeys ?? []);
    const cur = now.filter((n) => n.path === path);
    // 1. Keys whose item is gone.
    for (const b of before) {
      if (b.path !== path || b.origKey === undefined || !keys.has(b.origKey)) continue;
      if (cur.some((n) => n.origKey === b.origKey)) continue;
      out.push({ path, key: b.origKey, value: null });
    }
    // 2. Renames (a key moves with its item), carrying a new value or a clear when there is one.
    const moves: Move[] = [];
    const rest: ItemSecretState[] = [];
    for (const n of cur) {
      const had = n.origKey !== undefined && keys.has(n.origKey);
      if (had && n.origKey !== undefined && n.name !== "" && n.name !== n.origKey) {
        const value =
          n.op === "set" && n.text !== "" ? n.text : n.op === "clear" ? null : undefined;
        moves.push({ from: n.origKey, to: n.name, ...(value !== undefined && { value }) });
      } else rest.push(n);
    }
    const taken = new Set([...keys, ...cur.map((n) => n.name)]);
    out.push(...orderedMoves(path, moves, taken));
    // 3. Values set or cleared in place, and keys of new items.
    for (const n of rest) {
      const had = n.origKey !== undefined && keys.has(n.origKey);
      if (n.op === "set" && n.text !== "" && n.name !== "")
        out.push({ path, key: n.name, value: n.text });
      else if (n.op === "clear" && had && n.origKey !== undefined)
        out.push({ path, key: n.origKey, value: null });
    }
  }
  return out;
}

interface Move {
  from: string;
  to: string;
  value?: string | null;
}

/**
 * Renames in an order the kernel can apply one after another (a rename onto a key replaces it):
 * a move whose target is still the source of another pending move waits for that one (a chain
 * `A→B, B→C` sends `B→C` first). A cycle (`A↔B`) parks one value under a temporary key that no
 * item uses, moves the others, then moves the parked value to its target; the whole list is
 * applied in one transaction, so the temporary key never persists.
 */
function orderedMoves(path: string, moves: Move[], taken: Set<string>): ConfigSecretEntry[] {
  const out: ConfigSecretEntry[] = [];
  const entry = (m: Move): ConfigSecretEntry => ({
    path,
    key: m.to,
    renameFrom: m.from,
    ...(m.value !== undefined && { value: m.value }),
  });
  let pending = [...moves];
  let n = 0;
  while (pending.length > 0) {
    const sources = new Set(pending.map((m) => m.from));
    const ready = pending.find((m) => !sources.has(m.to));
    if (ready !== undefined) {
      out.push(entry(ready));
      pending = pending.filter((m) => m !== ready);
      continue;
    }
    // Every target is still a source: a cycle. Park the first move's value.
    const first = pending[0] as Move;
    let temp = `$rename-${n++}`;
    while (taken.has(temp)) temp = `$rename-${n++}`;
    taken.add(temp);
    out.push({ path, key: temp, renameFrom: first.from });
    pending = [{ ...first, from: temp }, ...pending.slice(1)];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Issues

/** Finds the item secret of record `path` whose item's `keyBy` is `key`. */
function findItemSecret(
  node: ConfigNode,
  value: unknown,
  path: string,
  key: string,
  segs: Segment[],
): string | null {
  if (node.kind === "object") {
    const obj = isObj(value) ? value : {};
    for (const c of node.children) {
      if (c.kind === "itemSecret") {
        if (c.path === path && obj[c.keyBy] === key) return nodeId([...segs, c.key]);
        continue;
      }
      const hit = findItemSecret(c, obj[c.key], path, key, [...segs, c.key]);
      if (hit !== null) return hit;
    }
  } else if (node.kind === "array" && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findItemSecret(node.item, value[i], path, key, [...segs, i]);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** The record paths drawn per item (`x-ui.secrets[].path`) somewhere in the tree. */
export function allItemSecretPaths(node: ConfigNode, out = new Set<string>()): Set<string> {
  if (node.kind === "object")
    for (const c of node.children) {
      if (c.kind === "itemSecret") out.add(c.path);
      else allItemSecretPaths(c, out);
    }
  else if (node.kind === "array") allItemSecretPaths(node.item, out);
  return out;
}

/** The node an issue path lands on; null = the form itself. */
function locate(
  node: ConfigNode,
  value: unknown,
  segs: readonly Segment[],
  at: Segment[],
): string | null {
  const [s, ...rest] = segs;
  if (s === undefined) return at.length === 0 ? null : nodeId(at);
  switch (node.kind) {
    case "object": {
      const child =
        typeof s === "string"
          ? node.children.find((c) => c.kind !== "itemSecret" && c.key === s)
          : undefined;
      if (child === undefined) return null;
      return locate(child, isObj(value) ? value[s as string] : undefined, rest, [...at, s]);
    }
    case "array": {
      // A dotted path (no segments) carries indexes as text.
      const i = typeof s === "number" ? s : /^\d+$/.test(s) ? Number(s) : -1;
      if (node.item.kind === "object" && Array.isArray(value) && i >= 0 && i < value.length)
        return locate(node.item, value[i], rest, [...at, i]);
      return nodeId(at);
    }
    default:
      return nodeId(at);
  }
}

const segmentsOf = (issue: ConfigIssue): Segment[] =>
  issue.segments ?? (issue.path === "" ? [] : issue.path.split("."));

/**
 * Server issues → messages per node id (`byNode`), and the ones no node takes (`form`).
 * `endpoints.0.models.1.documents` lands on that checkbox; `apiKeys.<name>` on the key input of
 * the item named `<name>`; an array-level issue on the repeater. `messageKey` picks the hint
 * message (root `x-ui.messages`, already localized in the tree).
 */
export function mapIssues(
  root: ObjectNode,
  value: unknown,
  issues: readonly ConfigIssue[],
): { byNode: Map<string, string>; form: string[] } {
  const byNode = new Map<string, string>();
  const form: string[] = [];
  const recordPaths = allItemSecretPaths(root);
  for (const issue of issues) {
    const message =
      (issue.messageKey !== undefined ? root.messages[issue.messageKey] : undefined) ??
      issue.message;
    const segs = segmentsOf(issue);
    let id: string | null = null;
    for (const p of recordPaths) {
      const ps = p.split(".");
      const key = segs[ps.length];
      if (segs.length === ps.length + 1 && ps.every((x, i) => segs[i] === x) && key !== undefined)
        id = findItemSecret(root, value, p, String(key), []);
    }
    id ??= locate(root, value, segs, []);
    if (id === null) form.push(issue.path === "" ? message : `${issue.path}: ${message}`);
    else if (!byNode.has(id)) byNode.set(id, message);
  }
  return { byNode, form };
}

// ---------------------------------------------------------------------------------------------
// Helpers for the form

/** `{field}` template from the item's own fields; blank when every field is empty. */
export function itemText(template: string | undefined, item: unknown): string {
  if (template === undefined) return "";
  const obj = isObj(item) ? item : {};
  return template
    .replace(/\{([^{}]+)\}/g, (_, f: string) => {
      const v = obj[f];
      return typeof v === "string" || typeof v === "number" ? String(v) : "";
    })
    .trim();
}

/** Reads a dot path of a value. */
export function getPath(value: unknown, path: string): unknown {
  let at = value;
  for (const seg of path === "" ? [] : path.split(".")) {
    if (!isObj(at)) return undefined;
    at = at[seg];
  }
  return at;
}

/** Sets a dot path, creating objects on the way (returns a copy). */
export function setPath(value: Obj, path: string, v: unknown): Obj {
  const [head, ...rest] = path.split(".");
  if (head === undefined) return value;
  if (rest.length === 0) return { ...value, [head]: v };
  const inner = isObj(value[head]) ? (value[head] as Obj) : {};
  return { ...value, [head]: setPath(inner, rest.join("."), v) };
}

/** Structural equality of JSON values. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => sameJson(a[k], b[k]));
  }
  return false;
}

/** The schema draws at least one field (an object with properties). */
export function hasConfigFields(schema: JsonSchema | null | undefined): boolean {
  return isObj(schema) && isObj(schema.properties) && Object.keys(schema.properties).length > 0;
}
