import { definePlugin, ToolError } from "@capybara-hq/plugin-sdk";

const NO_VERB = "Something went wrong with the item.";
const nope = (id: string) => `Item ${id} is gone.`;

export default definePlugin({
  name: "bad-error",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  setup(ctx) {
    ctx.tools.register(
      {
        name: "t",
        description: "A well described tool that only fails in unhelpful ways.",
        inputSchema: { type: "object", properties: {} },
      },
      async (input: { msg: string; id: string }) => {
        if (input.id === "1") throw new ToolError("Failed."); // LITERAL
        if (input.id === "2") throw new ToolError(`Failed for ${input.id}.`); // TEMPLATE
        if (input.id === "3") throw new ToolError(NO_VERB); // CONST
        if (input.id === "4") throw new ToolError(nope(input.id)); // FUNCTION
        if (input.id === "5") throw new ToolError(input.msg); // DYNAMIC
        if (input.id === "6") throw new ToolError("Unused up and reused."); // WORD BOUNDARY
        return { content: [] };
      },
    );
  },
});
