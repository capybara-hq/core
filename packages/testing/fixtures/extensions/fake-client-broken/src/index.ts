import { defineExtension } from "@capybara-hq/plugin-sdk";

const t = (zh: string, en: string) => ({ zh, en });

/**
 * Test fake of a client extension whose browser code is broken, for the host's isolation (error
 * boundaries, the crash budget, safe mode): component `boom` (`conversation.properties.section`)
 * throws on render, the module-level `events` listener throws on `run.started`, and `empty`
 * (`conversation.empty`) throws on render. No server side beyond the declarations.
 */
export default defineExtension({
  name: "fake-client-broken",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    {
      id: "boom",
      title: t("崩溃", "Boom"),
      slot: "conversation.properties.section",
      kind: "component",
    },
    { id: "empty", title: t("问候", "Greeting"), slot: "conversation.empty", kind: "component" },
  ],
  permissions: { client: true, ui: { components: ["boom", "empty"] } },
  setup() {},
});
