import { checkParamValue, type ParamSchema } from "./model-params.js";
import { isHttpUrl } from "./url.js";

/** Tool annotations (hints aligned with MCP, used to derive the default policy). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  requiresUserInteraction?: boolean;
}

/** Where a conversation comes from; a tool may limit itself to some of these. */
export const CONVERSATION_SOURCES = ["web", "channel_dm", "channel_group", "subagent"] as const;

/** A conversation source (see {@link CONVERSATION_SOURCES}). */
export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  /**
   * Only plugin / builtin tools may declare it; when omitted it is derived from the annotations.
   */
  defaultPolicy?: "allow" | "ask";
  /**
   * Connector tools only: the connector's own opaque data (e.g. OpenAPI's method, path template,
   * parameter locations, server address), JSON-serializable.
   * The kernel stores it with the definition in the snapshot and counts it in the fingerprint (a
   * change means drift and needs review), and hands it back unchanged via `ctx.spec` of `callTool`
   * on a call;
   * never sent to the model.
   */
  connectorData?: Record<string, unknown>;
  /**
   * Display only: a short human title shown on the tool's row instead of its key, e.g. the MCP
   * `title` ("Search messages"); 1–80 characters, one line, with no control, bidi or invisible
   * characters (Unicode Cc / Cf). Never sent to the model and not part of the definition
   * fingerprint, so adding or changing it never triggers drift review.
   */
  title?: string;
  /**
   * Display only: up to 3 input property names whose values the tool's row shows, in order, e.g.
   * `["query", "channel"]`. Each must be a property of `inputSchema.properties`. Never sent to the
   * model and not part of the definition fingerprint.
   */
  keyArgs?: string[];
  /**
   * The conversation sources this tool is offered in; absent = every source. A non-empty list of
   * {@link CONVERSATION_SOURCES}.
   */
  sources?: ConversationSource[];
}

/** Longest {@link ToolSpec.title}, in code points. */
export const TOOL_TITLE_MAX = 80;
/** Most {@link ToolSpec.keyArgs}. */
export const TOOL_KEY_ARGS_MAX = 3;

/**
 * Control (Cc) and format (Cf) characters: newlines, C0 / C1 controls, bidi marks, overrides and
 * isolates (U+061C, U+200E/F, U+202A–202E, U+2066–2069), invisible ones (U+200B, U+2060, U+FEFF)
 * and tag characters. They could reorder, hide or break a one-line label, so display titles and key
 * argument names never carry them. ZWNJ (U+200C) and ZWJ (U+200D) are allowed: Persian and other
 * scripts and emoji sequences need them.
 */
const CONTROL_OR_FORMAT = /(?![\u200C\u200D])[\p{Cc}\p{Cf}]/u;

/**
 * Checks the display-only {@link ToolSpec.title} and {@link ToolSpec.keyArgs}; returns the problems
 * (empty = valid). The title is 1–80 code points, not blank and free of control and format
 * characters (Unicode Cc / Cf); keyArgs are at most 3 unique strings, each a property of
 * `inputSchema.properties` and free of Cc / Cf characters.
 */
export function validateToolPresentation(
  spec: Pick<ToolSpec, "title" | "keyArgs" | "inputSchema">,
): string[] {
  const out: string[] = [];
  const title: unknown = spec.title;
  if (
    title !== undefined &&
    (typeof title !== "string" || title.trim() === "" || [...title].length > TOOL_TITLE_MAX)
  ) {
    out.push(`title must be a non-blank string of at most ${TOOL_TITLE_MAX} characters`);
  } else if (typeof title === "string" && CONTROL_OR_FORMAT.test(title)) {
    out.push("title must not contain control, bidi or invisible characters");
  }
  const keyArgs: unknown = spec.keyArgs;
  if (keyArgs === undefined) return out;
  if (!Array.isArray(keyArgs) || keyArgs.some((k) => typeof k !== "string")) {
    out.push("keyArgs must be an array of input property names");
    return out;
  }
  if (keyArgs.length > TOOL_KEY_ARGS_MAX)
    out.push(`keyArgs must name at most ${TOOL_KEY_ARGS_MAX} input properties`);
  if (new Set(keyArgs).size !== keyArgs.length) out.push("keyArgs must not repeat a name");
  if ((keyArgs as string[]).some((k) => CONTROL_OR_FORMAT.test(k)))
    out.push("keyArgs names must not contain control, bidi or invisible characters");
  const schema = spec.inputSchema as { properties?: unknown } | null | undefined;
  const props =
    typeof schema?.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};
  for (const k of keyArgs as string[]) {
    if (!Object.hasOwn(props, k))
      out.push(`keyArgs names "${k}", which is not a property of inputSchema`);
  }
  return out;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string };

/**
 * A one-sentence description of a tool call, shown in the UI (Chinese and English each ≤ 200
 * characters); does not enter the model context.
 */
export interface ToolDisplay {
  summary: { zh: string; en: string };
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  /** Optional: show this description in the conversation stream in place of the raw input JSON. */
  display?: ToolDisplay;
  /**
   * Optional: an inline card under this call in the conversation: `view` is a ui contribution of
   * the same extension in the `conversation.tool-result.card` slot, rendered with
   * `card: { callId, key }`. Display only (recorded on the `tool_result` event, never in the model's
   * context); an unknown view is dropped with a warning and the result is kept.
   */
  card?: { view: string; key?: string };
}

const DISPLAY_MAX = 200;

/**
 * Validates a {@link ToolDisplay} and returns the list of problems (empty = valid); length is
 * counted in Unicode code points.
 */
export function validateToolDisplay(d: unknown): string[] {
  if (typeof d !== "object" || d === null || Array.isArray(d)) return ["display must be an object"];
  const s = (d as Record<string, unknown>).summary;
  if (typeof s !== "object" || s === null || Array.isArray(s))
    return ["display.summary must be an object with zh and en"];
  const out: string[] = [];
  for (const k of ["zh", "en"] as const) {
    const v = (s as Record<string, unknown>)[k];
    if (typeof v !== "string" || v === "" || [...v].length > DISPLAY_MAX)
      out.push(
        `display.summary.${k} must be a non-empty string of at most ${DISPLAY_MAX} characters`,
      );
  }
  return out;
}

/** Text shown to people: bilingual (`zh` / `en`) or a single string shown as is. */
export type LocalizedText = { zh: string; en: string } | string;

/**
 * Interactive form: field schemas use only the ParamSchema subset of M2; enum fields may set
 * multiSelect and allowOther.
 */
export interface InputForm {
  /**
   * A plugin may give both languages; builtin kernel tools give English (model-generated questions
   * are displayed as is).
   */
  title: LocalizedText;
  /**
   * Optional: an external page the user must open in a browser (e.g. an MCP URL-mode elicitation:
   * go to the other party's page to authorize / pay / enter sensitive information).
   * The UI shows it as a link (the full address visible); only absolute http(s) addresses, ≤ 2000
   * characters, are accepted.
   */
  url?: string;
  fields: {
    key: string;
    label: LocalizedText;
    description?: LocalizedText;
    schema: ParamSchema;
    multiSelect?: boolean;
    allowOther?: boolean;
    required?: boolean;
  }[];
}

/**
 * The tool needs user input: the kernel pauses the run and renders a form; after the user submits,
 * the tool is called again with the same input,
 * and state and answer are brought back in ctx.resume. state ≤ 16 KB, JSON-serializable.
 */
export interface InputRequired {
  kind: "input_required";
  form: InputForm;
  state?: unknown;
}

export type FormAnswer = Record<string, string | number | boolean | string[]>;

export interface ToolCallContext {
  orgId: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  callId: string;
  signal: AbortSignal;
  /** null = the user cancelled or it timed out. */
  resume?: { state: unknown; answer: FormAnswer | null };
  /**
   * The extension's effective deployment config for this org: the platform's deployment config
   * with the org's copy applied to the overridable fields (`orgAccess(…, "override")`), or the
   * platform's config (equal to `ctx.config`) while the org follows it. Use it, not `ctx.config`,
   * for work done for this org. Optional in the type so older extensions compile; the kernel
   * always passes it.
   */
  config?: unknown;
  /** Where the conversation comes from. The kernel always passes it. */
  source?: ConversationSource;
  /** The conversation's owner (`conversations.account_id`). The kernel always passes it; `accountId` stays the run's trigger account. */
  ownerAccountId?: string;
  /** The trigger account's role in the org. The kernel always passes it. */
  role?: "owner" | "admin" | "member" | "guest";
}

export type ToolHandler = (
  input: unknown,
  ctx: ToolCallContext,
) => Promise<ToolResult | InputRequired>;

/**
 * Tool error categories:
 * - `error` (default): the remote is available but this call failed (bad parameters, business
 *   error, auth failure, etc.), not counted toward the connector circuit breaker;
 * - `unavailable`: the remote is unavailable (connection / transport error, timeout, HTTP 5xx),
 *   counted toward the connector circuit breaker (connectors use it to tell the kernel).
 */
export type ToolErrorKind = "error" | "unavailable";

/** A tool execution failure: message is for the model and must be in English and actionable. */
export class ToolError extends Error {
  readonly kind: ToolErrorKind;

  constructor(message: string, opts?: { kind?: ToolErrorKind }) {
    super(message);
    this.name = "ToolError";
    this.kind = opts?.kind ?? "error";
  }
}

/** Plugin tool name rule. */
export const EXTENSION_TOOL_NAME = /^[a-zA-Z0-9_-]{1,40}$/;

/**
 * Validates the tool declarations a plugin registers and returns the list of problems (empty =
 * valid).
 */
export function validateToolSpec(spec: ToolSpec): string[] {
  const out: string[] = [];
  if (typeof spec?.name !== "string" || !EXTENSION_TOOL_NAME.test(spec.name))
    out.push(`name must match ${EXTENSION_TOOL_NAME}`);
  if (typeof spec?.description !== "string" || spec.description.trim() === "")
    out.push("description must be a non-empty string");
  if (typeof spec?.inputSchema !== "object" || spec.inputSchema === null)
    out.push("inputSchema must be an object");
  if (
    spec?.defaultPolicy !== undefined &&
    spec.defaultPolicy !== "allow" &&
    spec.defaultPolicy !== "ask"
  )
    out.push('defaultPolicy must be "allow" or "ask"');
  if (typeof spec?.inputSchema === "object" && spec.inputSchema !== null)
    out.push(...validateToolPresentation(spec));
  const sources: unknown = spec?.sources;
  if (
    sources !== undefined &&
    (!Array.isArray(sources) ||
      sources.length === 0 ||
      sources.some((s) => !(CONVERSATION_SOURCES as readonly unknown[]).includes(s)))
  )
    out.push(`sources must be a non-empty list of ${CONVERSATION_SOURCES.join(", ")}`);
  return out;
}

const SCHEMA_KEYS: Record<string, readonly string[]> = {
  string: ["type", "enum", "maxLength"],
  boolean: ["type"],
  number: ["type", "minimum", "maximum"],
  integer: ["type", "minimum", "maximum"],
};

/** Checks whether a schema falls within the ParamSchema subset and returns the list of problems. */
function schemaProblems(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema))
    return ["schema must be an object"];
  const s = schema as Record<string, unknown>;
  const allowed = typeof s.type === "string" ? SCHEMA_KEYS[s.type] : undefined;
  if (!allowed) return [`unsupported schema type ${JSON.stringify(s.type)}`];
  const out: string[] = [];
  for (const k of Object.keys(s))
    if (!allowed.includes(k)) out.push(`unsupported schema keyword "${k}"`);
  if ("enum" in s) {
    if (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.some((x) => typeof x !== "string"))
      out.push("enum must be a non-empty array of strings");
    if ("maxLength" in s) out.push("enum and maxLength cannot be combined");
  }
  if ("maxLength" in s && (!Number.isInteger(s.maxLength) || (s.maxLength as number) < 0))
    out.push("maxLength must be a non-negative integer");
  for (const k of ["minimum", "maximum"]) {
    if (k in s && (typeof s[k] !== "number" || !Number.isFinite(s[k])))
      out.push(`${k} must be a finite number`);
  }
  if (typeof s.minimum === "number" && typeof s.maximum === "number" && s.minimum > s.maximum)
    out.push("minimum must be <= maximum");
  return out;
}

const isEnum = (s: ParamSchema): s is Extract<ParamSchema, { enum: string[] }> =>
  s.type === "string" && "enum" in s;

/** Validates an interactive form declaration and returns the list of problems (empty = valid). */
export function validateInputForm(form: InputForm): string[] {
  const out: string[] = [];
  if (!form || !Array.isArray(form.fields)) return ["form.fields must be an array"];
  if (form.fields.length === 0) out.push("form must have at least one field");
  if (form.url !== undefined && !isHttpUrl(form.url))
    out.push("url must be an absolute http(s) URL of at most 2000 characters");
  const seen = new Set<string>();
  for (const f of form.fields) {
    const at = `field ${JSON.stringify(f?.key)}`;
    if (typeof f?.key !== "string" || f.key === "") {
      out.push("field key must be a non-empty string");
      continue;
    }
    if (seen.has(f.key)) out.push(`${at}: duplicate key`);
    seen.add(f.key);
    const probs = schemaProblems(f.schema);
    for (const p of probs) out.push(`${at}: ${p}`);
    if (probs.length > 0) continue;
    if ((f.multiSelect || f.allowOther) && !isEnum(f.schema))
      out.push(`${at}: multiSelect and allowOther require a string enum schema`);
  }
  return out;
}

/**
 * Validates whether the answer a user submitted conforms to the form and returns the list of
 * problems (empty = valid).
 */
export function validateAnswer(form: InputForm, answer: FormAnswer): string[] {
  const out: string[] = [];
  const byKey = new Map(form.fields.map((f) => [f.key, f]));
  for (const k of Object.keys(answer))
    if (!byKey.has(k)) out.push(`unknown field ${JSON.stringify(k)}`);
  for (const f of form.fields) {
    const at = `field ${JSON.stringify(f.key)}`;
    // Look only at the answer's own keys: inherited properties such as `toString` / `constructor`
    // do not count as answered
    const v = Object.hasOwn(answer, f.key) ? answer[f.key] : undefined;
    if (v === undefined) {
      if (f.required) out.push(`${at}: is required`);
      continue;
    }
    if (f.multiSelect) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
        out.push(`${at}: must be an array of strings`);
        continue;
      }
      if (f.required && v.length === 0) out.push(`${at}: is required`);
      const seen = new Set<string>();
      for (const item of v) {
        if (seen.has(item)) {
          out.push(`${at}: duplicate value ${JSON.stringify(item)}`);
          continue;
        }
        seen.add(item);
        const why = otherOrValue(f, item);
        if (why) out.push(`${at}: ${why}`);
      }
      continue;
    }
    if (Array.isArray(v)) {
      out.push(`${at}: must not be an array`);
      continue;
    }
    if (f.required && v === "") {
      out.push(`${at}: is required`);
      continue;
    }
    const why = otherOrValue(f, v);
    if (why) out.push(`${at}: ${why}`);
  }
  return out;
}

/**
 * An allowOther enum field accepts any non-empty text; the rest are validated against the schema.
 */
function otherOrValue(f: InputForm["fields"][number], v: unknown): string | undefined {
  if (f.allowOther && isEnum(f.schema)) {
    return typeof v === "string" && v !== "" ? undefined : "other text must be a non-empty string";
  }
  return checkParamValue(f.schema, v);
}
