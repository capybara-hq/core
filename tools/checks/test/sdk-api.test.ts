import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkSdkApi, DEFAULT_SDK_DIR, SDK_API_REPORT_FILE } from "../src/sdk-api.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Copies the SDK into `<tmp>/packages/plugin-sdk` (with the root tsconfig.base.json it extends) and
 * links the real node_modules, so the check runs against a copy and never touches the real SDK.
 */
function fixtureSdk(): string {
  const base = mkdtempSync(join(tmpdir(), "capybara-sdk-api-"));
  tmp.push(base);
  const dir = join(base, "packages/plugin-sdk");
  for (const p of ["src", "api", "tsconfig.json", "package.json", "api-extractor.json"]) {
    cpSync(join(DEFAULT_SDK_DIR, p), join(dir, p), { recursive: true });
  }
  cpSync(join(REPO, "tsconfig.base.json"), join(base, "tsconfig.base.json"));
  symlinkSync(join(DEFAULT_SDK_DIR, "node_modules"), join(dir, "node_modules"), "dir");
  symlinkSync(join(REPO, "node_modules"), join(base, "node_modules"), "dir");
  return dir;
}

describe("checkSdkApi", () => {
  it("the committed API report matches the SDK source", async () => {
    expect(await checkSdkApi({ update: false })).toEqual([]);
  }, 120_000);

  it("violating fixture: a new export -> sdk-api-stale", async () => {
    const dir = fixtureSdk();
    appendFileSync(join(dir, "src/index.ts"), "\nexport const FIXTURE_ADDED_EXPORT = 1;\n");
    const f = await checkSdkApi({ update: false, sdkDir: dir });
    expect(f).toHaveLength(1);
    expect(f[0]?.rule).toBe("sdk-api-stale");
    expect(f[0]?.file).toBe(join(dir, SDK_API_REPORT_FILE));
    expect(f[0]?.message).toContain("pnpm gen:sdk-api");
  }, 120_000);

  it("violating fixture: a changed exported signature -> sdk-api-stale", async () => {
    const dir = fixtureSdk();
    const file = join(dir, "src/index.ts");
    const src = readFileSync(file, "utf8");
    expect(src).toContain('export const SDK_VERSION = "0.1.0";');
    writeFileSync(
      file,
      src.replace(
        'export const SDK_VERSION = "0.1.0";',
        'export const SDK_VERSION: string = "0.1.0";',
      ),
    );
    expect(await checkSdkApi({ update: false, sdkDir: dir })).toHaveLength(1);
  }, 120_000);

  it("a comment-only edit does not change the report", async () => {
    const dir = fixtureSdk();
    const file = join(dir, "src/index.ts");
    writeFileSync(
      file,
      `/** A doc comment that is not part of the API surface. */\n${readFileSync(file, "utf8")}`,
    );
    expect(await checkSdkApi({ update: false, sdkDir: dir })).toEqual([]);
  }, 120_000);

  it("update: true rewrites the report, after which the check passes", async () => {
    const dir = fixtureSdk();
    appendFileSync(join(dir, "src/index.ts"), "\nexport const FIXTURE_ADDED_EXPORT = 1;\n");
    expect(await checkSdkApi({ update: true, sdkDir: dir })).toEqual([]);
    expect(readFileSync(join(dir, SDK_API_REPORT_FILE), "utf8")).toContain("FIXTURE_ADDED_EXPORT");
    expect(await checkSdkApi({ update: false, sdkDir: dir })).toEqual([]);
  }, 120_000);
});
