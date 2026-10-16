import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@capybara-hq/testing": fileURLToPath(
        new URL("./packages/testing/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["{packages,apps,plugins,tools}/*/test/**/*.test.ts"],
    hookTimeout: 120_000,
  },
});
