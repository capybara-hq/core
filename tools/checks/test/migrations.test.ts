import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkMigrations, checkSql } from "../src/migrations.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/migrations/${name}`, import.meta.url));
const kernel = fileURLToPath(new URL("../../../packages/kernel/src/migrations", import.meta.url));

describe("checkMigrations", () => {
  it("bad-name -> naming", () => {
    const f = checkMigrations([fixture("bad-name")]);
    expect(f.map((x) => x.rule)).toEqual(["naming"]);
    expect(f[0]?.file).toContain("BadName.sql");
  });

  it("drop-column -> destructive（带改法）", () => {
    const f = checkMigrations([fixture("drop-column")]);
    expect(f.map((x) => x.rule)).toEqual(["destructive"]);
    expect(f[0]?.line).toBe(1);
    expect(f[0]?.message).toContain("capybara:allow-destructive");
  });

  it("no-if-not-exists -> idempotent", () => {
    const f = checkMigrations([fixture("no-if-not-exists")]);
    expect(f.map((x) => x.rule)).toEqual(["idempotent"]);
  });

  it("allowed-destructive（带原因的注释）-> 0 条", () => {
    expect(checkMigrations([fixture("allowed-destructive")])).toEqual([]);
  });

  it("空原因的 allow-destructive 仍然报 destructive，并提示原因必填", () => {
    const f = checkMigrations([fixture("empty-reason")]);
    expect(f.map((x) => x.rule)).toEqual(["destructive"]);
    expect(f[0]?.message).toContain("原因");
  });

  it("allow 注释与语句之间有空行 -> 仍报", () => {
    const f = checkSql(
      "0001_x.sql",
      "-- capybara:allow-destructive 原因\n\nDROP TABLE IF EXISTS t;\n",
    );
    expect(f.map((x) => x.rule)).toEqual(["destructive"]);
    expect(f[0]?.line).toBe(3);
  });

  it("transaction-control -> BEGIN / CONCURRENTLY / COMMIT 各一条，行号为语句首 token", () => {
    const f = checkMigrations([fixture("transaction-control")]);
    expect(f.map((x) => [x.rule, x.line])).toEqual([
      ["transaction-control", 1],
      ["transaction-control", 2],
      ["transaction-control", 3],
    ]);
    expect(f[0]?.message).toContain("迁移器已为每个文件包一层事务");
  });

  it("注释、字符串、美元引用中的 ; 与关键字被忽略", () => {
    expect(checkMigrations([fixture("tricky-clean")])).toEqual([]);
  });

  it("DO 块内的 BEGIN 不算事务控制", () => {
    const f = checkSql("0001_x.sql", "DO $$ BEGIN PERFORM 1; END $$;\n");
    expect(f).toEqual([]);
  });

  it("packages/kernel/src/migrations -> 0 条", () => {
    expect(checkMigrations([kernel])).toEqual([]);
  });

  it("不存在的目录被忽略", () => {
    expect(checkMigrations([fixture("nope")])).toEqual([]);
  });
});
