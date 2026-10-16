import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelConfigSchema, meta, renderConfigDocs } from "@capybara-hq/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { checkConfigDocs, DEFAULT_DOC_PATH } from "../src/config-docs.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("renderConfigDocs", () => {
  const md = renderConfigDocs(KernelConfigSchema);
  it("包含点路径与环境变量名", () => {
    expect(md).toContain("`db.poolMax`");
    expect(md).toContain("`CAPYBARA_DB__POOL_MAX`");
    expect(md).toContain("`CAPYBARA_LOG__LEVEL`");
  });
  it("热更与密钥标记", () => {
    const row = (p: string) => md.split("\n").find((l) => l.startsWith(`| \`${p}\``)) ?? "";
    expect(row("log.level")).toMatch(/\| 是 \| 否 \|/);
    expect(row("db.url")).toMatch(/\| 否 \| 是 \|/);
  });
  it("默认值：普通字段打印，密钥字段一律 —", () => {
    const row = (p: string) => md.split("\n").find((l) => l.startsWith(`| \`${p}\``)) ?? "";
    expect(row("db.poolMax")).toContain("`10`");
    expect(row("http.port")).toContain("`8080`");
    expect(row("masterKeyPrevious")).not.toContain("`[]`");
  });
  it("密钥的默认值永远不会被打印", () => {
    const s = z.object({
      token: z
        .string()
        .default("SUPER-SECRET-DEFAULT")
        .meta(meta({ secret: true, description: "t" })),
    });
    expect(renderConfigDocs(s)).not.toContain("SUPER-SECRET-DEFAULT");
  });
  it("输出确定（两次渲染一致、以换行结尾）", () => {
    expect(renderConfigDocs(KernelConfigSchema)).toBe(md);
    expect(md.endsWith("\n")).toBe(true);
  });
});

describe("checkConfigDocs", () => {
  it("仓库里的 docs/config.md 与 KernelConfigSchema 一致", () => {
    expect(checkConfigDocs()).toEqual([]);
  });

  it("给 schema 加字段后 -> config-docs-stale，提示 gen:config-docs", () => {
    const extended = KernelConfigSchema.extend({
      extra: z
        .string()
        .default("x")
        .meta(meta({ description: "Extra" })),
    });
    const f = checkConfigDocs(extended);
    expect(f.map((x) => x.rule)).toEqual(["config-docs-stale"]);
    expect(f[0]?.message).toContain("pnpm gen:config-docs");
  });

  it("文档文件缺失 -> config-docs-stale", () => {
    const d = mkdtempSync(join(tmpdir(), "capybara-cd-"));
    tmp.push(d);
    expect(checkConfigDocs(KernelConfigSchema, join(d, "nope.md")).map((x) => x.rule)).toEqual([
      "config-docs-stale",
    ]);
  });

  it("手工改了文档 -> config-docs-stale", () => {
    const d = mkdtempSync(join(tmpdir(), "capybara-cd-"));
    tmp.push(d);
    const p = join(d, "config.md");
    writeFileSync(p, `${readFileSync(DEFAULT_DOC_PATH, "utf8")}手写的一行\n`);
    expect(checkConfigDocs(KernelConfigSchema, p).map((x) => x.rule)).toEqual([
      "config-docs-stale",
    ]);
  });
});
