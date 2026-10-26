import { defineExtension, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test fake of an extension that uses `ctx.storage` (`permissions.storage`): tool `note`
 * (model-visible `fake-storage-user__note`) writes the text to `notes/<conversationId>.txt`, which
 * the kernel prefixes with `plugins/fake-storage-user/<orgId>/`, and returns the stored size; tool
 * `read_note` returns it (or says there is none). Needs an `object-store@1` provider.
 */

const NoteInput = z.object({ text: z.string().max(10_000) });

const NOTE: ToolSpec = {
  name: "note",
  description:
    "Store a text note for the current conversation in object storage. Test fixture only.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 10_000, description: "The note text." } },
    required: ["text"],
    additionalProperties: false,
  },
};

const READ_NOTE: ToolSpec = {
  name: "read_note",
  description: "Read the text note stored for the current conversation. Test fixture only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

const keyOf = (conversationId: string) => `notes/${conversationId}.txt`;

export default defineExtension({
  name: "fake-storage-user",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  permissions: { tools: ["note", "read_note"], storage: true },
  setup(ctx) {
    ctx.tools.register(NOTE, async (input, tctx) => {
      const parsed = NoteInput.safeParse(input);
      if (!parsed.success) throw new ToolError("Invalid note: pass { text } with a string text.");
      const head = await ctx.storage.put(
        tctx.orgId,
        keyOf(tctx.conversationId),
        new TextEncoder().encode(parsed.data.text),
        { contentType: "text/plain" },
      );
      return { content: [{ type: "text", text: `Stored the note (${head.size} bytes).` }] };
    });
    ctx.tools.register(READ_NOTE, async (_input, tctx) => {
      const got = await ctx.storage.get(tctx.orgId, keyOf(tctx.conversationId));
      const text = got === null ? "There is no note yet." : await new Response(got.body).text();
      return { content: [{ type: "text", text }] };
    });
  },
});
