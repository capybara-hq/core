import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPluginClientApi,
  checkPluginClientApiReport,
  DESIGN_SUBSET,
  PLUGIN_CLIENT_API_REPORT_FILE,
  PLUGIN_CLIENT_API_TS,
  PLUGIN_CLIENT_DIR,
  pluginClientExports,
} from "../src/plugin-client-api.js";
import { checkSdkApi } from "../src/sdk-api.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("check:plugin-client-api", () => {
  it("a stale web copy reports plugin-client-api-stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-api-"));
    tmp.push(dir);
    mkdirSync(join(dir, "apps/web/src/lib/client-host"), { recursive: true });
    writeFileSync(join(dir, PLUGIN_CLIENT_API_TS), "export const CLIENT_API_VERSION = 0;\n");
    const findings = checkPluginClientApi(dir);
    expect(findings.map((f) => f.rule)).toEqual(["plugin-client-api-stale"]);
    expect(findings[0]?.file.endsWith("api.generated.ts")).toBe(true);
  });

  it("the repo root is clean", () => {
    expect(checkPluginClientApi(repoRoot)).toEqual([]);
  });

  it("every design name of the subset is a package export", () => {
    const exports = pluginClientExports();
    for (const name of DESIGN_SUBSET) expect(exports).toContain(name);
  });

  const stale = relative(
    PLUGIN_CLIENT_DIR,
    fileURLToPath(new URL("../fixtures/plugin-client-api/stale.api.md", import.meta.url)),
  );

  it("the committed API report is current", async () => {
    expect(await checkPluginClientApiReport({ update: false })).toEqual([]);
  }, 60_000);

  it("a stale API report reports plugin-client-api-stale", async () => {
    const findings = await checkPluginClientApiReport({ update: false, reportFile: stale });
    expect(findings.map((f) => f.rule)).toEqual(["plugin-client-api-stale"]);
    expect(findings[0]?.file.endsWith("stale.api.md")).toBe(true);
  }, 60_000);

  it("sdk-api honours reportFile for reading and writing", async () => {
    // Reading: the same package, a different report file, a different verdict.
    const sdk = await checkSdkApi({ update: false, sdkDir: PLUGIN_CLIENT_DIR, reportFile: stale });
    expect(sdk.map((f) => f.rule)).toEqual(["sdk-api-stale"]);
    // Writing: update writes the named file, with the committed content.
    const dir = mkdtempSync(join(tmpdir(), "pc-report-"));
    tmp.push(dir);
    const out = join(dir, "out.api.md");
    await checkSdkApi({
      update: true,
      sdkDir: PLUGIN_CLIENT_DIR,
      reportFile: relative(PLUGIN_CLIENT_DIR, out),
    });
    expect(readFileSync(out, "utf8")).toBe(
      readFileSync(join(PLUGIN_CLIENT_DIR, PLUGIN_CLIENT_API_REPORT_FILE), "utf8"),
    );
  }, 60_000);
});
