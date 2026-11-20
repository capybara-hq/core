import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// The SDK declares "sideEffects": false, so a consumer that imports one constant (the desktop
// app's shell capability keys) gets only that module, not every zod schema in the package.
async function bundle(source: string): Promise<string> {
  const result = await build({
    stdin: { contents: source, resolveDir: import.meta.dirname, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    treeShaking: true,
    minify: false,
    conditions: ["@capybara-hq/source"],
    external: ["node:*", "zod", "yaml", "semver", "saxes", "kysely", "mdast-util-*", "micromark-*"],
    logLevel: "silent",
  });
  return result.outputFiles[0]?.text ?? "";
}

describe("plugin-sdk tree shaking", () => {
  it("keeps one imported constant from pulling in unrelated modules", async () => {
    const out = await bundle(
      `import { SHELL_CAPABILITY_KEYS } from "@capybara-hq/plugin-sdk"; console.log(SHELL_CAPABILITY_KEYS);`,
    );
    expect(out).toContain("SHELL_CAPABILITY_KEYS");
    expect(out).not.toContain("MarketplaceManifestSchema");
    expect(out).not.toContain("defineExtension");
    expect(out.length).toBeLessThan(5_000);
  });
});
