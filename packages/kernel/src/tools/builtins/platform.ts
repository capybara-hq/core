import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { KernelLogger } from "../../log.js";
import type { OrgSettings } from "../../orgs/settings.service.js";
import type { ActorFacts } from "../../platform/actor.js";
import type { AgentDocTopic } from "../../platform/agent-docs.js";
import {
  type Availability,
  availability,
  PLATFORM_UNAVAILABLE_OFF,
} from "../../platform/availability.js";
import {
  type ErrorRole,
  errorRoleOf,
  errorsFor,
  nextStepFor,
  OPERATION_ERROR_NEXT,
  resolveNext,
  sentence,
  toToolError,
} from "../../platform/errors.js";
import { PLATFORM_METHOD } from "../../platform/method.js";
import {
  type ConfirmClass,
  OPERATION_ID,
  type OperationContext,
  type OperationErrorNext,
  operationDomain,
  type PlatformOperation,
  PRECHECK_TIMEOUT_MS,
} from "../../platform/operation.js";
import { type PersonFieldSpec, planPersonFields } from "../../platform/person-fields.js";
import type { PlatformOperations } from "../../platform/registry.js";
import { type SealedInputs, SealedInputsExpiredError } from "../../platform/sealed-inputs.js";
import { BUILTIN } from "../builtin-names.js";
import type {
  BuiltinCallContext,
  BuiltinResult,
  BuiltinTool,
  CallPolicy,
  CallPolicyContext,
} from "../registry.js";

/**
 * The `Platform` builtin (Platform tool spec §3–§6): one tool through which an agent discovers and
 * calls the platform's own operations as the run's trigger account, and reads the agent docs.
 * - `browse` / `search` / `describe` / `read` only read; their policy is the tool's `allow`.
 * - `call` gets a per-call policy key `Platform:<operation>` ({@link BuiltinTool.callPolicy}): a
 *   read runs, a write asks (remembered only for `personal`), an operation that cannot run now is
 *   denied with its reason, and so is a write whose `precheck` knows it would fail (spec §14.2
 *   item 2: no card). The policy is derived again when an approved call resumes, so a precheck
 *   that fails by then returns its error and nothing runs. Right before `op.run` the availability
 *   is checked again on fresh facts (the actor may have lost the role while the confirmation
 *   waited).
 * - An `ApiError` gets the next step the operation declares for its code and the actor's role.
 * - The actor, the agent and the conversation come from the runtime context, never from input.
 * - A write with person fields (platform web parity spec §4: `op.personFields`) is planned at the
 *   policy step: a secret in `values` is denied before the card, and the asked fields go to the
 *   card through {@link CallPolicy.personFields} (never remembered). The approved call reads the
 *   person's sealed values through `personInputs` and its result names each entered path, never a
 *   value.
 * - Results are JSON text; a list an operation returns is capped at {@link LIST_MAX} entries.
 */

/** The most entries of a list in one result (operations that page return `next`). */
export const LIST_MAX = 50;
/** The most operations `search` returns. */
const SEARCH_MAX = 20;

const ACTIONS = ["browse", "search", "describe", "call", "read"] as const;
type Action = (typeof ACTIONS)[number];

interface PlatformInput {
  action: Action;
  domain?: string;
  query?: string;
  operation?: string;
  params?: Record<string, unknown>;
  topic?: string;
}

const SPEC: ToolSpec = {
  name: BUILTIN.Platform,
  description:
    "Discover and use the platform's own operations (agents, skills, templates, plugins, " +
    "connectors, extensions, conversations, devices, models, evals, channels, requests, " +
    "approvals and the inbox, org settings, and for admins accounts, orgs and the admin console) " +
    'and its documentation, as the person you are working for. Start with action "browse", which ' +
    'lists every domain; "describe" gives an operation\'s input schema and an example. ' +
    'Writes ask the person to confirm. Use "read" for how-to documentation (plugin ' +
    "format, skills, extension points).",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description:
          'browse: the domains and the method, or one domain\'s operations with "domain"; search: ' +
          'operations matching "query"; describe: one operation\'s full definition; call: run ' +
          '"operation" with "params"; read: a documentation topic, or the list of topics without ' +
          '"topic".',
      },
      domain: {
        type: "string",
        maxLength: 100,
        description: 'For browse: a domain id from the browse result, e.g. "skills".',
      },
      query: {
        type: "string",
        maxLength: 200,
        description: "For search: words to look for in operation ids and descriptions.",
      },
      operation: {
        type: "string",
        maxLength: 100,
        description: 'For describe and call: an operation id, e.g. "skills.list".',
      },
      params: {
        type: "object",
        description:
          "For call: the operation's input, matching the inputSchema describe returned. Pass " +
          '"cursor" from a previous result\'s "next" to get the next page.',
      },
      topic: {
        type: "string",
        maxLength: 100,
        description: "For read: a topic id from the topic list.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  keyArgs: ["action", "operation", "domain"],
};

/** What the tool needs; `BuiltinTools` passes the Nest providers. */
export interface PlatformToolDeps {
  ops: Pick<PlatformOperations, "domains" | "inDomain" | "get" | "search">;
  actor: { facts(ctx: CallPolicyContext): Promise<ActorFacts> };
  docs: { topics(): AgentDocTopic[]; read(id: string): string | null };
  /** The org setting `platformTool`. */
  setting(orgId: string): Promise<OrgSettings["platformTool"]>;
  /** How long a precheck may take; default {@link PRECHECK_TIMEOUT_MS} (a test seam). */
  precheckTimeoutMs?: number;
  /** A precheck that throws is logged (warn) and one that times out (debug), with the op id. */
  log?: Pick<KernelLogger, "warn"> & Partial<Pick<KernelLogger, "debug">>;
  /** The person's sealed card values (`personInputs`); absent: no write has person fields. */
  sealed?: Pick<SealedInputs, "consume">;
  /**
   * The person field paths an approval's card showed (its stored `detail.personFields`), or null
   * when it has none: what an approved call's values are bound to.
   */
  approvalPersonPaths?(approvalId: string): Promise<string[] | null>;
}

const json = (value: unknown, summary: { zh: string; en: string }): BuiltinResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  display: { summary },
});

/** Longest model-written text quoted in a display summary (summaries are at most 200). */
const SUMMARY_QUOTE_MAX = 80;
const clip = (s: string): string =>
  s.length > SUMMARY_QUOTE_MAX ? `${s.slice(0, SUMMARY_QUOTE_MAX)}…` : s;

/** The first sentence of a description: the line `browse` and `search` show. */
const firstSentence = (text: string): string => {
  const m = /^(.+?[.!?])(\s|$)/s.exec(text.trim());
  return (m?.[1] ?? text).trim();
};

const kindOf = (op: PlatformOperation): "read" | "write" =>
  op.confirm === "read" ? "read" : "write";

const availabilityFields = (a: Availability) =>
  a.ok ? { available: true } : { available: false, reason: a.reason };

type JsonObjectSchema = {
  properties?: Record<string, unknown>;
  required?: string[];
  anyOf?: JsonObjectSchema[];
  oneOf?: JsonObjectSchema[];
};

/** The most input keys a `params` line names before it ends in `…`. */
const PARAMS_MAX = 8;
const paramsCache = new WeakMap<PlatformOperation, string>();

/**
 * An operation's input keys as `browse` and `search` show them, so a call needs no guess:
 * `"itemId"`, `"agentId, updatedAt, avatar?, quickActions?"` (`?` = optional), `""` when it takes
 * none. A union input lists the keys of every branch; a key is required when every branch requires
 * it. Types, bounds and an example stay in `describe`.
 */
export function paramsLine(op: PlatformOperation): string {
  const cached = paramsCache.get(op);
  if (cached !== undefined) return cached;
  const schema = z.toJSONSchema(op.input, {
    io: "input",
    unrepresentable: "any",
  }) as JsonObjectSchema;
  const branches = schema.anyOf ?? schema.oneOf ?? [schema];
  const keys: string[] = [];
  for (const b of branches) {
    for (const k of Object.keys(b.properties ?? {})) if (!keys.includes(k)) keys.push(k);
  }
  const required = (k: string) => branches.every((b) => b.required?.includes(k) ?? false);
  const ordered = [...keys.filter(required), ...keys.filter((k) => !required(k))];
  const names = ordered.map((k) => (required(k) ? k : `${k}?`));
  const text =
    names.length > PARAMS_MAX ? `${names.slice(0, PARAMS_MAX).join(", ")}, …` : names.join(", ");
  paramsCache.set(op, text);
  return text;
}

/** One operation as `browse` and `search` list it. */
const line = (op: PlatformOperation, facts: ActorFacts) => ({
  id: op.id,
  description: firstSentence(op.description),
  kind: kindOf(op),
  params: paramsLine(op),
  ...availabilityFields(availability(op, facts)),
});

const capped = <T>(items: readonly T[]) => ({
  items: items.slice(0, LIST_MAX),
  ...(items.length > LIST_MAX && {
    total: items.length,
    truncated: true,
    hint: "Narrow the query or pass params.cursor where the operation pages.",
  }),
});

/** An operation's result as a JSON object: a bare list is capped, nothing becomes `{ ok: true }`. */
function asResult(value: unknown): unknown {
  if (Array.isArray(value)) return capped(value);
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "object") return { result: value };
  return value;
}

const unknownOperationText = (id: string) =>
  `Unknown operation "${id}". Use browse or search to find an operation id, then describe it.`;
const missingText = (action: Action, field: string, what: string) =>
  `Action ${action} needs "${field}": pass ${what}.`;
const invalidParamsText = (id: string, problems: string) =>
  `Invalid params for ${id}: ${problems}. Call describe with operation "${id}" for its input schema and an example, then call again.`;
const unavailableOpText = (id: string, reason: string) =>
  `Operation ${id} is unavailable, so do not call it again as is: ${reason}`;
const precheckText = (id: string, code: string, message: string, next: string | undefined) =>
  `Operation ${id} cannot run now: ${code}: ${sentence(message)} ${next ?? OPERATION_ERROR_NEXT}`;
const secretRecordText = (id: string, path: string, target: string) =>
  `Operation ${id} cannot run now: platform.secret_record_web_only: \`${path}\` is a secret record, which the confirmation card cannot ask for. Tell the person to enter it on the web page of ${target}.`;
/** Model-visible: the person's values expired before the approved call ran (spec §4.3). */
export const PERSON_INPUTS_EXPIRED_TEXT =
  "The values the person entered expired before they were applied; call the operation again.";
/** Model-visible: an approved call with person fields that has no approval to read them by. */
const personInputsMissingText = (id: string) =>
  `Operation ${id} needs values the person enters on the confirmation card, and this call ran without one; call the operation again.`;
/**
 * Model-visible: the person-field plan refused an approved call when it resumed (the target's
 * secret fields changed while the card waited); `message` is the plan's English refusal.
 */
const personRefusedText = (id: string, message: string) =>
  `Operation ${id} cannot run as approved: ${message} Correct the params, then call the operation again.`;
/**
 * Model-visible: the fields to enter differ between the card the person confirmed, the values they
 * sealed and the call as it runs now.
 */
const PERSON_FIELDS_CHANGED_TEXT =
  "The target changed after the person confirmed (the fields to enter differ); call the operation again.";
/** Model-visible result line: the approved call's operation never applied the person's values. */
const unusedValuesText = (id: string) => `The values the person entered were not used by ${id}.`;
/** The result line of one field the person entered (never its value). */
const enteredLine = (path: string) => `\`${path}\`: entered by the person`;
const outputRefText = (id: string) =>
  `Operation ${id} writes, and its params hold a {"$output": ...} reference, which the person confirming would see instead of the content. Pass the content inline in params and call again.`;

/** Whether a value holds a `{"$output": …}` reference anywhere (the pipeline's form). */
function hasOutputRef(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasOutputRef);
  if (typeof v !== "object" || v === null) return false;
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === "$output") return true;
  return Object.values(v).some(hasOutputRef);
}

/** Zod issues as one line: `path: message; …` (at most five). */
function issuesText(error: z.ZodError): string {
  const parts = error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length === 0 ? "params" : i.path.join(".")}: ${i.message}`);
  if (error.issues.length > 5) parts.push(`and ${error.issues.length - 5} more`);
  return parts.join("; ");
}

/** The operation of a `call` / `describe`; a `ToolError` when there is none (model-visible). */
function operationOf(
  deps: PlatformToolDeps,
  action: Action,
  id: string | undefined,
): PlatformOperation {
  if (id === undefined || id === "") {
    throw new ToolError(missingText(action, "operation", "an operation id from browse or search"));
  }
  const op = deps.ops.get(id);
  if (op === null) throw new ToolError(unknownOperationText(id));
  return op;
}

/** `params` checked against the operation's schema; a `ToolError` naming `describe` otherwise. */
function paramsOf(op: PlatformOperation, params: Record<string, unknown> | undefined): unknown {
  const parsed = op.input.safeParse(params ?? {});
  if (!parsed.success) throw new ToolError(invalidParamsText(op.id, issuesText(parsed.error)));
  return parsed.data;
}

/**
 * The operation context of a confirmation (`confirmFor`, `summary`): the runtime's ids, never
 * input. Nothing aborts it; it only reads.
 */
const confirmCtx = (ctx: CallPolicyContext, errorRole: ErrorRole): OperationContext => ({
  orgId: ctx.orgId,
  actorAccountId: ctx.accountId,
  agentId: ctx.agentId,
  conversationId: ctx.conversationId,
  runId: ctx.runId,
  ...(ctx.callId !== undefined && { callId: ctx.callId }),
  signal: new AbortController().signal,
  errorRole,
});

const factsCtx = (ctx: BuiltinCallContext): CallPolicyContext => ({
  orgId: ctx.orgId,
  accountId: ctx.accountId,
  agentId: ctx.agentId,
  conversationId: ctx.conversationId,
  runId: ctx.runId ?? null,
});

export function platformTool(deps: PlatformToolDeps): BuiltinTool {
  const facts = (ctx: CallPolicyContext) => deps.actor.facts(ctx);

  async function callPolicy(raw: unknown, ctx: CallPolicyContext): Promise<CallPolicy | null> {
    const input = raw as PlatformInput;
    if (input.action !== "call") return null;
    const id = input.operation;
    const key = `${BUILTIN.Platform}:${id !== undefined && OPERATION_ID.test(id) ? id : "unknown"}`;
    const deny = (denyReason: string): CallPolicy => ({
      key,
      policy: "deny",
      remember: false,
      denyReason,
    });
    let op: PlatformOperation;
    let params: unknown;
    try {
      op = operationOf(deps, "call", id);
      // params that cannot run are refused here, so the person is never asked to confirm them
      params = paramsOf(op, input.params);
    } catch (e) {
      if (e instanceof ToolError) return deny(e.message);
      throw e;
    }
    const f = await facts(ctx);
    const verdict = availability(op, f);
    if (!verdict.ok) return deny(unavailableOpText(op.id, verdict.reason));
    if (op.confirm === "read") return { key, policy: "allow", remember: false };
    // the card shows the raw input: a write must carry what it writes, not a reference to it
    if (hasOutputRef((ctx.rawInput as PlatformInput | undefined)?.params)) {
      return deny(outputRefText(op.id));
    }
    const role = errorRoleOf(f);
    const octx = confirmCtx(ctx, role);
    let personFields: { target: { zh: string; en: string }; fields: PersonFieldSpec[] } | null;
    try {
      personFields = await personFieldsOf(op, params, octx);
    } catch (e) {
      if (e instanceof PersonFieldsRefused) return deny(e.message);
      // a target that cannot be read (gone, not allowed) is the write's own error
      return deny(toToolError(e, (code) => nextStepFor(op.errors, code, role)).message);
    }
    const failed = await precheckOf(
      op,
      params,
      ctx,
      role,
      deps.precheckTimeoutMs ?? PRECHECK_TIMEOUT_MS,
      deps.log,
    );
    if (failed !== null) {
      const next = resolveNext(failed.next, role) ?? nextStepFor(op.errors, failed.code, role);
      return deny(precheckText(op.id, failed.code, failed.message, next));
    }
    const [cls, summary] = await Promise.all([
      classOf(op, params, octx),
      summaryOf(op, params, octx),
    ]);
    return {
      key,
      policy: "ask",
      // org / platform writes are confirmed every time (spec §6.2); so is a write with person
      // fields, whatever its class (spec §4.2, R6)
      remember: personFields === null && cls === "personal" && op.rememberable !== false,
      summary,
      ...(personFields !== null && { personFields }),
    };
  }

  async function run(raw: unknown, ctx: BuiltinCallContext): Promise<BuiltinResult> {
    const input = raw as PlatformInput;
    switch (input.action) {
      case "browse":
        return input.domain === undefined ? browseRoot() : browseDomain(input.domain, ctx);
      case "search":
        return search(input.query, ctx);
      case "describe":
        return describe(input.operation, ctx);
      case "call":
        return call(input, ctx);
      case "read":
        return read(input.topic);
    }
  }

  function browseRoot(): BuiltinResult {
    const domains = deps.ops.domains().map((d) => ({
      id: d.id,
      description: d.description,
      operations: deps.ops.inDomain(d.id).length,
    }));
    return json(
      { domains, method: PLATFORM_METHOD },
      { zh: "浏览平台操作", en: "Browsed platform operations" },
    );
  }

  async function browseDomain(domain: string, ctx: BuiltinCallContext): Promise<BuiltinResult> {
    const ids = deps.ops.domains().map((d) => d.id);
    if (!ids.includes(domain)) {
      throw new ToolError(
        `Unknown domain "${domain}". Use one of: ${ids.join(", ")}; or call browse without a domain.`,
      );
    }
    const f = await facts(factsCtx(ctx));
    const ops = deps.ops.inDomain(domain);
    return json(
      {
        domain,
        operations: ops.slice(0, LIST_MAX).map((op) => line(op, f)),
        ...(ops.length > LIST_MAX && { truncated: true, hint: "Use search to narrow the list." }),
      },
      { zh: `浏览平台操作：${domain}`, en: `Browsed platform operations: ${domain}` },
    );
  }

  async function search(query: string | undefined, ctx: BuiltinCallContext) {
    if (query === undefined || query.trim() === "") {
      throw new ToolError(missingText("search", "query", "words to look for"));
    }
    const f = await facts(factsCtx(ctx));
    const found = deps.ops.search(query, SEARCH_MAX);
    return json(
      {
        query,
        operations: found.map((op) => line(op, f)),
        ...(found.length === 0 && {
          hint: "Nothing matched; use other words, or browse a domain.",
        }),
      },
      { zh: `搜索平台操作：${clip(query)}`, en: `Searched platform operations: ${clip(query)}` },
    );
  }

  async function describe(id: string | undefined, ctx: BuiltinCallContext) {
    const op = operationOf(deps, "describe", id);
    const f = await facts(factsCtx(ctx));
    return json(
      {
        id: op.id,
        description: op.description,
        kind: kindOf(op),
        confirm: op.confirm,
        inputSchema: z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }),
        example: op.example,
        ...(op.errors !== undefined &&
          op.errors.length > 0 && { errors: errorsFor(op.errors, errorRoleOf(f)) }),
        ...availabilityFields(availability(op, f)),
        related: deps.ops
          .inDomain(operationDomain(op.id))
          .filter((o) => o.id !== op.id)
          .map((o) => o.id),
      },
      { zh: `查看平台操作 ${op.id}`, en: `Described platform operation ${op.id}` },
    );
  }

  async function call(input: PlatformInput, ctx: BuiltinCallContext): Promise<BuiltinResult> {
    const op = operationOf(deps, "call", input.operation);
    const params = paramsOf(op, input.params);
    // fresh facts right before running: the role may be gone since the confirmation (Review Focus 3)
    const f = await facts(factsCtx(ctx));
    const verdict = availability(op, f);
    if (!verdict.ok) throw new ToolError(unavailableOpText(op.id, verdict.reason));
    const role: ErrorRole = errorRoleOf(f);
    const octx: OperationContext = {
      orgId: ctx.orgId,
      actorAccountId: ctx.accountId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      runId: ctx.runId ?? null,
      callId: ctx.callId,
      signal: ctx.signal,
      errorRole: role,
    };
    /** The paths whose values the handler applied (the result's lines). */
    let entered: readonly string[] = [];
    /** Whether the handler called `personInputs.apply` (once at most). */
    let applied = false;
    let result: unknown;
    try {
      const person = await personFieldsOf(op, params, octx);
      // what the card showed (the approval's stored specs) binds what runs: the run-time plan
      // must ask exactly those fields, and the sealed values must carry exactly them
      const approvalId = ctx.approvalId;
      const shown =
        approvalId === undefined || deps.approvalPersonPaths === undefined
          ? null
          : await deps.approvalPersonPaths(approvalId);
      if (person === null && shown !== null) throw new PersonFieldsChanged();
      if (person !== null) {
        const sealed = deps.sealed;
        if (approvalId === undefined || sealed === undefined) {
          throw new ToolError(personInputsMissingText(op.id));
        }
        // an approval made before the call had person fields (the target changed since)
        if (shown === null) throw new PersonFieldsChanged();
        const asked = person.fields.map((p) => p.path);
        if (!sameSet(asked, shown)) throw new PersonFieldsChanged();
        octx.personInputs = {
          paths: shown,
          apply: (fn) => {
            if (applied) throw new Error("personInputs.apply called twice");
            applied = true;
            // the person who typed the values is the run's trigger account, the approval's
            // `requested_for` (a role escalation is refused before the card, R5)
            return sealed.consume(approvalId, ctx.accountId, async (values) => {
              // a throw here rolls the row's delete back: nothing is applied
              if (!sameSet(Object.keys(values), shown) || !sameSet(asked, shown)) {
                throw new PersonFieldsChanged();
              }
              const out = await fn(values);
              entered = Object.keys(values).sort();
              return out;
            });
          },
        };
      }
      result = await op.run(params, octx);
    } catch (e) {
      if (e instanceof SealedInputsExpiredError) throw new ToolError(PERSON_INPUTS_EXPIRED_TEXT);
      if (e instanceof PersonFieldsChanged) throw new ToolError(PERSON_FIELDS_CHANGED_TEXT);
      if (e instanceof PersonFieldsRefused)
        throw new ToolError(personRefusedText(op.id, e.message));
      // a service refusal after the approval (a race the precheck could not see) still names the
      // next step for this actor (Review Focus 2)
      throw toToolError(e, (code) => nextStepFor(op.errors, code, role));
    }
    const summary = { zh: `调用平台操作 ${op.id}`, en: `Called ${op.id}` };
    const lines = entered.map(enteredLine);
    if (octx.personInputs !== undefined && !applied) {
      // an operation bug: the person typed values the write never used (they expire unread)
      deps.log?.warn("platform operation did not use the person's values", { operation: op.id });
      lines.push(unusedValuesText(op.id));
    }
    if (lines.length === 0) return json(asResult(result), summary);
    return {
      content: [
        { type: "text", text: JSON.stringify(asResult(result)) },
        { type: "text", text: lines.join("\n") },
      ],
      display: { summary },
    };
  }

  function read(topic: string | undefined): BuiltinResult {
    if (topic === undefined || topic === "") {
      return json(
        { topics: deps.docs.topics(), hint: 'Read one with action "read" and its "topic".' },
        { zh: "查看平台文档目录", en: "Listed platform docs" },
      );
    }
    const text = deps.docs.read(topic);
    if (text === null) {
      throw new ToolError(
        `Unknown topic "${topic}". Call read without a topic to list the topics.`,
      );
    }
    return {
      content: [{ type: "text", text }],
      display: { summary: { zh: `阅读平台文档 ${topic}`, en: `Read platform doc ${topic}` } },
    };
  }

  return {
    spec: SPEC,
    defaultPolicy: "allow",
    run,
    callPolicy,
    async unavailable({ orgId }) {
      return (await deps.setting(orgId)) === "off" ? PLATFORM_UNAVAILABLE_OFF : null;
    },
  };
}

/** A person-field plan that refuses the call (model-visible English). */
class PersonFieldsRefused extends Error {}

/** The fields to enter differ from what the person confirmed ({@link PERSON_FIELDS_CHANGED_TEXT}). */
class PersonFieldsChanged extends Error {}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

/** The `askPerson` / `clearSecrets` of a validated input (both default to [] in the schema). */
const pathsOf = (params: unknown, key: "askPerson" | "clearSecrets"): string[] => {
  const v = (params as Record<string, unknown> | null)?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

/**
 * The person fields one call asks for (spec §4.1): `op.personFields` planned against the input's
 * `values`, `askPerson` and `clearSecrets`. Null when the operation has none or the plan asks for
 * nothing. Throws {@link PersonFieldsRefused} with the plan's refusal, or with
 * `platform.secret_record_web_only` when `askPerson` / `clearSecrets` names a secret record the card
 * cannot ask for (ruling R1); an error reading the target propagates.
 */
async function personFieldsOf(
  op: PlatformOperation,
  params: unknown,
  ctx: OperationContext,
): Promise<{ target: { zh: string; en: string }; fields: PersonFieldSpec[] } | null> {
  if (op.personFields === undefined) return null;
  const target = await op.personFields(params, ctx);
  const askPerson = pathsOf(params, "askPerson");
  const clearSecrets = pathsOf(params, "clearSecrets");
  const records = new Set(target.recordOnly ?? []);
  const record = [...askPerson, ...clearSecrets].find((p) => records.has(p));
  if (record !== undefined) {
    throw new PersonFieldsRefused(secretRecordText(op.id, record, target.target.en));
  }
  const values = (params as { values?: unknown } | null)?.values;
  const plan = planPersonFields(target, {
    ...(typeof values === "object" &&
      values !== null &&
      !Array.isArray(values) && { values: values as Record<string, unknown> }),
    askPerson,
    clearSecrets,
  });
  if (!plan.ok) throw new PersonFieldsRefused(plan.message);
  return plan.ask.length === 0 ? null : { target: target.target, fields: plan.ask };
}

/**
 * The class of one write: `confirmFor` when the operation has one (the target decides), else
 * `confirm`. A `confirmFor` that throws counts as `org`: never remembered.
 */
async function classOf(
  op: PlatformOperation,
  params: unknown,
  ctx: OperationContext,
): Promise<ConfirmClass> {
  if (op.confirmFor === undefined) return op.confirm;
  try {
    return await op.confirmFor(params, ctx);
  } catch {
    return "org";
  }
}

/**
 * The operation's precheck, bounded by `ms`: the failure it found, or null (none, passed, timed
 * out, or threw: the write's own errors speak then; a throw is logged as a warning, a timeout at
 * debug). Its signal aborts at the timeout or when the run's signal aborts.
 */
async function precheckOf(
  op: PlatformOperation,
  params: unknown,
  ctx: CallPolicyContext,
  role: ErrorRole,
  ms: number,
  log: PlatformToolDeps["log"],
): Promise<{ code: string; message: string; next?: OperationErrorNext } | null> {
  if (op.precheck === undefined) return null;
  const ac = new AbortController();
  const signal = ctx.signal === undefined ? ac.signal : AbortSignal.any([ac.signal, ctx.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      log?.debug?.("platform precheck timed out; the card is shown", { operation: op.id, ms });
      resolve(null);
    }, ms);
  });
  try {
    const r = await Promise.race([
      op.precheck(params, { ...confirmCtx(ctx, role), signal }),
      timeout,
    ]);
    if (r === null || r.ok) return null;
    return { code: r.code, message: r.message, ...(r.next !== undefined && { next: r.next }) };
  } catch (err) {
    log?.warn("platform precheck failed; the card is shown", { operation: op.id, err });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The card summary of a write, rendered from the validated params and kernel reads. */
async function summaryOf(
  op: PlatformOperation,
  params: unknown,
  ctx: OperationContext,
): Promise<{ zh: string; en: string }> {
  try {
    const s = await op.summary?.(params, ctx);
    if (s !== undefined) return s;
  } catch {
    // a summary that cannot render falls back to the operation id (the card shows every param)
  }
  return { zh: `平台操作 ${op.id}`, en: `Platform operation ${op.id}` };
}
