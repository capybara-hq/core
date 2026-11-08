import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPlatformOps } from "../src/platform-ops.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/platform-ops/${name}`, import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const SRC = "packages/kernel/src";

/** 1-based line of the first line containing `needle`. */
function lineOf(file: string, needle: string): number {
  const i = readFileSync(file, "utf8")
    .split("\n")
    .findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`"${needle}" not in ${file}`);
  return i + 1;
}

describe("checkPlatformOps", () => {
  it("passes a tree where every route is mirrored or excluded (argument-less @Get() included)", () => {
    expect(checkPlatformOps(fixture("clean"))).toEqual([]);
  });

  it("reports each rule once per offender, with file and line", () => {
    const root = fixture("violations");
    const ctl = join(root, SRC, "skills/skills.controller.ts");
    const ops = join(root, SRC, "platform/ops/skills.ops.ts");
    const exc = join(root, SRC, "platform/exclusions.ts");
    const got = checkPlatformOps(root).map((f) => [f.rule, f.file, f.line, f.message]);
    const rules = got.map((g) => g[0]);
    expect(rules.sort()).toEqual(
      [
        "platform-op-authz",
        "platform-op-authz",
        "platform-op-describe",
        "platform-op-describe",
        "platform-op-double",
        "platform-op-errors",
        "platform-op-errors",
        "platform-op-exclusion-reason",
        "platform-op-exclusion-reason",
        "platform-op-later",
        "platform-op-later",
        "platform-op-literal",
        "platform-op-literal",
        "platform-op-literal",
        "platform-op-literal",
        "platform-op-literal",
        "platform-op-literal",
        "platform-op-missing",
        "platform-op-missing",
        "platform-op-orphan",
        "platform-op-orphan",
        "platform-op-session-only",
        "platform-op-session-only",
      ].sort(),
    );
    const has = (rule: string, file: string, line: number, text: string) =>
      expect(
        got.some(
          (g) => g[0] === rule && g[1] === file && g[2] === line && String(g[3]).includes(text),
        ),
        `${rule} ${file}:${line} ${text}\n${JSON.stringify(got, null, 1)}`,
      ).toBe(true);
    // the argument-less @Get() is a route too: it is mirrored, so only `get` and `patch` are missing
    has(
      "platform-op-missing",
      ctl,
      lineOf(ctl, '@Get(":id")'),
      "GET /api/v1/orgs/:orgId/skills/:id",
    );
    has("platform-op-missing", ctl, lineOf(ctl, "@Patch("), "PATCH /api/v1/orgs/:orgId/skills/:id");
    has("platform-op-authz", ops, lineOf(ops, 'id: "skills.create"'), "skills.manage");
    has("platform-op-authz", ops, lineOf(ops, 'id: "skills.update"'), "service-enforced");
    has("platform-op-orphan", ops, lineOf(ops, 'id: "skills.remove"'), "nothing");
    has("platform-op-orphan", exc, lineOf(exc, "ghost"), "ghost");
    has("platform-op-describe", ops, lineOf(ops, 'id: "skills.remove"'), "example");
    has("platform-op-describe", ops, lineOf(ops, 'id: "skills.remove"'), "summary");
    has("platform-op-literal", ops, lineOf(ops, 'id: "skills.patch"'), "mirrors");
    has("platform-op-literal", ops, lineOf(ops, 'id: "skills.other"'), "authz");
    has(
      "platform-op-literal",
      ops,
      lineOf(ops, "defineOperation(someOperation)"),
      "object literal",
    );
    has("platform-op-errors", ops, lineOf(ops, 'id: "skills.errors"'), "skill.no_next");
    has("platform-op-errors", ops, lineOf(ops, 'id: "skills.errors"'), "orgAdmin or member");
    has("platform-op-literal", exc, lineOf(exc, "route: ROUTE"), "route");
    const dyn = join(root, SRC, "skills/dynamic.controller.ts");
    has("platform-op-literal", dyn, lineOf(dyn, "@Get(PATH)"), "route path");
    has("platform-op-literal", dyn, lineOf(dyn, '@Get("y")'), "controller prefix");
    has(
      "platform-op-double",
      exc,
      lineOf(exc, 'skills", category: "internal", reason: "Both."'),
      "mirrored by skills.list",
    );
    has("platform-op-exclusion-reason", exc, lineOf(exc, 'skills/a"'), "reason");
    has("platform-op-exclusion-reason", exc, lineOf(exc, 'skills/b"'), "issue");
    has("platform-op-later", exc, lineOf(exc, 'skills/b"'), "exclude it for good");
    has("platform-op-later", exc, lineOf(exc, "even with an issue URL") + 1, "skills/c");
    // a @SessionOnly route is human-only or secret: never mirrored, never another category
    has(
      "platform-op-session-only",
      ops,
      lineOf(ops, 'id: "sessions.mirrored"'),
      "POST /api/v1/orgs/:orgId/sessions/mirrored",
    );
    has("platform-op-session-only", exc, lineOf(exc, "sessions/internal"), "human-only or secret");
  });

  it("holds on the real kernel tree", () => {
    expect(checkPlatformOps(repoRoot)).toEqual([]);
  });
});
