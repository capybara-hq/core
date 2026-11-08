import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { KernelLogger } from "../../log.js";
import type { OrgSettings } from "../../orgs/settings.service.js";
import type { ActorFacts } from "../../platform/actor.js";
import type { AgentDocTopic } from "../../platform/agent-docs.js";
import { type Availability, availability } from "../../platform/availability.js";
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
import type { PlatformOperations } from "../../platform/registry.js";
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
 * - Results are JSON text; a list an operation returns is capped at {@link LIST_MAX} entries.
 */

/** The most entries of a list in one result (operations that page return `next`). */
export const LIST_MAX = 50;
/** The most operations `search` returns. */
const SEARCH_MAX = 20;

/** The tool's `unavailable` reason when the org setting `platformTool` is `off` (spec §3). */
export const PLATFORM_UNAVAILABLE_OFF =
  "The org turned the Platform tool off; ask an org admin to turn it on.";

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
    "Discover and use the platform's own operations (skills, agents, templates, plugins, " +
    "marketplaces, requests, connectors, extensions) and its documentation, as the person you are " +
    'working for. Start with action "browse", then "describe" an operation before you "call" it; ' +
    'never guess parameters. Writes ask the person to confirm. Use "read" for how-to documentation ' +
    "(plugin format, skills, extension points).",
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

/** One operation as `browse` and `search` list it. */
const line = (op: PlatformOperation, facts: ActorFacts) => ({
  id: op.id,
  description: firstSentence(op.description),
  kind: kindOf(op),
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
const confirmCtx = (ctx: CallPolicyContext): OperationContext => ({
  orgId: ctx.orgId,
  actorAccountId: ctx.accountId,
  agentId: ctx.agentId,
  conversationId: ctx.conversationId,
  runId: ctx.runId,
  signal: new AbortController().signal,
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
    const failed = await precheckOf(
      op,
      params,
      ctx,
      deps.precheckTimeoutMs ?? PRECHECK_TIMEOUT_MS,
      deps.log,
    );
    if (failed !== null) {
      const role = errorRoleOf(f);
      const next = resolveNext(failed.next, role) ?? nextStepFor(op.errors, failed.code, role);
      return deny(precheckText(op.id, failed.code, failed.message, next));
    }
    const octx = confirmCtx(ctx);
    const [cls, summary] = await Promise.all([
      classOf(op, params, octx),
      summaryOf(op, params, octx),
    ]);
    return {
      key,
      policy: "ask",
      // org / platform writes are confirmed every time (spec §6.2)
      remember: cls === "personal",
      summary,
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

  async function call(input: PlatformInput, ctx: BuiltinCallContext) {
    const op = operationOf(deps, "call", input.operation);
    const params = paramsOf(op, input.params);
    // fresh facts right before running: the role may be gone since the confirmation (Review Focus 3)
    const f = await facts(factsCtx(ctx));
    const verdict = availability(op, f);
    if (!verdict.ok) throw new ToolError(unavailableOpText(op.id, verdict.reason));
    const role: ErrorRole = errorRoleOf(f);
    let result: unknown;
    try {
      result = await op.run(params, {
        orgId: ctx.orgId,
        actorAccountId: ctx.accountId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        runId: ctx.runId ?? null,
        signal: ctx.signal,
      });
    } catch (e) {
      // a service refusal after the approval (a race the precheck could not see) still names the
      // next step for this actor (Review Focus 2)
      throw toToolError(e, (code) => nextStepFor(op.errors, code, role));
    }
    return json(asResult(result), { zh: `调用平台操作 ${op.id}`, en: `Called ${op.id}` });
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
    const r = await Promise.race([op.precheck(params, { ...confirmCtx(ctx), signal }), timeout]);
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
