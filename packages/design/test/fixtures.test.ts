import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as fixtures from "../src/fixtures/index";
import { ICON_NAMES } from "../src/index";

const source = readFileSync(resolve(import.meta.dirname, "../src/fixtures/index.ts"), "utf8");

/** Names from the maintainer's real work that the canvas used as sample copy (spec §9). */
const REAL_NAMES = ["AURE", "Revolut", "金蝶", "SGD", "林岚", "周舟", "陈默", "许诺"];

describe("@capybara-hq/design/fixtures", () => {
  it("is pure data: no React, and only type imports", () => {
    expect(source).not.toMatch(/from\s+["']react["']/);
    for (const m of source.matchAll(/^import\s+(?!type\b)/gm)) {
      throw new Error(`value import in fixtures: ${m.input?.slice(m.index, m.index + 60)}`);
    }
  });

  it("a textarea counter states the value's computed length (what Field count shows)", () => {
    const fields = fixtures.FORM_PAGE_FIXTURE.sections.flatMap((s) => s.fields);
    const counted = fields.filter((f) => f.kind === "textarea" && f.counter !== undefined);
    expect(counted.length).toBeGreaterThan(0);
    for (const f of counted) {
      if (f.kind !== "textarea") continue;
      const max = f.counter?.split(" / ")[1];
      expect(f.counter).toBe(`${f.value.length.toLocaleString("en-US")} / ${max}`);
    }
  });

  it("uses placeholder copy only, never the canvas's real-work names", () => {
    const all = JSON.stringify(fixtures);
    for (const name of REAL_NAMES) expect(all, name).not.toContain(name);
  });

  it("has a long CJK title (40+ characters) and 20 groups for the stress blocks", () => {
    const title = fixtures.LONG_TITLE_GROUP_FIXTURE.conversations[0]?.title ?? "";
    expect([...title].length).toBeGreaterThanOrEqual(40);
    expect(title).not.toContain(" ");
    expect([...fixtures.LONG_TITLE_GROUP_FIXTURE.agentName].length).toBeGreaterThanOrEqual(30);
    expect(fixtures.MANY_GROUPS_FIXTURE.length).toBe(20);
  });

  it("the default groups: 研究助手 (5 + more), 客服分流 (1), 周报助手 (2, one untitled)", () => {
    expect(
      fixtures.GROUPS_FIXTURE.map((g) => [g.agentName, g.conversations.length, g.more]),
    ).toEqual([
      ["研究助手", 5, true],
      ["客服分流", 1, false],
      ["周报助手", 2, false],
    ]);
    expect(fixtures.GROUPS_FIXTURE[2]?.conversations.some((c) => c.title === null)).toBe(true);
  });

  it("nav items use known icons, unique ids, and follow the §4.4 order", () => {
    const icons = new Set<string>(ICON_NAMES);
    for (const n of fixtures.NAV_FIXTURE) expect(icons.has(n.icon), n.icon).toBe(true);
    const ids = fixtures.NAV_FIXTURE.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "overview",
      "agents",
      "skills",
      "inbox",
      "connectors",
      "catalog",
      "channels",
      "evals",
      "settings",
      "admin",
    ]);
    expect(fixtures.EXTENSION_PAGES_FIXTURE).toHaveLength(2);
  });
});
