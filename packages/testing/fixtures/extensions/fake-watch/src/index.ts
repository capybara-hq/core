import {
  defineExtension,
  type ExtensionContext,
  type InputRequired,
  type ToolSpec,
  type ToolWatchContext,
} from "@capybara-hq/plugin-sdk";

/**
 * Test fake of a watched input wait (browser long waits spec §5): no official plugin needed.
 * - tool `wait` (model-visible `plugin__fake-watch__wait`, default policy allow), input
 *   `{ key, deadlineMs? }`: the first call returns a watched `InputRequired` (one end button,
 *   state `{ key }`, `watch.deadlineMs` default 60 000); the resumed call returns, as JSON text,
 *   `{ outcome, answer, signal }` (`signal`: the kv value below when resumed).
 * - its watcher reads kv `fake-watch:<key>`: `go` settles, `fail` throws, `hang` never answers
 *   (the kernel's timeout ends it), anything else is pending. Each call increments kv
 *   `fake-watch:<key>:polls` and writes kv `fake-watch:<key>:ctx` (JSON of the call identity the
 *   watcher got and the state).
 * - tool `nowatch`: returns a watched `InputRequired` without a registered watcher.
 */

const WAIT: ToolSpec = {
  name: "wait",
  description: "Wait until the test sets a signal. Test fixture only.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", minLength: 1, description: "The signal's key." },
      deadlineMs: { type: "number", description: "The wait's deadline in milliseconds." },
    },
    required: ["key"],
    additionalProperties: false,
  },
  defaultPolicy: "allow",
};

const NOWATCH: ToolSpec = {
  name: "nowatch",
  description: "Ask for a watched wait without a watcher. Test fixture only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  defaultPolicy: "allow",
};

const TTL = { ttlSeconds: 3600 };

const waitForm = (key: string, deadlineMs: number): InputRequired => ({
  kind: "input_required",
  form: {
    title: { zh: `等待信号 ${key}`, en: `Waiting for signal ${key}` },
    fields: [
      {
        key: "end",
        label: { zh: "结束等待", en: "End the wait" },
        schema: { type: "string", enum: ["end"] },
        required: true,
        choices: [{ value: "end", label: { zh: "结束等待", en: "End wait" } }],
      },
    ],
  },
  state: { key },
  watch: { deadlineMs },
});

async function watch(ctx: ExtensionContext, w: ToolWatchContext): Promise<"settle" | "pending"> {
  const key = (w.state as { key?: string } | null)?.key ?? "";
  await ctx.kv.incr(`fake-watch:${key}:polls`, TTL);
  await ctx.kv.set(
    `fake-watch:${key}:ctx`,
    JSON.stringify({
      orgId: w.orgId,
      accountId: w.accountId,
      ownerAccountId: w.ownerAccountId,
      conversationId: w.conversationId,
      rootConversationId: w.rootConversationId,
      callId: w.callId,
      idempotencyKey: w.idempotencyKey,
      role: w.role,
      source: w.source,
      state: w.state,
    }),
    TTL,
  );
  const signal = await ctx.kv.get(`fake-watch:${key}`);
  if (signal === "go") return "settle";
  if (signal === "fail") throw new Error("scripted watcher failure");
  if (signal === "hang") return new Promise<never>(() => {});
  return "pending";
}

export default defineExtension({
  name: "fake-watch",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { tools: ["wait", "nowatch"] },
  setup(ctx) {
    ctx.tools.register(
      WAIT,
      async (input, call) => {
        const { key, deadlineMs } = input as { key: string; deadlineMs?: number };
        if (call.resume === undefined) return waitForm(key, deadlineMs ?? 60_000);
        const signal = await ctx.kv.get(`fake-watch:${key}`);
        await ctx.kv.set(
          `fake-watch:${key}:handler`,
          JSON.stringify({
            callId: call.callId,
            idempotencyKey: call.idempotencyKey,
            conversationId: call.conversationId,
            rootConversationId: call.rootConversationId,
          }),
          TTL,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                outcome: call.resume.outcome,
                answer: call.resume.answer,
                signal,
              }),
            },
          ],
        };
      },
      { watch: (w) => watch(ctx, w) },
    );
    ctx.tools.register(NOWATCH, async () => waitForm("none", 60_000));
  },
});
