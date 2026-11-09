import { defineExtension } from "@capybara-hq/plugin-sdk";

/**
 * A second contributor to the single slot `shell.brand` (component `brand`), so the arrangement's
 * `use` can name an extension the org switched off while the platform picked another.
 */
export default defineExtension({
  name: "ui-components-b",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    { id: "brand", title: { zh: "品牌 B", en: "Brand B" }, slot: "shell.brand", kind: "component" },
  ],
  permissions: { client: true, ui: { components: ["brand"] } },
  setup() {},
});
