import { checkParamValue, type ParamSchema } from "./model-params.js";
import type { UiOpen } from "./ui.js";
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

/**
 * How a tool's input is previewed while it streams ({@link ToolSpec.inputView}). Every name is a
 * string property of the tool's `inputSchema`.
 */
export type ToolInputView =
  | { kind: "file_write"; path: string; content: string }
  | { kind: "file_edit"; path: string; old: string; new: string }
  | { kind: "command"; command: string; description?: string }
  | { kind: "text"; field: string };

const INPUT_VIEW_KINDS = ["file_write", "file_edit", "command", "text"] as const;

/** The property names a {@link ToolInputView} refers to, by kind. */
function inputViewFields(view: Record<string, unknown>): unknown[] {
  switch (view.kind) {
    case "file_write":
      return [view.path, view.content];
    case "file_edit":
      return [view.path, view.old, view.new];
    case "command":
      return view.description === undefined ? [view.command] : [view.command, view.description];
    default:
      return [view.field];
  }
}

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
   * Display only: how the UI previews this tool's input while the model is still writing it. Names
   * string properties of `inputSchema` that carry a file body, an edit, a command or free text.
   * Never sent to the model and not part of the definition fingerprint. Nothing streamed ever
   * executes: the call runs from the logged assistant message.
   */
  inputView?: ToolInputView;
  /**
   * The conversation sources this tool is offered in; absent = every source. A non-empty list of
   * {@link CONVERSATION_SOURCES}.
   */
  sources?: ConversationSource[];
  /**
   * Extension tools only: the time limit of one call in milliseconds, a whole number from
   * {@link TOOL_TIMEOUT_MIN_MS} to {@link TOOL_TIMEOUT_MAX_MS}. When declared, the deployment's
   * `tools.timeoutMs` no longer applies to the tool; the deployment's `tools.maxTimeoutMs`
   * (default {@link TOOL_TIMEOUT_MAX_MS}) cuts a longer value. Absent: `tools.timeoutMs`. Declare
   * it when a call may legitimately take longer, e.g. one that first starts a device service
   * (`ctx.deviceAccess.ensureService`). Never sent to the model and not part of the definition
   * fingerprint.
   */
  timeoutMs?: number;
}

/** Shortest {@link ToolSpec.timeoutMs}: one second. */
export const TOOL_TIMEOUT_MIN_MS = 1000;
/** Longest {@link ToolSpec.timeoutMs} the kernel accepts: ten minutes. */
export const TOOL_TIMEOUT_MAX_MS = 600_000;

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
  spec: Pick<ToolSpec, "title" | "keyArgs" | "inputView" | "inputSchema">,
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
  const schema = spec.inputSchema as { properties?: unknown } | null | undefined;
  const props =
    typeof schema?.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};
  out.push(...validateInputView(spec.inputView, props));
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
  for (const k of keyArgs as string[]) {
    if (!Object.hasOwn(props, k))
      out.push(`keyArgs names "${k}", which is not a property of inputSchema`);
  }
  return out;
}

function validateInputView(view: unknown, props: Record<string, unknown>): string[] {
  if (view === undefined) return [];
  const kinds = INPUT_VIEW_KINDS.join(", ");
  const kindProblem = `inputView kind must be one of ${kinds}`;
  if (typeof view !== "object" || view === null || Array.isArray(view)) return [kindProblem];
  const v = view as Record<string, unknown>;
  if (!(INPUT_VIEW_KINDS as readonly unknown[]).includes(v.kind)) return [kindProblem];
  const out: string[] = [];
  for (const name of inputViewFields(v)) {
    const label = typeof name === "string" ? name : String(name);
    const prop =
      typeof name === "string" && Object.hasOwn(props, name)
        ? (props[name] as { type?: unknown } | null)
        : undefined;
    if (typeof name !== "string" || CONTROL_OR_FORMAT.test(name) || prop?.type !== "string")
      out.push(`inputView names "${label}", which is not a string property of inputSchema`);
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

/** The most characters of `ToolResult.card.text`. */
export const CARD_TEXT_MAX = 2000;

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
   *
   * `placement` says where the card shows: `output` (default) lifted out after the run's process
   * block, where the person sees it with the answer; `pinned` as the run's pinned card, kept in
   * view while the run goes on (a plan or todo list; the latest pinned card per (extension, view)
   * of the run wins); `process` only inside the process block, after its call.
   * `text` is the card's Markdown text for surfaces that cannot draw the view (IM channels, the
   * pinned card of a channel's progress card), at most {@link CARD_TEXT_MAX} characters.
   */
  card?: {
    view: string;
    key?: string;
    placement?: "output" | "pinned" | "process";
    text?: string;
  };
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
  /**
   * Optional: longer text under the title (the reason, what to do), at most
   * {@link INPUT_FORM_BODY_MAX} characters, shown as plain text. Keep the title short.
   */
  body?: LocalizedText;
  fields: {
    key: string;
    label: LocalizedText;
    description?: LocalizedText;
    schema: ParamSchema;
    multiSelect?: boolean;
    allowOther?: boolean;
    required?: boolean;
    /**
     * Buttons in place of the field's control: one per choice, the first is the primary, and pressing one answers
     * the form with its value at once (no separate Answer). Allowed only on the form's single
     * field, when it is required and a single choice: a `boolean` (values `true` / `false`) or a
     * string `enum` without `multiSelect` / `allowOther` (values from the enum). 1 to
     * {@link INPUT_CHOICES_MAX} choices with distinct values; labels at most
     * {@link INPUT_CHOICE_LABEL_MAX} characters. Example: a confirm form `{ done: boolean }` with
     * `[{ value: true, label: "Done" }, { value: false, label: "Cancel" }]`, or a one-value enum
     * that renders as one button ("End wait").
     */
    choices?: { value: string | boolean; label: LocalizedText }[];
  }[];
}

/** The longest {@link InputForm.body}, in characters (per language). */
export const INPUT_FORM_BODY_MAX = 2000;
/** The most buttons a form's choices may draw. */
export const INPUT_CHOICES_MAX = 3;
/** The longest choice label, in characters (per language). */
export const INPUT_CHOICE_LABEL_MAX = 40;

/**
 * The tool needs user input: the kernel pauses the run and renders a form; after the user submits,
 * the tool is called again with the same input,
 * and state and answer are brought back in ctx.resume. state ≤ 16 KB, JSON-serializable.
 */
export interface InputRequired {
  kind: "input_required";
  form: InputForm;
  state?: unknown;
  /**
   * Opens a `conversation.panel` of the same extension on the asking person's open conversation
   * page when the form is asked (e.g. the browser panel for a handoff), as a view's `open` does
   * on a click. Display only: a target that names no panel of the extension is dropped with a
   * warning and the form is asked as usual.
   */
  open?: UiOpen;
  /**
   * A watched wait: besides the person's answer and the deadline, the tool's registered watcher
   * ({@link ToolWatcher}, `ctx.tools.register(spec, handler, { watch })`) may settle it. The
   * kernel parks the run (no model turn, no worker held) and calls the watcher every 10 s while
   * the wait is pending. `deadlineMs` is bounded by the deployment's `tools.approvalTimeoutHours`;
   * a shorter kernel deadline resumes the call with `outcome: "expired"`.
   */
  watch?: { deadlineMs: number };
}

/** How an input round ended when the handler is called again ({@link ToolCallContext.resume}). */
export type ToolResumeOutcome = "answered" | "woken" | "expired";

export type FormAnswer = Record<string, string | number | boolean | string[]>;

/**
 * What a tool handler gets with each invocation.
 *
 * **Side effects and idempotency.** The kernel runs a call's effect at most once: it records
 * that the call started before invoking the handler, and when a run dies after that and before
 * the result is recorded, the result is written as unknown (an error result the model sees:
 * `Result unknown: the call was interrupted before a result was recorded. Verify the outcome
 * before retrying.`) and **the handler is never called again** for that call. The model, or a
 * person, may then decide to call the tool again: that is a new call with a new `callId`.
 *
 * One logical call may still invoke the handler more than once: each `InputRequired` round
 * resumes it with `resume`, and a call whose device service reported refused hosts
 * (`ctx.deviceAccess.reportBlockedHosts`) runs again, without `resume`, once the person approved
 * the network ask and the hosts are in force. `callId` and `idempotencyKey` stay the same across
 * those invocations. A tool with an external side effect passes `idempotencyKey` downstream (for
 * example as an `Idempotency-Key` header, or stored with the record it creates) so the effect
 * applies once per logical call and an unknown outcome can be checked against the external
 * system before retrying.
 */
export interface ToolCallContext {
  orgId: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  /**
   * The root of the call's conversation tree (the conversation the person looks at); equal to
   * `conversationId` outside sub-agents. Set by the kernel, never from tool input.
   */
  rootConversationId: string;
  /**
   * The model's id for this call. Stable across every invocation of one logical call (the
   * `InputRequired` rounds), but unique only within its run: two runs of one conversation may
   * reuse an id, so `conversationId` + `callId` is not a key. Use `idempotencyKey`.
   */
  callId: string;
  /**
   * The key of this logical call for idempotent side effects: 64 lowercase hex characters derived
   * from the conversation, the run and `callId`. The same for every invocation of the call
   * (each `InputRequired` round), different for every other call, including a later call the
   * model makes to retry it. A re-run of the same call after its network ask was approved
   * (`ctx.deviceAccess.reportBlockedHosts`) keeps the key too.
   */
  idempotencyKey?: string;
  signal: AbortSignal;
  /**
   * The previous input round's state and answer. `answer` is null unless the person answered.
   * `outcome`: `answered` (the person answered), `woken` (a watched wait's watcher settled it, or
   * the kernel ended the watch early: the watcher failed, is gone, or the tool is no longer
   * available) or `expired` (the deadline passed). A tool with its own source of truth (a watched
   * condition) asks it first and uses `outcome` only for what happened otherwise.
   */
  resume?: { state: unknown; answer: FormAnswer | null; outcome: ToolResumeOutcome };
  /**
   * The extension's effective deployment config for this org: the platform's deployment config
   * with the org's copy applied to the overridable fields (every field not marked `platformOnly`),
   * or the platform's config (equal to `ctx.config`) while the org follows it. Use it, not
   * `ctx.config`, for work done for this org.
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
 * What a watcher gets: the call's context as the handler got it (the same `callId`,
 * `idempotencyKey`, accounts, conversations and effective config), without `resume`, plus the
 * state the handler returned with its watched `InputRequired`.
 */
export interface ToolWatchContext extends Omit<ToolCallContext, "resume"> {
  state: unknown;
}

/**
 * A watched wait's watcher (`ctx.tools.register(spec, handler, { watch })`). The kernel calls it
 * every 10 s while the wait is pending, never twice at once for one wait, never after it
 * settled; `settle` ends the wait (the handler is called again with `resume.outcome: "woken"`),
 * `pending` keeps it. It must be cheap: the kernel aborts it after 5 s through `ctx.signal`, which
 * counts as a failure, as a throw does; 3 consecutive failures end the wait. Its
 * `ctx.deviceAccess.request` calls run as `ifRunning` (a stopped device or service answers
 * `not_running`, nothing is resumed or started), `ensureService` is refused, and
 * `reportBlockedHosts` calls are dropped.
 */
export type ToolWatcher = (ctx: ToolWatchContext) => Promise<"settle" | "pending">;

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
  const timeout: unknown = spec?.timeoutMs;
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < TOOL_TIMEOUT_MIN_MS ||
      timeout > TOOL_TIMEOUT_MAX_MS)
  )
    out.push(
      `timeoutMs must be a whole number of milliseconds from ${TOOL_TIMEOUT_MIN_MS} to ${TOOL_TIMEOUT_MAX_MS}`,
    );
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
  if (form.body !== undefined && !textWithin(form.body, INPUT_FORM_BODY_MAX))
    out.push(`body must be non-empty text of at most ${INPUT_FORM_BODY_MAX} characters`);
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
    if (f.choices !== undefined) out.push(...choicesProblems(form, f).map((p) => `${at}: ${p}`));
  }
  return out;
}

/** Non-empty text (a string or both languages) of at most `max` characters per language. */
function textWithin(t: unknown, max: number): boolean {
  const ok = (x: unknown) => typeof x === "string" && x.trim() !== "" && x.length <= max;
  if (typeof t === "string") return ok(t);
  return (
    typeof t === "object" &&
    t !== null &&
    ok((t as { zh?: unknown }).zh) &&
    ok((t as { en?: unknown }).en)
  );
}

/** The rules of {@link InputForm} `choices` (buttons): see the field's documentation. */
function choicesProblems(form: InputForm, f: InputForm["fields"][number]): string[] {
  const out: string[] = [];
  const c = f.choices;
  if (!Array.isArray(c) || c.length === 0 || c.length > INPUT_CHOICES_MAX)
    return [`choices must be an array of 1 to ${INPUT_CHOICES_MAX} items`];
  if (form.fields.length !== 1) out.push("choices are allowed only on a form's single field");
  if (f.required !== true) out.push("choices require required: true");
  const bool = f.schema.type === "boolean";
  const single = isEnum(f.schema) && !f.multiSelect && !f.allowOther;
  if (!bool && !single)
    out.push(
      "choices require a boolean or a single-choice string enum (no multiSelect / allowOther)",
    );
  const seen = new Set<string | boolean>();
  for (const x of c) {
    const v = (x as { value?: unknown } | null)?.value;
    const valid = bool
      ? typeof v === "boolean"
      : single && typeof v === "string" && (f.schema as { enum: string[] }).enum.includes(v);
    if (!valid) out.push(`choice value ${JSON.stringify(v)} is not a value of the field`);
    else if (seen.has(v as string | boolean))
      out.push(`duplicate choice value ${JSON.stringify(v)}`);
    else seen.add(v as string | boolean);
    if (!textWithin((x as { label?: unknown } | null)?.label, INPUT_CHOICE_LABEL_MAX))
      out.push(
        `choice label must be non-empty text of at most ${INPUT_CHOICE_LABEL_MAX} characters`,
      );
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
