import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkAppliedMigrations,
  diffAppliedMigrations,
  isMigrationFile,
} from "../src/applied-migrations.js";

describe("isMigrationFile", () => {
  it("matches kernel and plugin migrations only", () => {
    expect(isMigrationFile("packages/kernel/src/migrations/0001_init.sql")).toBe(true);
    expect(isMigrationFile("plugins/demo/migrations/0001_todos.sql")).toBe(true);
    expect(isMigrationFile("packages/kernel/src/migrations/README.md")).toBe(false);
    expect(isMigrationFile("packages/kernel/test/fixtures/migrations/0001_x.sql")).toBe(false);
    expect(isMigrationFile("plugins/demo/src/migrations/0001_x.sql")).toBe(false);
  });
});

describe("checkAppliedMigrations (git diff --name-status output)", () => {
  it("reports modified, deleted, renamed-away and type-changed migrations", () => {
    const out = [
      "M\tpackages/kernel/src/migrations/0035_x.sql",
      "D\tplugins/demo/migrations/0001_todos.sql",
      "R100\tpackages/kernel/src/migrations/0002_a.sql\tpackages/kernel/src/migrations/0002_b.sql",
      "T\tplugins/demo/migrations/0002_y.sql",
      "",
    ].join("\n");
    expect(checkAppliedMigrations(out).map((f) => [f.file, f.rule])).toEqual([
      ["packages/kernel/src/migrations/0035_x.sql", "applied-migration-edited"],
      ["plugins/demo/migrations/0001_todos.sql", "applied-migration-edited"],
      ["packages/kernel/src/migrations/0002_a.sql", "applied-migration-edited"],
      ["plugins/demo/migrations/0002_y.sql", "applied-migration-edited"],
    ]);
  });

  it("a plugin deleted as a whole (its plugin.json deleted too) takes its migrations along", () => {
    const out = [
      "D\tplugins/gone/.capybara-plugin/plugin.json",
      "D\tplugins/gone/package.json",
      "D\tplugins/gone/migrations/0001_init.sql",
      "D\tplugins/gone/migrations/0002_more.sql",
      "",
    ].join("\n");
    expect(checkAppliedMigrations(out)).toEqual([]);
  });

  it("a migration deleted or edited while its plugin stays is still reported", () => {
    const out = [
      // another plugin's manifest is deleted: does not excuse demo's migration
      "D\tplugins/gone/.capybara-plugin/plugin.json",
      "D\tplugins/demo/migrations/0001_todos.sql",
      // the plugin's package.json alone is not the plugin
      "D\tplugins/half/package.json",
      "D\tplugins/half/migrations/0001_x.sql",
      // a manifest that was only edited
      "M\tplugins/kept/.capybara-plugin/plugin.json",
      "D\tplugins/kept/migrations/0001_x.sql",
      // a deleted plugin's migration that was edited instead (not deleted) is reported too
      "D\tplugins/odd/.capybara-plugin/plugin.json",
      "M\tplugins/odd/migrations/0001_x.sql",
      // the kernel's migrations never belong to a plugin
      "D\tpackages/kernel/src/migrations/0001_init.sql",
    ].join("\n");
    expect(checkAppliedMigrations(out).map((f) => f.file)).toEqual([
      "plugins/demo/migrations/0001_todos.sql",
      "plugins/half/migrations/0001_x.sql",
      "plugins/kept/migrations/0001_x.sql",
      "plugins/odd/migrations/0001_x.sql",
      "packages/kernel/src/migrations/0001_init.sql",
    ]);
  });

  it("passes added and copied migrations and changes elsewhere", () => {
    const out = [
      "A\tpackages/kernel/src/migrations/0044_new.sql",
      "C090\tpackages/kernel/src/migrations/0001_init.sql\tplugins/x/migrations/0001_init.sql",
      "M\tpackages/kernel/src/kernel.ts",
      "R100\tdocs/a.sql\tplugins/x/migrations/0002_moved_in.sql",
    ].join("\n");
    expect(checkAppliedMigrations(out)).toEqual([]);
  });
});

describe("diffAppliedMigrations (a real git repository)", () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  const commit = (msg: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "applied-migrations-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("config", "commit.gpgsign", "false");
    write(
      "packages/kernel/src/migrations/0001_init.sql",
      "CREATE TABLE IF NOT EXISTS a (id int);\n",
    );
    write("packages/kernel/src/migrations/0002_b.sql", "CREATE TABLE IF NOT EXISTS b (id int);\n");
    write("plugins/demo/migrations/0001_todos.sql", "CREATE TABLE IF NOT EXISTS t (id int);\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fails when a branch edits, deletes or renames an applied migration", () => {
    const base = commit("base");
    write(
      "packages/kernel/src/migrations/0001_init.sql",
      "CREATE TABLE IF NOT EXISTS a2 (id int);\n",
    );
    rmSync(join(dir, "plugins/demo/migrations/0001_todos.sql"));
    renameSync(
      join(dir, "packages/kernel/src/migrations/0002_b.sql"),
      join(dir, "packages/kernel/src/migrations/0002_renamed.sql"),
    );
    commit("edit applied migrations");
    expect(
      diffAppliedMigrations(dir, base)
        .map((f) => f.file)
        .sort(),
    ).toEqual([
      "packages/kernel/src/migrations/0001_init.sql",
      "packages/kernel/src/migrations/0002_b.sql",
      "plugins/demo/migrations/0001_todos.sql",
    ]);
  });

  it("passes when a branch deletes a whole plugin (it moved to another repository)", () => {
    write("plugins/demo/.capybara-plugin/plugin.json", "{}\n");
    write("plugins/demo/package.json", "{}\n");
    const base = commit("base");
    rmSync(join(dir, "plugins/demo"), { recursive: true });
    commit("move the plugin out");
    expect(diffAppliedMigrations(dir, base)).toEqual([]);
  });

  it("passes when a branch only adds migrations", () => {
    const base = commit("base");
    write("packages/kernel/src/migrations/0003_c.sql", "CREATE TABLE IF NOT EXISTS c (id int);\n");
    write("plugins/demo/migrations/0002_more.sql", "CREATE TABLE IF NOT EXISTS u (id int);\n");
    write("packages/kernel/src/kernel.ts", "export {};\n");
    commit("add migrations");
    expect(diffAppliedMigrations(dir, base)).toEqual([]);
  });

  it("compares against the merge base, so later commits on the base branch don't count", () => {
    const base = commit("base");
    git("checkout", "-q", "-b", "feature");
    write("packages/kernel/src/migrations/0003_c.sql", "CREATE TABLE IF NOT EXISTS c (id int);\n");
    commit("feature adds a migration");
    git("checkout", "-q", "main");
    write("packages/kernel/src/migrations/0001_init.sql", "-- fixed on main\n");
    const mainHead = commit("main edits (not the branch's doing)");
    git("checkout", "-q", "feature");
    expect(base).not.toBe(mainHead);
    expect(diffAppliedMigrations(dir, mainHead)).toEqual([]);
  });
});
