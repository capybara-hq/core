import { defineExtension, ToolError } from "@capybara-hq/plugin-sdk";
import { externalText } from "./elsewhere.js";

const SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const SPEC = {
  name: "second",
  description:
    "Does the second thing for the model. " + "Use it after the first tool; do not use it twice.",
  inputSchema: SCHEMA,
};
const NOT_FOUND = "Item not found; call list first to get a valid id.";
const gone = (id: string) => `Item ${id} is gone. Ask the user whether to recreate it.`;

export default defineExtension({
  name: "clean-tools",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup(ctx) {
    ctx.tools.register(
      {
        name: "first",
        description: "Does the first thing for the model; use it to start a task.",
        inputSchema: SCHEMA,
      },
      async (input: { id?: string }) => {
        if (input.id === undefined) throw new ToolError("Missing id; pass an id and retry.");
        if (input.id === "x") throw new ToolError(NOT_FOUND);
        if (input.id === "y") throw new ToolError(gone(input.id));
        if (input.id === "z") throw new ToolError(externalText(input.id));
        if (input.id === "w") throw new ToolError(`Bad id ${input.id}; check it and try again.`);
        return { content: [{ type: "text", text: "ok" }] };
      },
    );
    ctx.tools.register(SPEC, async () => ({ content: [] }));
  },
});
