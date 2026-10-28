import { defineExtension } from "@capybara-hq/plugin-sdk";

const schema = { type: "object", properties: {} };
const DESC = "Looks fine but is not a literal at the call site, so it cannot be checked.";
const NO_DESC = { name: "nodesc", inputSchema: schema };

export default defineExtension({
  name: "bad-description",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup(ctx) {
    ctx.tools.register({ name: "short", description: "Too short", inputSchema: schema }, async () => ({ content: [] })); // SHORT
    ctx.tools.register(
      { name: "cjk", description: "这个工具用来写入待办清单，模型可见的描述必须是英文。", inputSchema: schema },
      async () => ({ content: [] }),
    );
    ctx.tools.register({ name: "dyn", description: DESC.toUpperCase(), inputSchema: schema }, async () => ({ content: [] }));
    ctx.tools.register(NO_DESC, async () => ({ content: [] })); // MISSING
    ctx.tools.register(buildSpec(), async () => ({ content: [] }));
  },
});

declare function buildSpec(): never;

export const builtin = {
  spec: { name: "b", description: "short", inputSchema: schema },
  async run() {
    return { content: [] };
  },
};
