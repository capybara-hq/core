import { defineExtension } from "@capybara-hq/plugin-sdk";
import { FakeWebOrgConfig, makeFakeWeb } from "./web.js";

/** Test fake: `fake-web` under another name (a second provider of `web-search@1` / `web-fetch@1`). */
export default defineExtension({
  name: "fake-web-2",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["web-search@1", "web-fetch@1"],
  config: { org: FakeWebOrgConfig },
  setup(ctx) {
    const { search, fetch } = makeFakeWeb("fake-web-2");
    ctx.provide("web-search@1", search);
    ctx.provide("web-fetch@1", fetch);
  },
});
