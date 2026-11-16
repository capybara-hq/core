import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

describe("portable native source bundle", () => {
  it("ships only immutable implemented native bytes with an exact digest", () => {
    expect(sdk).toHaveProperty("SANDBOX_RUNTIME_SOURCE");
    const bundle = sdk.SANDBOX_RUNTIME_SOURCE;
    expect(bundle.version).toBe(1);
    expect(bundle.files.map((file) => file.name)).toEqual(["native-files.py"]);
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
    for (const name of ["sandbox-runtime-source.ts", "sandbox-native-runtime-source.ts"]) {
      const source = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/(?:from\s*|import\s*\()["'](?:node:|fs|child_process|crypto)/);
      expect(source).not.toMatch(/\b(?:readFileSync|writeFileSync|execFileSync|process\.env)\b/);
    }
  });
});
