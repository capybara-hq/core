import { randomUUID } from "node:crypto";
import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT,
  ModelError,
  type ModelProviderV1,
  type ModelRequestV1,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test model provider `model-script` (model `script-1`, phase C Task 8): answers from a rule list,
 * so a test can script multi-step controllers and parallel tool calls (`model-fake` answers one
 * tool call per response). Not an official plugin.
 *
 * Rules come from the deployment config `{ rules: Rule[] }`; rules a test sets at run time with
 * {@link scriptRules} (same process) are tried first. The first rule whose every `when` condition
 * holds answers; without a match the reply is the text `done`.
 *
 * Conditions: `systemIncludes` (any system block), `lastUserIncludes` (the last user message with
 * text), `lastToolResultIncludes` (any tool result of the last message), `assistantTurns` (the
 * number of assistant messages in the request).
 *
 * Replies: `text` and / or `toolCalls` (stop reason `tool_use` when there are calls). In tool call
 * inputs, the string `{{lastAgentId}}` becomes the `agentId` of the last `agent` result in the
 * request. `barrier` makes the request wait until `count` requests reached the barrier `name` (in
 * this process; `barrier timeout` after `timeoutMs`), which proves that requests run concurrently.
 */
const When = z.object({
  systemIncludes: z.string().optional(),
  lastUserIncludes: z.string().optional(),
  lastToolResultIncludes: z.string().optional(),
  assistantTurns: z.number().int().nonnegative().optional(),
});

const Reply = z.object({
  text: z.string().optional(),
  toolCalls: z.array(z.object({ name: z.string(), input: z.unknown() })).optional(),
  barrier: z
    .object({
      name: z.string(),
      count: z.number().int().positive(),
      timeoutMs: z.number().int().positive().default(10_000),
    })
    .optional(),
});

export const ScriptRule = z.object({ when: When.default({}), reply: Reply });
export type ScriptRule = z.input<typeof ScriptRule>;

const ConfigSchema = z.object({ rules: z.array(ScriptRule).default([]) });

interface ScriptState {
  rules: z.infer<typeof ScriptRule>[];
  barriers: Map<string, { arrived: number; waiters: (() => void)[] }>;
}

const state = (): ScriptState => {
  const g = globalThis as { __modelScript?: ScriptState };
  g.__modelScript ??= { rules: [], barriers: new Map() };
  return g.__modelScript;
};

/** Sets the run-time rules (tried before the config's); `[]` clears them and the barriers. */
export function scriptRules(rules: ScriptRule[]): void {
  const s = state();
  s.rules = rules.map((r) => ScriptRule.parse(r));
  s.barriers.clear();
}

const textOf = (blocks: ModelRequestV1["messages"][number]["content"]): string =>
  typeof blocks === "string"
    ? blocks
    : blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

function lastUserText(req: ModelRequestV1): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role !== "user" || typeof m.content === "string") continue;
    const text = textOf(m.content);
    if (text !== "") return text;
  }
  return "";
}

function lastToolResults(req: ModelRequestV1): string {
  const m = req.messages.at(-1);
  if (m?.role !== "user" || typeof m.content === "string") return "";
  return m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])).join("\n");
}

function lastAgentId(req: ModelRequestV1): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role !== "user" || typeof m.content === "string") continue;
    for (const b of [...m.content].reverse()) {
      if (b.type !== "tool_result") continue;
      const id = /\[agentId: ([^ ]+) ·/.exec(b.content)?.[1];
      if (id !== undefined) return id;
    }
  }
  return "";
}

function matches(when: z.infer<typeof When>, req: ModelRequestV1): boolean {
  if (
    when.systemIncludes !== undefined &&
    !req.system.some((s) => s.text.includes(when.systemIncludes as string))
  ) {
    return false;
  }
  if (when.lastUserIncludes !== undefined && !lastUserText(req).includes(when.lastUserIncludes)) {
    return false;
  }
  if (
    when.lastToolResultIncludes !== undefined &&
    !lastToolResults(req).includes(when.lastToolResultIncludes)
  ) {
    return false;
  }
  if (
    when.assistantTurns !== undefined &&
    req.messages.filter((m) => m.role === "assistant").length !== when.assistantTurns
  ) {
    return false;
  }
  return true;
}

const substitute = (v: unknown, id: string): unknown =>
  typeof v === "string"
    ? v.replaceAll("{{lastAgentId}}", id)
    : Array.isArray(v)
      ? v.map((x) => substitute(x, id))
      : typeof v === "object" && v !== null
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, id)]))
        : v;

/** Waits at the barrier; false on timeout or abort. */
function barrier(
  b: { name: string; count: number; timeoutMs: number },
  signal: AbortSignal,
): Promise<boolean> {
  const s = state();
  const entry = s.barriers.get(b.name) ?? { arrived: 0, waiters: [] };
  s.barriers.set(b.name, entry);
  entry.arrived += 1;
  if (entry.arrived >= b.count) {
    for (const w of entry.waiters.splice(0)) w();
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), b.timeoutMs);
    const release = () => {
      clearTimeout(timer);
      resolve(true);
    };
    entry.waiters.push(release);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });
}

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

export default defineExtension({
  name: "model-script",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT],
  config: { deployment: ConfigSchema },
  setup(ctx) {
    const provider: ModelProviderV1 = {
      async listModels() {
        return [
          {
            id: "script-1",
            displayName: "script-1",
            contextWindow: 64_000,
            maxOutputTokens: 4096,
            capabilities: {
              tools: true,
              vision: false,
              reasoning: false,
              caching: false,
              midConversationSystem: true,
              effort: false,
            },
          },
        ];
      },
      async *stream(req, { signal }): AsyncGenerator<ModelStreamEvent> {
        if (signal.aborted) throw new ModelError("aborted", "Request aborted");
        const configured = (ctx.config as z.infer<typeof ConfigSchema>).rules ?? [];
        const rule = [...state().rules, ...configured.map((r) => ScriptRule.parse(r))].find((r) =>
          matches(r.when, req),
        );
        const reply = rule?.reply ?? { text: "done" };
        let text = reply.text;
        if (reply.barrier && !(await barrier(reply.barrier, signal))) {
          if (signal.aborted) throw new ModelError("aborted", "Request aborted");
          text = "barrier timeout";
        }
        const id = lastAgentId(req);
        const calls = (reply.toolCalls ?? []).map((c) => ({
          type: "tool_call" as const,
          id: randomUUID(),
          name: c.name,
          input: substitute(c.input ?? {}, id),
        }));
        const content = [
          ...(text !== undefined && text !== "" ? [{ type: "text" as const, text }] : []),
          ...calls,
        ];
        if (text) yield { type: "text_delta", text };
        yield {
          type: "message_complete",
          content,
          stopReason: calls.length > 0 ? "tool_use" : "end_turn",
          usage,
        };
      },
    };
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT, provider);
  },
});
