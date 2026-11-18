import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The pnpm patch `patches/@anthropic-ai__sandbox-runtime@0.0.81.patch` changes the macOS Seatbelt
// profile. It is pinned to srt 0.0.81: drop the patch and these tests when srt is upgraded or
// upstream covers what it adds.
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json"));
const macUtils = join(root, "dist/sandbox/macos-sandbox-utils.js");

describe("sandbox-runtime Chrome sysctl patch", () => {
  it("allows hw.product and kern.hv_vmm_present in the macOS profile", () => {
    const source = readFileSync(macUtils, "utf8");
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

// The exact read allows (`filesystem.allowReadExact`): a restricted macOS command may list a
// directory or follow a link without reading anything below it. Upstream renders every read
// allow, `{ path, literal: true }` included, as `(subpath …)`, which on an ancestor such as `/`
// re-opened the whole disk.
describe("sandbox-runtime exact read allow patch", () => {
  const profile = async (exact: string[]) => {
    const { wrapCommandWithSandboxMacOS } = await import(pathToFileURL(macUtils).href);
    return wrapCommandWithSandboxMacOS({
      command: "true",
      needsNetworkRestriction: false,
      readConfig: { denyOnly: ["/"], allowWithinDeny: ["/usr"], exactAllowWithinDeny: exact },
      writeConfig: undefined,
      binShell: "bash",
    }) as string;
  };

  it("renders each exact allow as one (literal …) read allow, never a subpath", async () => {
    const out = await profile(["/Users/someone", "/tmp", "/"]);
    // each multi-line rule ends with its log tag: `(allow file-read*\n  (filter)…(with message`
    const allows = out.match(/\(allow file-read\*\n[\s\S]*?\(with message/g) ?? [];
    const block = allows.find((b) => b.includes('(subpath "/usr")')) ?? "";
    expect(block).toContain('(literal "/Users/someone")');
    expect(block).toContain('(literal "/tmp")');
    expect(out).not.toContain('(subpath "/Users/someone")');
    expect(out).not.toContain('(subpath "/tmp")');
    for (const allow of allows) expect(allow).not.toContain('(subpath "/")');
  });

  it("refuses an exact allow that is not an absolute, normalized path", async () => {
    for (const bad of ["relative", "/a/../b", "/a/", "/a//b"])
      await expect(profile([bad]), bad).rejects.toThrow(/exact read allow/);
  });
});
