import { defineExtension } from "@capybara-hq/plugin-sdk";
import { FakeWebOrgConfig, makeFakeWeb } from "./web.js";

export { type FakeWebCall, FakeWebOrgConfig, fakeWebProbe, makeFakeWeb } from "./web.js";

/**
 * Test fake: a scripted web provider (`web-search@1` and `web-fetch@1`; see `makeFakeWeb` for the
 * scripts). Org config `{ token? }` (secret); `configured()` is true iff the token is set.
 * `fake-web-2` is the same with its own name, for the org default provider.
 */
export default defineExtension({
  name: "fake-web",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["web-search@1", "web-fetch@1"],
  config: { org: FakeWebOrgConfig },
  setup(ctx) {
    const { search, fetch } = makeFakeWeb("fake-web");
    ctx.provide("web-search@1", search);
    ctx.provide("web-fetch@1", fetch);
  },
});
