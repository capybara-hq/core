import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkConfigClassification } from "../../src/check/config-classification.js";
import type { Finding } from "../../src/check/source.js";

const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));
const fixture = (name: string) => join(fixtures, name);

const NAMES = [
  "config-unbound",
  "config-bound-clean",
  "org-url-unrouted",
  "org-url-named",
  "org-url-routed",
] as const;

/** Findings per fixture; every plugin is bundled once, in `beforeAll`. */
const found = new Map<string, Finding[]>();
let tmp: string;

const lineOf = async (file: string, text: string) =>
  (await readFile(file, "utf8")).split("\n").findIndex((l) => l.includes(text)) + 1;

beforeAll(async () => {
  // A root platformOnly extension that also registers a tool: no false positive on marked roots.
  tmp = await mkdtemp(join(fixtures, ".tmp-config-classification-"));
  await cp(fixture("config-bound-clean"), tmp, { recursive: true });
  const file = join(tmp, "src/index.ts");
  const src = await readFile(file, "utf8");
  await writeFile(
    file,
    src.replace(
      "setup() {},",
      `setup(ctx) {\n    ctx.tools.register({ name: "noop" } as never);\n  },`,
    ),
  );
  for (const name of NAMES) found.set(name, await checkConfigClassification([fixture(name)]));
  found.set("tools", await checkConfigClassification([tmp]));
});

afterAll(async () => {
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
});

describe("checkConfigClassification", () => {
  it("plugin-config-unbound: an overridable field with no org-bound entry is an error", () => {
    const f = found.get("config-unbound") ?? [];
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      rule: "plugin-config-unbound",
      file: join(fixture("config-unbound"), "src/index.ts"),
      line: 1,
    });
    expect(f[0]?.severity).toBeUndefined();
    expect(f[0]?.message).toContain("region");
    expect(f[0]?.message).toContain("platformOnly");
  });

  it("reports nothing for a root platformOnly schema, with or without tools", () => {
    expect(found.get("config-bound-clean")).toEqual([]);
    expect(found.get("tools")).toEqual([]);
  });

  it("plugin-org-url-net: an overridable URL fetched outside configUrlFetch", async () => {
    const f = found.get("org-url-unrouted") ?? [];
    const file = join(fixture("org-url-unrouted"), "src/index.ts");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      rule: "plugin-org-url-net",
      file,
      line: await lineOf(file, "baseUrl: ui("),
    });
    expect(f[0]?.severity).toBeUndefined();
    expect(f[0]?.message).toContain("baseUrl");
    expect(f[0]?.message).toContain("configUrlFetch");
  });

  it("plugin-org-url-net: an overridable endpoint declared as a plain string", async () => {
    const f = found.get("org-url-named") ?? [];
    const file = join(fixture("org-url-named"), "src/index.ts");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      rule: "plugin-org-url-net",
      file,
      line: await lineOf(file, "apiEndpoint: ui("),
    });
    expect(f[0]?.message).toContain("apiEndpoint");
    expect(f[0]?.message).toContain("z.url()");
  });

  it("reports nothing when every overridable URL goes through configUrlFetch", () => {
    expect(found.get("org-url-routed")).toEqual([]);
  });
});
