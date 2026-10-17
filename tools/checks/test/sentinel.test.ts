import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanTargetProblem } from "../src/sentinel.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(withSdk: boolean): string {
  const d = mkdtempSync(join(tmpdir(), "capybara-sentinel-"));
  tmp.push(d);
  if (withSdk) mkdirSync(join(d, "packages/plugin-sdk"), { recursive: true });
  return d;
}

describe("扫描目标哨兵", () => {
  it("插件目录为空 → 报问题", () => {
    expect(scanTargetProblem([], repo(true))).toMatch(/扫描目标为空，检查等于没跑.*plugins/);
  });
  it("plugin-sdk 缺失 → 报问题", () => {
    expect(scanTargetProblem(["/x/plugins/a"], repo(false))).toMatch(/plugin-sdk/);
  });
  it("两者都在 → 无问题", () => {
    expect(scanTargetProblem(["/x/plugins/a"], repo(true))).toBeUndefined();
  });
});
