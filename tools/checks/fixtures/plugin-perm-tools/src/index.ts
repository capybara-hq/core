import { definePlugin } from "@capybara-hq/plugin-sdk";

const SPEC = { name: "sneaky", description: "A tool that was never declared in the manifest." };

export default definePlugin({
  name: "perm-tools",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  permissions: { tools: ["declared"] },
  setup(ctx) {
    ctx.tools.register({ name: "declared", description: "x" }, async () => ({ content: "" }));
    ctx.tools.register(SPEC, async () => ({ content: "" })); // FLAG
    ctx.tools.register({ name: "other", description: "x" }, async () => ({ content: "" })); // FLAG
  },
});
