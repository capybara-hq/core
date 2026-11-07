import { defineExtension, type ExtensionContext } from "@capybara-hq/plugin-sdk";

/** The running instance's ctx, shared with the test (same process; set by `setup`). */
export function embedConsumer(): { ctx: ExtensionContext | undefined } {
  const g = globalThis as { __embedConsumer?: { ctx: ExtensionContext | undefined } };
  g.__embedConsumer ??= { ctx: undefined };
  return g.__embedConsumer;
}

/**
 * Declares one embedding purpose (`embed-consumer.memory`, `permissions.models`): purpose targets
 * must be of the purpose's kind (model platform spec B §5.3), and `ctx.models.embed` / `describe`
 * accept only it (§5.4). The tool `remember` (allowed by default) embeds its texts and describes the
 * purpose's model; the route `POST /embed` (`{ orgId, input }`) embeds and lets errors escape.
 */
export default defineExtension({
  name: "embed-consumer",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {
    tools: ["remember"],
    http: [{ method: "POST", path: "/embed" }],
    models: [
      {
        purpose: "embed-consumer.memory",
        kind: "embedding",
        label: { zh: "记忆", en: "Memory" },
      },
    ],
  },
  setup(ctx) {
    embedConsumer().ctx = ctx;
    ctx.tools.register(
      {
        name: "remember",
        description: "Embed the given texts into memory and report the embedding model.",
        inputSchema: {
          type: "object",
          properties: { texts: { type: "array", items: { type: "string" } } },
          required: ["texts"],
        },
        defaultPolicy: "allow",
      },
      async (input, call) => {
        const { texts } = input as { texts: string[] };
        const purpose = "embed-consumer.memory";
        const model = await ctx.models.describe({ orgId: call.orgId, purpose });
        const out = await ctx.models.embed({ orgId: call.orgId, purpose, input: texts });
        const text = JSON.stringify({
          model,
          count: out.vectors.length,
          dimensions: out.dimensions,
        });
        return { content: [{ type: "text", text }] };
      },
    );
    ctx.http.route("POST", "/embed", async (req) => {
      const { orgId, input } = (await req.json()) as { orgId: string; input: string[] };
      const out = await ctx.models.embed({ orgId, purpose: "embed-consumer.memory", input });
      return Response.json({ count: out.vectors.length });
    });
  },
});
