import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  type MarketplaceEntry,
  type MarketplaceManifest,
  MarketplaceManifestSchema,
  marketplaceEntryVersion,
  parseMarketplaceManifest,
} from "../src/index.js";

const SHA512 = `sha512-${"A".repeat(86)}==`;
const SHA256 = `sha256-${"B".repeat(43)}=`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "superpowers",
  summary: { en: "Skills for agents", zh: "智能体技能" },
  source: { path: "./plugins/superpowers" },
  ...over,
});

const manifest = (plugins: unknown[] = [entry()], over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  name: "capybara-official",
  owner: { name: "Capybara", url: "https://capybarahq.com" },
  description: "The official marketplace",
  plugins,
  ...over,
});

const errorsOf = (json: unknown, opts?: Parameters<typeof parseMarketplaceManifest>[1]) => {
  const r = parseMarketplaceManifest(json, opts);
  return "errors" in r ? r.errors : [];
};

const sources = {
  path: { path: "./plugins/superpowers" },
  git: { git: { url: "https://github.com/acme/x.git", ref: "main", commit: COMMIT, path: "." } },
  npm: { npm: { package: "@acme/superpowers", version: "7.0.1", integrity: SHA512 } },
  archive: { archive: { url: "https://example.com/x.tgz", integrity: SHA256 } },
};

describe("parseMarketplaceManifest", () => {
  for (const [form, source] of Object.entries(sources)) {
    it(`the ${form} source parses`, () => {
      expect(errorsOf(manifest([entry({ source })]))).toEqual([]);
    });
  }

  it("a full entry parses", () => {
    const e = entry({
      version: "7.0.1",
      minKernel: "0.1.0",
      permissions: { keys: ["network:api.example.com"], sensitive: ["network:api.example.com"] },
      homepage: "https://example.com/superpowers",
    });
    expect(errorsOf(manifest([e]))).toEqual([]);
  });

  it("git source with only a url and archive with sha512 parse", () => {
    expect(
      errorsOf(
        manifest([
          entry({ source: { git: { url: "https://github.com/acme/x.git" } } }),
          entry({
            name: "y",
            source: { archive: { url: "https://e.com/y.tgz", integrity: SHA512 } },
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it("drops unknown fields", () => {
    const r = parseMarketplaceManifest(
      manifest([entry({ future: 1, source: { path: "./p", extra: 2 } })], { extra: true }),
    ) as MarketplaceManifest;
    expect("errors" in r).toBe(false);
    expect(r).not.toHaveProperty("extra");
    expect(r.plugins[0]).not.toHaveProperty("future");
    expect(r.plugins[0]?.source).toEqual({ path: "./p" });
  });

  it("rejects a duplicate (name, version)", () => {
    expect(errorsOf(manifest([entry(), entry()]))).toEqual([
      "plugins.1.name: duplicate entry superpowers (no version)",
    ]);
    const npm = (v: string) =>
      entry({ source: { npm: { package: "@acme/s", version: v, integrity: SHA512 } } });
    expect(errorsOf(manifest([npm("1.0.0"), npm("1.1.0")]))).toEqual([]);
    expect(errorsOf(manifest([npm("1.0.0"), entry({ version: "1.0.0" })]))).toEqual([
      "plugins.1.name: duplicate entry superpowers 1.0.0",
    ]);
  });

  it("rejects an npm source without integrity", () => {
    const errs = errorsOf(
      manifest([entry({ source: { npm: { package: "@acme/s", version: "1.0.0" } } })]),
    );
    expect(errs).toEqual([
      "plugins.0.source.npm.integrity: Invalid input: expected string, received undefined",
    ]);
  });

  const rejects: [string, Record<string, unknown>, RegExp][] = [
    ["entry name", entry({ name: "Super" }), /^plugins\.0\.name: /],
    ["entry version range", entry({ version: "^1.0.0" }), /^plugins\.0\.version: /],
    ["minKernel", entry({ minKernel: "1" }), /^plugins\.0\.minKernel: /],
    ["homepage http", entry({ homepage: "http://x.example.com" }), /^plugins\.0\.homepage: /],
    [
      "two source forms",
      entry({ source: { ...sources.path, ...sources.npm } }),
      /^plugins\.0\.source: must have exactly one of path, git, npm, archive$/,
    ],
    ["no source form", entry({ source: {} }), /^plugins\.0\.source: must have exactly one of/],
    [
      "unsafe path",
      entry({ source: { path: "./../x" } }),
      /^plugins\.0\.source\.path: path must start/,
    ],
    [
      "git commit not 40 hex",
      entry({ source: { git: { url: "https://g.com/x", commit: "abc" } } }),
      /^plugins\.0\.source\.git\.commit: /,
    ],
    [
      "git http url",
      entry({ source: { git: { url: "http://g.com/x" } } }),
      /^plugins\.0\.source\.git\.url: must be an https URL/,
    ],
    [
      "npm version range",
      entry({ source: { npm: { package: "@a/s", version: "^1.0.0", integrity: SHA512 } } }),
      /^plugins\.0\.source\.npm\.version: /,
    ],
    [
      "archive md5 integrity",
      entry({ source: { archive: { url: "https://e.com/x.tgz", integrity: "md5-abc" } } }),
      /^plugins\.0\.source\.archive\.integrity: /,
    ],
    [
      "version ≠ npm version",
      entry({ version: "1.0.1", source: sources.npm }),
      /^plugins\.0\.version: .*7\.0\.1/,
    ],
    [
      "sensitive not in keys",
      entry({ permissions: { keys: [], sensitive: ["network:x"] } }),
      /^plugins\.0\.permissions\.sensitive: /,
    ],
  ];
  for (const [label, e, re] of rejects) {
    it(`rejects: ${label}`, () => {
      const errs = errorsOf(manifest([e]));
      expect(
        errs.some((x) => re.test(x)),
        errs.join("\n"),
      ).toBe(true);
    });
  }

  it("rejects a bad top level and never throws", () => {
    expect(errorsOf(manifest([], { schemaVersion: 2 }))[0]).toMatch(/^schemaVersion: /);
    expect(errorsOf(manifest([], { name: "" }))[0]).toMatch(/^name: /);
    expect(errorsOf(undefined).length).toBeGreaterThan(0);
  });

  it("allows loopback http only with allowInsecureLoopback", () => {
    const m = manifest([
      entry({ source: { archive: { url: "http://127.0.0.1:9000/x.tgz", integrity: SHA512 } } }),
    ]);
    expect(errorsOf(m).length).toBeGreaterThan(0);
    expect(errorsOf(m, { allowInsecureLoopback: true })).toEqual([]);
  });

  it("caps errors at 50", () => {
    const m = manifest(Array.from({ length: 60 }, () => entry({ name: "Bad" })));
    expect(errorsOf(m)).toHaveLength(50);
  });
});

describe("marketplaceEntryVersion", () => {
  const e = (over: Record<string, unknown>) => entry(over) as unknown as MarketplaceEntry;
  it("entry version wins, then the npm version, otherwise null", () => {
    expect(marketplaceEntryVersion(e({ version: "7.0.1", source: sources.path }))).toBe("7.0.1");
    expect(marketplaceEntryVersion(e({ source: sources.npm }))).toBe("7.0.1");
    expect(marketplaceEntryVersion(e({ source: sources.path }))).toBeNull();
    expect(marketplaceEntryVersion(e({ source: sources.git }))).toBeNull();
    expect(marketplaceEntryVersion(e({ source: sources.archive }))).toBeNull();
    expect(marketplaceEntryVersion(e({ version: "2.0.0", source: sources.archive }))).toBe("2.0.0");
  });
});

describe("JSON Schema (ajv) agrees with zod", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/marketplace.v1.schema.json", import.meta.url), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const validate = ajv.compile(schema);
  const fixtures: [string, unknown][] = [
    ["valid", manifest()],
    ...Object.entries(sources).map(([k, source]): [string, unknown] => [
      k,
      manifest([entry({ source })]),
    ]),
    ["unknown fields (forward compatible)", manifest([entry({ x: 1 })], { y: 2 })],
    ["schemaVersion 2", manifest([], { schemaVersion: 2 })],
    ["bad name", manifest([entry({ name: "Bad" })])],
    [
      "npm without integrity",
      manifest([entry({ source: { npm: { package: "a", version: "1.0.0" } } })]),
    ],
    ["two source forms", manifest([entry({ source: { ...sources.path, ...sources.npm } })])],
    [
      "git commit",
      manifest([entry({ source: { git: { url: "https://g.com/x", commit: "abc" } } })]),
    ],
  ];
  for (const [label, json] of fixtures) {
    it(label, () => {
      const clean = JSON.parse(JSON.stringify(json));
      expect(validate(clean), JSON.stringify(validate.errors)).toBe(
        MarketplaceManifestSchema.safeParse(clean).success,
      );
    });
  }
});
