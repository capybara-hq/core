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
    // The profile generator is not exported: check the lines sit inside the `(allow sysctl-read`
    // block (it ends at the first line that is only `)`), not in sysctl-write or elsewhere.
    const start = source.indexOf("'(allow sysctl-read',");
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf("')',", start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    expect(block).toContain(`'  (sysctl-name "hw.product")',`);
    expect(block).toContain(`'  (sysctl-name "kern.hv_vmm_present")',`);
    expect(source.indexOf('(sysctl-name "hw.product")', end)).toBe(-1);
  });
});
