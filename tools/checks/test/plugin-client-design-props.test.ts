import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DESIGN_NAMES } from "../../../packages/plugin-client/src/design.js";
import { DESIGN_SUBSET } from "../src/plugin-client-api.js";

const run = promisify(execFile);
const TSC = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));
const dir = fileURLToPath(new URL("../fixtures/plugin-client-props/", import.meta.url));

async function tsc(project: string): Promise<{ ok: boolean; out: string }> {
  try {
    await run(TSC, ["-p", `${dir}${project}`], { maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: "" };
  } catch (e) {
    const err = e as { stdout?: string };
    return { ok: false, out: err.stdout ?? "" };
  }
}

describe("plugin-client design props", () => {
  it("the hand-written props are accepted by the design components", async () => {
    const r = await tsc("tsconfig.json");
    expect(r.out).toBe("");
    expect(r.ok).toBe(true);
  }, 60_000);

  it("a drifted prop fails (the check is red on drift)", async () => {
    const r = await tsc("tsconfig.drift.json");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("compat-drift.tsx");
  }, 60_000);

  it("DESIGN_SUBSET equals the package's design names", () => {
    expect([...DESIGN_SUBSET]).toEqual([...DESIGN_NAMES]);
  });
});
