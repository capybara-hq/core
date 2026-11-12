import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// The pnpm patch `patches/@anthropic-ai__sandbox-runtime@0.0.81.patch` adds the sysctls Chrome
// reads at startup to the macOS Seatbelt profile. It is pinned to srt 0.0.81: drop the patch and
// this test when srt is upgraded or upstream adds them.
describe("sandbox-runtime Chrome sysctl patch", () => {
  it("allows hw.product and kern.hv_vmm_present in the macOS profile", () => {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json"));
    const source = readFileSync(join(root, "dist/sandbox/macos-sandbox-utils.js"), "utf8");
    expect(source).toContain('(sysctl-name "hw.product")');
    expect(source).toContain('(sysctl-name "kern.hv_vmm_present")');
  });
});
