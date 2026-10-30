import { defineExtension } from "@capybara-hq/plugin-sdk";

const SCHEMA = { type: "object", properties: {}, additionalProperties: false };

export default defineExtension({
  name: "todo",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { tools: ["todo_write"] },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "todo_write",
        description: "Writes the task list for the model; use it when asked.",
        inputSchema: SCHEMA,
      },
      async () => ({ content: [] }),
    );
  },
});
