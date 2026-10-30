import { defineExtension } from "@capybara-hq/plugin-sdk";

const SCHEMA = { type: "object", properties: {}, additionalProperties: false };

export default defineExtension({
  name: "example-very-long-plugin-name",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {
    tools: ["a_tool_name_of_exactly_forty_chars_x_yzw", "short"],
  },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "a_tool_name_of_exactly_forty_chars_x_yzw",
        description: "Does a thing for the model; use it when asked.",
        inputSchema: SCHEMA,
      },
      async () => ({ content: [] }),
    );
    ctx.tools.register(
      { name: "short", description: "Does a short thing; use it when asked.", inputSchema: SCHEMA },
      async () => ({ content: [] }),
    );
  },
});
