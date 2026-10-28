import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "perm-marker",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup(ctx) {
    void ctx.secrets.get("org", "token"); // FLAG // capybara:allow-dynamic-permission not exemptible
    ctx.http.route("GET", "/x", async () => Response.json({})); // FLAG // capybara:allow-dynamic-permission not exemptible
    ctx.tools.register({ name: "t", description: "x" }, async () => ({ content: "" })); // FLAG // capybara:allow-dynamic-permission not exemptible
    ctx.extensionPoints.get("channel@1"); // FLAG // capybara:allow-dynamic-permission not exemptible
    void ctx.storage; // FLAG // capybara:allow-dynamic-permission not exemptible
    // capybara:allow-dynamic-permission not exemptible
    void ctx.models; // FLAG
    // capybara:allow-dynamic-permission not exemptible
    ctx.ui.view("v", async () => ({ blocks: [] })); // FLAG
  },
});
