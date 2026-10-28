import { defineExtension, type ExtensionContext } from "@capybara-hq/plugin-sdk";

const SPEC = { name: "write", description: "Write something to the store for the conversation." };
const ROUTE = "/count";

function mount(c: ExtensionContext): void {
  c.http.route("GET", ROUTE, async () => Response.json({}));
  c.tools.register(SPEC, async () => ({ content: "ok" }));
}

function deeper(ctx: ExtensionContext): void {
  void ctx.secrets.get("org", "token");
  void ctx.extensionPoints.get<unknown>("counter@1");
}

export default defineExtension({
  name: "perm-clean",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  requires: ["counter@1"],
  optional: ["model-provider@2"],
  permissions: {
    secrets: true,
    http: [{ method: "GET", path: "/count" }],
    tools: ["write"],
  },
  setup(ctx) {
    const alias = ctx;
    mount(alias);
    deeper(ctx);
    void ctx.extensionPoints.list("model-provider@2");
  },
});
