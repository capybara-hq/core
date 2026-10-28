import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncSdkVersion } from "../src/sdk-version.js";

let root: string;
const SRC = "packages/plugin-sdk/src/index.ts";
const write = (version: string, literal: string) => {
  mkdirSync(join(root, "packages/plugin-sdk/src"), { recursive: true });
  writeFileSync(
    join(root, "packages/plugin-sdk/package.json"),
    JSON.stringify({ name: "@capybara-hq/plugin-sdk", version }),
  );
  writeFileSync(join(root, SRC), `export const SDK_VERSION = "${literal}";\nexport const X = 1;\n`);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sdk-version-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("syncSdkVersion", () => {
  it("rewrites SDK_VERSION to the package.json version after changeset version", () => {
    write("0.1.0-rc.1", "0.1.0-rc.0");
    expect(syncSdkVersion(root)).toEqual({ changed: true, version: "0.1.0-rc.1" });
    expect(readFileSync(join(root, SRC), "utf8")).toBe(
      'export const SDK_VERSION = "0.1.0-rc.1";\nexport const X = 1;\n',
    );
  });

  it("leaves an up-to-date file alone", () => {
    write("0.1.0", "0.1.0");
    expect(syncSdkVersion(root)).toEqual({ changed: false, version: "0.1.0" });
  });

  it("fails when the declaration is missing", () => {
    write("0.1.0", "0.1.0");
    writeFileSync(join(root, SRC), "export const X = 1;\n");
    expect(() => syncSdkVersion(root)).toThrow(/SDK_VERSION/);
  });
});
