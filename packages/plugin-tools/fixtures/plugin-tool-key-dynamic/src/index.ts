import { defineExtension } from "@capybara-hq/plugin-sdk";

const SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const names = ["a", "b"];

export default defineExtension({
  name: "todo",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { tools: ["fixed"] },
  setup(ctx) {
    for (const n of names) {
      ctx.tools.register(
        { name: n, description: "Does a thing for the model; use it when asked.", inputSchema: SCHEMA },
        async () => ({ content: [] }),
      );
    }
    // capybara:allow-dynamic-permission names are two short constants above
    ctx.tools.register(
      { name: names[0] as string, description: "Does a thing for the model; use it when asked.", inputSchema: SCHEMA },
      async () => ({ content: [] }),
    );
  },
});
