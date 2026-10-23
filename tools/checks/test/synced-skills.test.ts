import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSyncedSkills, inspectSyncedSkills, skillHash } from "../src/synced-skills.js";

const fixtures = fileURLToPath(new URL("../fixtures/synced-skills/", import.meta.url));
const fixture = (name: string) => join(fixtures, name);

// Shared vectors, pinned in capybara-hq/.github as well.
const FIXTURE_SHA256 = "cef1a6784ece247858b9144b07a58ac47ffa8c51520e2b1d817421a3d73090dd";
const STAMPED_FIXTURE_SHA256 = "7571c66c01170d67878bb2d691f6c7980ae762412c65e1a602077baa2f9b5a4b";

const load = (dir: string) =>
  ["SKILL.md", "extra.md"].map((path) => ({
    path,
    content: readFileSync(join(fixtures, dir, path), "utf8"),
  }));

describe("skillHash", () => {
  it("matches the shared vectors", () => {
    expect(skillHash(load("vector"))).toBe(FIXTURE_SHA256);
    expect(skillHash(load("vector-stamped"))).toBe(STAMPED_FIXTURE_SHA256);
  });

  it("is independent of file order and of CRLF checkouts", () => {
    const files = load("vector-stamped");
    const crlf = files.map((f) => ({ ...f, content: f.content.replaceAll("\n", "\r\n") }));
    expect(
      skillHash(
        [...crlf].reverse().map((f) => ({ ...f, content: f.content.replaceAll("\r\n", "\n") })),
      ),
    ).toBe(STAMPED_FIXTURE_SHA256);
  });
});

describe("checkSyncedSkills", () => {
  it("passes an untouched synced skill and counts it", () => {
    expect(checkSyncedSkills(fixture("clean"))).toEqual([]);
    expect(inspectSyncedSkills(fixture("clean")).checked).toEqual(["demo"]);
  });

  it("reports an edited synced skill at the sha256 line", () => {
    const f = checkSyncedSkills(fixture("edited"));
    expect(f.map((x) => [x.rule, x.line])).toEqual([["synced-skill-edited", 8]]);
    expect(f[0]?.message).toContain("capybara-hq/.github");
  });

  it("reports missing version / sha256", () => {
    expect(checkSyncedSkills(fixture("metadata")).map((x) => x.rule)).toEqual([
      "synced-skill-metadata",
    ]);
  });

  it("ignores skills without the synced source", () => {
    const r = inspectSyncedSkills(fixture("ignored"));
    expect(r.findings).toEqual([]);
    expect(r.checked).toEqual([]);
  });
});
