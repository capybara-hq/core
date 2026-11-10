// @vitest-environment node
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const TSC = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));
const dir = fileURLToPath(new URL("./types/", import.meta.url));

async function tsc(project: string): Promise<{ ok: boolean; out: string }> {
  try {
    await run(TSC, ["-p", `${dir}${project}`], { maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: (e as { stdout?: string }).stdout ?? "" };
  }
}

describe("types under strict", () => {
  it("a components map of components bound to different slots type-checks", async () => {
    const r = await tsc("tsconfig.json");
    expect(r.out).toBe("");
    expect(r.ok).toBe(true);
  }, 60_000);

  it("a component whose render takes another slot's props is refused (red twin)", async () => {
    const r = await tsc("tsconfig.mismatch.json");
    expect(r.ok).toBe(false);
    const errors = r.out.split("\n").filter((l) => l.includes("error TS"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/(^|\/)components-mismatch\.tsx\(\d+,\d+\): error TS2322: /);
  }, 60_000);
});
