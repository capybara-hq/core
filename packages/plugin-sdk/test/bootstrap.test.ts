import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  type BootstrapEntry,
  BootstrapManifestSchema,
  bootstrapFileName,
  parseBootstrapManifest,
} from "../src/index.js";

const SHA512 = `sha512-${"A".repeat(86)}==`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const MARKETPLACE = { url: "https://github.com/capybara-hq/plugins.git", commit: COMMIT };

const workspace = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "openai-compatible",
  source: "workspace",
  path: "plugins/openai-compat",
  version: "0.1.0",
  integrity: SHA512,
  required: true,
  ...over,
});

const npm = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "object-store-s3",
  source: "npm",
  npm: "@capybara-hq/plugin-object-store-s3",
  version: "1.1.0",
  integrity: SHA512,
  required: false,
  ...over,
});

const manifest = (plugins: unknown[] = [workspace()], over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  plugins,
  ...over,
});

const errorsOf = (json: unknown) => {
  const r = parseBootstrapManifest(json);
  return "errors" in r ? r.errors : [];
};

describe("parseBootstrapManifest", () => {
  it("parses a workspace entry", () => {
    const r = parseBootstrapManifest(manifest());
    expect(r).toEqual({ schemaVersion: 1, plugins: [workspace()] });
  });

  it("parses an npm entry with the marketplace", () => {
    const m = manifest([npm(), workspace()], {
      $schema: "https://capybarahq.com/schemas/bootstrap.v1.schema.json",
      marketplace: MARKETPLACE,
    });
    expect(parseBootstrapManifest(m)).toEqual(m);
  });

  it("an empty plugin list parses", () => {
    expect(errorsOf(manifest([]))).toEqual([]);
  });

  it("requires the marketplace once an entry is npm", () => {
    expect(errorsOf(manifest([npm()]))).toEqual([
      'marketplace: required when an entry has source "npm"',
    ]);
  });

  it("rejects duplicate names", () => {
    expect(errorsOf(manifest([workspace(), workspace({ path: "plugins/other" })]))).toEqual([
      "plugins.1.name: duplicate entry openai-compatible",
    ]);
  });

  const rejects: [string, unknown, RegExp][] = [
    [
      "bad integrity",
      manifest([workspace({ integrity: "sha512-abc" })]),
      /^plugins\.0\.integrity: /,
    ],
    [
      "sha256 integrity",
      manifest([workspace({ integrity: `sha256-${"B".repeat(43)}=` })]),
      /^plugins\.0\.integrity: /,
    ],
    ["bad name", manifest([workspace({ name: "Bad" })]), /^plugins\.0\.name: /],
    ["range version", manifest([workspace({ version: "^0.1.0" })]), /^plugins\.0\.version: /],
    ["path outside plugins/", manifest([workspace({ path: "../x" })]), /^plugins\.0\.path: /],
    ["nested path", manifest([workspace({ path: "plugins/a/b" })]), /^plugins\.0\.path: /],
    [
      "bad npm name",
      manifest([npm({ npm: "Not A Name" })], { marketplace: MARKETPLACE }),
      /^plugins\.0\.npm: /,
    ],
    ["missing required", manifest([workspace({ required: undefined })]), /^plugins\.0\.required: /],
    ["unknown source", manifest([workspace({ source: "git" })]), /^plugins\.0\.source: /],
    [
      "npm entry with a path",
      manifest([npm({ path: "plugins/x" })], { marketplace: MARKETPLACE }),
      /^plugins\.0: /,
    ],
    ["unknown top-level key", manifest([], { extra: 1 }), /^: |Unrecognized key/],
    [
      "bad marketplace commit",
      manifest([npm()], { marketplace: { ...MARKETPLACE, commit: "abc" } }),
      /^marketplace\.commit: /,
    ],
    [
      "http marketplace",
      manifest([npm()], { marketplace: { ...MARKETPLACE, url: "http://x.example.com/p.git" } }),
      /^marketplace\.url: /,
    ],
    ["schemaVersion 2", manifest([], { schemaVersion: 2 }), /^schemaVersion: /],
  ];
  for (const [label, json, re] of rejects) {
    it(`rejects: ${label}`, () => {
      const errs = errorsOf(json);
      expect(
        errs.some((x) => re.test(x)),
        errs.join("\n"),
      ).toBe(true);
    });
  }

  it("never throws on garbage", () => {
    expect(errorsOf(undefined).length).toBeGreaterThan(0);
    expect(errorsOf("x").length).toBeGreaterThan(0);
  });

  it("caps errors at 50", () => {
    const m = manifest(Array.from({ length: 60 }, () => workspace({ name: "Bad" })));
    expect(errorsOf(m)).toHaveLength(50);
  });
});

describe("bootstrapFileName", () => {
  it("is <name>-<version>.tgz for both entry kinds", () => {
    expect(bootstrapFileName(workspace() as unknown as BootstrapEntry)).toBe(
      "openai-compatible-0.1.0.tgz",
    );
    expect(bootstrapFileName(npm() as unknown as BootstrapEntry)).toBe("object-store-s3-1.1.0.tgz");
  });
});

describe("JSON Schema (ajv) agrees with zod", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/bootstrap.v1.schema.json", import.meta.url), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const validate = ajv.compile(schema);
  const fixtures: [string, unknown][] = [
    ["workspace", manifest()],
    ["npm", manifest([npm()], { marketplace: MARKETPLACE })],
    ["bad integrity", manifest([workspace({ integrity: "sha512-abc" })])],
    ["unknown source", manifest([workspace({ source: "git" })])],
    ["unknown key", manifest([workspace({ extra: 1 })])],
    ["npm entry with a path", manifest([npm({ path: "plugins/x" })], { marketplace: MARKETPLACE })],
    ["schemaVersion 2", manifest([], { schemaVersion: 2 })],
  ];
  for (const [label, json] of fixtures) {
    it(label, () => {
      const clean = JSON.parse(JSON.stringify(json));
      expect(validate(clean), JSON.stringify(validate.errors)).toBe(
        BootstrapManifestSchema.safeParse(clean).success,
      );
    });
  }
});
