// Fixture: a channel extension whose plugin ships a setup guide (no channel code: pack only needs
// the static manifest).
import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "fixture-guides-channel",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@1"],
  setup() {},
});
