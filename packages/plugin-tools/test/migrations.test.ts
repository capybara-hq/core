import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkMigrations, checkSql } from "../src/check/migrations.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/migrations/${name}`, import.meta.url));

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
    expect(f[0]?.message).toContain("reason");
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
    expect(f[0]?.message).toContain("already wraps each file in a transaction");
  });

  it("注释、字符串、美元引用中的 ; 与关键字被忽略", () => {
    expect(checkMigrations([fixture("tricky-clean")])).toEqual([]);
  });

  const rules = (sql: string) => checkSql("0001_x.sql", sql).map((x) => x.rule);

  it("do-block：没有豁免注释的 DO 块报 do-block；块体里的破坏性语句另报 destructive", () => {
    const f = checkMigrations([fixture("do-block")]);
    expect(f.map((x) => x.rule)).toEqual(["do-block", "destructive"]);
    expect(f[0]?.message).toContain("DO block");
  });

  it("DO 块体里的 RENAME 被看到：没有注释 -> do-block + destructive，行号为 DO 行", () => {
    const f = checkMigrations([fixture("do-block-rename")]);
    expect(f.map((x) => [x.rule, x.line])).toEqual([
      ["do-block", 1],
      ["destructive", 1],
    ]);
  });

  it("DO 行正上方带原因的豁免注释 -> 0 条；空原因仍报；注释写在 $$ 里面不算", () => {
    expect(checkMigrations([fixture("do-block-allowed")])).toEqual([]);
    expect(
      rules("-- capybara:allow-destructive\nDO $$ BEGIN ALTER TABLE t RENAME TO u; END $$;"),
    ).toEqual(["destructive"]);
    expect(
      rules("DO $$\n-- capybara:allow-destructive 原因\nBEGIN ALTER TABLE t RENAME TO u; END $$;"),
    ).toEqual(["do-block", "destructive"]);
    expect(rules("DO $$ BEGIN PERFORM 1; END $$;")).toEqual(["do-block"]);
    // 动态 EXECUTE 藏住了 RENAME：带豁免注释的 DO 块不论块体是否被识别为破坏性，原因都必填
    expect(rules("-- capybara:allow-destructive\nDO $$ BEGIN PERFORM 1; END $$;")).toEqual([
      "destructive",
    ]);
    const f = checkMigrations([fixture("do-block-empty-reason")]);
    expect(f.map((x) => [x.rule, x.line])).toEqual([["destructive", 2]]);
    expect(f[0]?.message).toContain("reason");
    expect(rules("DO $tag$ BEGIN ALTER TABLE t DROP COLUMN x; END $tag$;")).toEqual([
      "do-block",
      "destructive",
    ]);
  });

  it("省略 COLUMN 关键字的 DROP -> destructive + idempotent", () => {
    expect(rules("ALTER TABLE t DROP legacy;")).toEqual(["idempotent", "destructive"]);
    expect(rules("ALTER TABLE t DROP IF EXISTS legacy;")).toEqual(["destructive"]);
    expect(checkMigrations([fixture("drop-no-column-keyword")]).map((x) => x.rule)).toEqual([
      "idempotent",
      "destructive",
    ]);
  });

  it("ALTER TABLE 的 DROP NOT NULL / DEFAULT 不算删列", () => {
    expect(rules("ALTER TABLE t ALTER COLUMN a DROP NOT NULL;")).toEqual([]);
    expect(rules("ALTER TABLE t ALTER COLUMN a DROP DEFAULT;")).toEqual([]);
  });

  it("DROP CONSTRAINT 缺 IF EXISTS -> idempotent", () => {
    expect(rules("ALTER TABLE t DROP CONSTRAINT c;")).toEqual(["idempotent"]);
    expect(rules("ALTER TABLE t DROP CONSTRAINT IF EXISTS c;")).toEqual([]);
  });

  it("destructive 覆盖 DROP SCHEMA / TRUNCATE / DELETE FROM，且可用 allow 注释豁免", () => {
    expect(rules("DROP SCHEMA IF EXISTS capybara CASCADE;")).toEqual(["destructive"]);
    expect(rules("TRUNCATE capybara.t;")).toEqual(["destructive"]);
    expect(rules("DELETE FROM capybara.t;")).toEqual(["destructive"]);
    expect(rules("-- capybara:allow-destructive 清理\nDELETE FROM capybara.t;")).toEqual([]);
    expect(rules("-- capybara:allow-destructive 清理\nTRUNCATE capybara.t;")).toEqual([]);
    expect(rules("-- capybara:allow-destructive 清理\nDROP SCHEMA IF EXISTS s;")).toEqual([]);
  });

  it("transaction-control 覆盖 END / ABORT / RELEASE / PREPARE TRANSACTION / *PREPARED", () => {
    for (const sql of [
      "END;",
      "ABORT;",
      "RELEASE SAVEPOINT a;",
      "RELEASE a;",
      "PREPARE TRANSACTION 'x';",
      "COMMIT PREPARED 'x';",
      "ROLLBACK PREPARED 'x';",
    ]) {
      expect(rules(sql), sql).toEqual(["transaction-control"]);
    }
  });

  it("双引号标识符被当作字符串：关键字不误报，; 与 ' 不会切断或错位", () => {
    expect(rules('CREATE TABLE IF NOT EXISTS t ("rename" text);')).toEqual([]);
    const sql =
      'CREATE TABLE IF NOT EXISTS t ("a;b" text, "it\'s" text, "q""x" text);\nDROP TABLE x;';
    const f = checkSql("0001_x.sql", sql);
    expect(f.map((x) => [x.rule, x.line])).toEqual([
      ["idempotent", 2],
      ["destructive", 2],
    ]);
  });

  it("CREATE EXTENSION / SEQUENCE 需 IF NOT EXISTS，DROP EXTENSION|SEQUENCE|INDEX|VIEW 需 IF EXISTS，CREATE TYPE 不要求", () => {
    expect(rules("CREATE EXTENSION pgcrypto;")).toEqual(["idempotent"]);
    expect(rules("CREATE SEQUENCE s;")).toEqual(["idempotent"]);
    expect(rules("CREATE EXTENSION IF NOT EXISTS pgcrypto;")).toEqual([]);
    expect(rules("CREATE SEQUENCE IF NOT EXISTS s;")).toEqual([]);
    for (const k of ["EXTENSION", "SEQUENCE", "INDEX", "VIEW"]) {
      expect(rules(`DROP ${k} x;`), k).toEqual(["idempotent"]);
      expect(rules(`DROP ${k} IF EXISTS x;`), k).toEqual([]);
    }
    expect(rules("CREATE TYPE capybara.mood AS ENUM ('a');")).toEqual([]);
  });

  it("不存在的目录被忽略", () => {
    expect(checkMigrations([fixture("nope")])).toEqual([]);
  });
});
