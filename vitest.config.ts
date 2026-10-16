import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{packages,apps,plugins,tools}/*/test/**/*.test.ts"],
  },
});
