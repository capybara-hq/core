import { definePlugin } from "@capybara-hq/plugin-sdk";

export default definePlugin({
  name: "perm-marker",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  setup(ctx) {
    void ctx.secrets.get("org", "token"); // FLAG // capybara:allow-dynamic-permission not exemptible
    ctx.http.route("GET", "/x", async () => Response.json({})); // FLAG // capybara:allow-dynamic-permission not exemptible
    ctx.tools.register({ name: "t", description: "x" }, async () => ({ content: "" })); // FLAG // capybara:allow-dynamic-permission not exemptible
    ctx.capabilities.get("channel@1"); // FLAG // capybara:allow-dynamic-permission not exemptible
    void ctx.storage; // FLAG // capybara:allow-dynamic-permission not exemptible
    // capybara:allow-dynamic-permission not exemptible
    void ctx.models; // FLAG
  },
});
