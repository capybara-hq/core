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

/** A web-search extension variant: extra imports, deployment fields, and the `search` body. */
interface Variant {
  imports?: string;
  top?: string;
  fields: string;
  body: string;
}

const ROUTER = `import { configUrlFetch } from "@capybara-hq/plugin-sdk";`;

const VARIANTS: Record<string, Variant> = {
  // red: `.origin` of a URL built from another field does not route a field named `origin`
  origin: {
    imports: ROUTER,
    fields: "baseUrl: z.url(), origin: z.url()",
    body: `const f = configUrlFetch(ctx.net, { url: config.baseUrl, orgId });
        const g = configUrlFetch(ctx.net, { url: new URL(config.baseUrl).origin, orgId });
        await f(config.baseUrl);
        await g(config.origin);`,
  },
  // red: an intermediate member (`opts.config`) does not route a field named `config`
  "config-named": {
    imports: ROUTER,
    fields: "baseUrl: z.url(), config: z.url()",
    body: `const f = configUrlFetch(ctx.net, { url: opts.config.baseUrl, orgId });
        await f(opts.config.config);`,
  },
  // red: a dropped configUrlFetch result next to the global fetch
  dead: {
    imports: ROUTER,
    fields: "baseUrl: z.url()",
    body: `configUrlFetch(ctx.net, { url: config.baseUrl, orgId });
        await fetch(config.baseUrl);`,
  },
  // red: a configUrlFetch of the plugin's own, not the SDK's
  local: {
    top: "const configUrlFetch = (_n: unknown, o: { url: string }) => (u: string) => fetch(u || o.url);",
    fields: "baseUrl: z.url()",
    body: "await configUrlFetch(ctx.net, { url: config.baseUrl })(config.baseUrl);",
  },
  // green: a renamed import
  renamed: {
    imports: `import { configUrlFetch as cuf } from "@capybara-hq/plugin-sdk";`,
    fields: "baseUrl: z.url()",
    body: "await cuf(ctx.net, { url: config.baseUrl, orgId })(config.baseUrl);",
  },
  // green: a namespace import
  namespace: {
    imports: `import * as sdk from "@capybara-hq/plugin-sdk";`,
    fields: "baseUrl: z.url()",
    body: `const f = sdk.configUrlFetch(ctx.net, { url: config.baseUrl, orgId });
        await f(config.baseUrl);`,
  },
  // green: a string-literal member
  bracket: {
    imports: ROUTER,
    fields: "baseUrl: z.url()",
    body: `const f = configUrlFetch(ctx.net, { url: config["baseUrl"], orgId });
        await f(config.baseUrl);`,
  },
  // green: an optional chain
  optional: {
    imports: ROUTER,
    fields: "baseUrl: z.url()",
    body: `const f = configUrlFetch(ctx.net, { url: opts.config?.baseUrl ?? "", orgId });
        await f(config.baseUrl);`,
  },
  // red: a tuple element (prefixItems) and a URL inside a recursive schema ($ref into $defs)
  shapes: {
    top: `const Node = z.object({
  name: z.string(),
  nodeUrl: z.url().optional(),
  get children() {
    return z.array(Node).optional();
  },
});`,
    fields: "mirrors: z.tuple([z.url()]), tree: Node",
    body: `await fetch("https://example.com");`,
  },
  // red: an array and a record of plain strings named like URLs; an enum host is not one
  lists: {
    fields: `mirrorUrls: z.array(z.string()),
  regionEndpoint: z.record(z.string(), z.string()),
  apiHost: z.enum(["a.example.com", "b.example.com"])`,
    body: `await fetch("https://example.com");`,
  },
};

const variantSource = (v: Variant) => `${v.imports ?? ""}
import { defineExtension } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

${v.top ?? ""}

const deployment = z.object({
  ${v.fields},
});

type Config = z.infer<typeof deployment>;

export default defineExtension({
  name: "fixture-org-url-variant",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["web-search@1"],
  config: { deployment },
  setup(ctx) {
    ctx.provide("web-search@1", {
      async search(_q: string, opts: { config: Config; orgId: string }) {
        const { config, orgId } = opts;
        ${v.body}
      },
    });
  },
});
`;

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
  for (const [name, v] of Object.entries(VARIANTS)) {
    const dir = await mkdtemp(join(fixtures, `.tmp-org-url-${name}-`));
    try {
      await cp(fixture("org-url-unrouted"), dir, { recursive: true });
      await writeFile(join(dir, "src/index.ts"), variantSource(v));
      found.set(name, await checkConfigClassification([dir]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
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

  const urlFindings = (name: string) =>
    (found.get(name) ?? []).map((f) => [f.rule, f.message.split(" ")[4]]);

  it("a name inside a call or new, or an intermediate member, routes nothing", () => {
    expect(urlFindings("origin")).toEqual([["plugin-org-url-net", "origin"]]);
    expect(urlFindings("config-named")).toEqual([["plugin-org-url-net", "config"]]);
  });

  it("a dropped configUrlFetch result routes nothing", () => {
    expect(urlFindings("dead")).toEqual([["plugin-org-url-net", "baseUrl"]]);
  });

  it("only the SDK's configUrlFetch routes, imported named, renamed or as a namespace", () => {
    expect(urlFindings("local")).toEqual([["plugin-org-url-net", "baseUrl"]]);
    expect(found.get("renamed")).toEqual([]);
    expect(found.get("namespace")).toEqual([]);
    expect(found.get("bracket")).toEqual([]);
    expect(found.get("optional")).toEqual([]);
  });

  it("walks tuple elements and recursive $refs", () => {
    expect(urlFindings("shapes")).toEqual([
      ["plugin-org-url-net", "mirrors[]"],
      ["plugin-org-url-net", "tree.nodeUrl"],
    ]);
  });

  it("flags arrays and records of plain strings named like URLs, not an enum", () => {
    expect(urlFindings("lists")).toEqual([
      ["plugin-org-url-net", "mirrorUrls"],
      ["plugin-org-url-net", "regionEndpoint"],
    ]);
  });
});
