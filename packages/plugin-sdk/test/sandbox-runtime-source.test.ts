import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

describe("sandbox runtime source bundle", () => {
  it("ships the native helper and the Linux launcher as immutable bytes with exact digests", () => {
    expect(sdk).toHaveProperty("SANDBOX_RUNTIME_SOURCE");
    const bundle = sdk.SANDBOX_RUNTIME_SOURCE;
    expect(bundle.version).toBe(2);
    expect(bundle.files.map((file) => file.name)).toEqual(["native-files.py", "linux-sandbox.py"]);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.files)).toBe(true);
    for (const file of bundle.files) {
      expect(Object.isFrozen(file)).toBe(true);
      expect(file.source.length).toBeGreaterThan(0);
      expect(file.sha256).toBe(createHash("sha256").update(file.source).digest("hex"));
      expect(() => Object.assign(file, { source: "replaced" })).toThrow();
    }
    expect(Object.keys(bundle).sort()).toEqual(["files", "version"]);
  });

  it("keeps SDK source packaging free of Node runtime imports and I/O", async () => {
    for (const name of [
      "sandbox-runtime-source.ts",
      "sandbox-native-runtime-source.ts",
      "sandbox-linux-runtime-source.ts",
    ]) {
      const source = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/(?:from\s*|import\s*\()["'](?:node:|fs|child_process|crypto)/);
      expect(source).not.toMatch(/\b(?:readFileSync|writeFileSync|execFileSync|process\.env)\b/);
    }
  });

  it("fails closed outside the validated inventory and never reopens a root pathname", () => {
    const linux = sdk.SANDBOX_RUNTIME_SOURCE.files.find((f) => f.name === "linux-sandbox.py");
    const source = linux?.source ?? "";
    // Only architectures whose syscall inventory ran on a real kernel may report support.
    expect(source).toContain('VALIDATED_ARCHES = ("aarch64",)');
    expect(source).toContain("LANDLOCK_ABI_REQUIRED = 6");
    // Root descriptors arrive pinned; the launcher only fstat()s and readlink()s them.
    expect(source).not.toMatch(/os\.open\(\s*(?:entry|root)\[["']path["']\]/);
    expect(source).not.toMatch(/os\.open\(\s*path\s*,\s*os\.O_RDONLY\s*\|\s*os\.O_DIRECTORY/);
  });
});
