import { defineExtension } from "@capybara-hq/plugin-sdk";

/**
 * Conversation tree probe: `where` returns the call's conversation and its tree root as the
 * tool result, so a test can read what a handler saw at any sub-agent depth.
 */
export default defineExtension({
  name: "tree-probe",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { tools: ["where"] },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "where",
        description: "Return the conversation and the conversation tree root of this call.",
        inputSchema: { type: "object" },
        defaultPolicy: "allow",
      },
      async (_input, tctx) => ({
        content: [
          {
            type: "text",
            text: `conversation=${tctx.conversationId} root=${tctx.rootConversationId}`,
          },
        ],
      }),
    );
  },
});
