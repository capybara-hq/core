import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../src/index.js";

describe("plugin-sdk", () => {
  it("导出语义化版本号", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  });

  it("SDK_VERSION 与 package.json 的 version 一致（发版时防漂移）", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
