import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPluginClientApi,
  DESIGN_SUBSET,
  PLUGIN_CLIENT_API_TS,
  pluginClientExports,
} from "../src/plugin-client-api.js";

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
});
