import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkOrgOverride } from "../../src/check/org-override.js";

const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));
const red = join(fixtures, "org-override-unbound");

describe("checkOrgOverride", () => {
  it("warns when an override field has no entry point to carry it", async () => {
    const f = await checkOrgOverride([red]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "plugin-org-override-unbound", severity: "warning" });
    expect(f[0]?.message).toContain("region");
  }, 60_000);

  it("reports nothing once the extension registers a tool", async () => {
    const dir = await mkdtemp(join(fixtures, ".tmp-org-override-"));
    try {
      await cp(red, dir, { recursive: true });
      const file = join(dir, "src/index.ts");
      const src = await readFile(file, "utf8");
      await writeFile(
        file,
        src.replace(
          "setup() {},",
          `setup(ctx) {
    ctx.tools.register({ name: "noop" } as never);
  },`,
        ),
      );
      expect(await checkOrgOverride([dir])).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports nothing for a plugin without override fields", async () => {
    expect(await checkOrgOverride([join(fixtures, "../../fixtures/plugin-config-labels")])).toEqual(
      [],
    );
  }, 60_000);
});
