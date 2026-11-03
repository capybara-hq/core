import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { declaredDisplayName } from "../../src/extensions/package.js";

const NAME = { zh: "密钥", en: "Keys" };

/** The display name of a config-declared extension comes from its own plugin's plugin.json. */
describe("declaredDisplayName", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cap-declared-name-"));
    await writeFile(join(root, "package.json"), "{}");
    await mkdir(join(root, ".capybara-plugin"));
    await writeFile(
      join(root, ".capybara-plugin", "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "keys",
        displayName: NAME,
        version: "0.1.0",
        publisher: "Test",
        description: "Keys",
      }),
    );
    await mkdir(join(root, "src"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the plugin.json beside the nearest package.json when its name is the extension's", async () => {
    expect(await declaredDisplayName(join(root, "src"), "keys")).toEqual({ displayName: NAME });
  });

  it("ignores a plugin.json of another plugin (no display name)", async () => {
    expect(await declaredDisplayName(join(root, "src"), "other")).toEqual({});
  });
});
