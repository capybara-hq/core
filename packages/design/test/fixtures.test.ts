import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as fixtures from "../src/fixtures/index";
import { ICON_NAMES } from "../src/index";

const sources = ["index.ts", "conversation.ts"].map((f) => ({
  file: f,
  text: readFileSync(resolve(import.meta.dirname, "../src/fixtures", f), "utf8"),
}));

/** Names from the maintainer's real work that the canvas used as sample copy (spec §9). */
const REAL_NAMES = [
  "AURE",
  "Revolut",
  "金蝶",
  "SGD",
  "林岚",
  "周舟",
  "陈默",
  "许诺",
  // The conversation boards (UI refresh B plan, Global Constraints).
  "BLOOMBERG",
  "Lockton",
  "Tokihiko",
  "CHANHUA",
  "DBS",
  "Chong Hing",
  "PWM",
  "Xu YanLi",
  "RP List",
  "f10/calc",
];

describe("@capybara-hq/design/fixtures", () => {
  it("is pure data: no React, and only type imports", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/from\s+["']react["']/);
      for (const m of text.matchAll(/^import\s+(?!type\b)/gm)) {
        throw new Error(`value import in ${file}: ${m.input?.slice(m.index, m.index + 60)}`);
      }
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
    expect(Object.keys(fixtures)).toContain("CONV_FIXTURE");
    for (const [key, value] of Object.entries(fixtures)) {
      const all = JSON.stringify(value) ?? "";
      for (const name of REAL_NAMES) expect(all, `${key}: ${name}`).not.toContain(name);
    }
    for (const { file, text } of sources) {
      for (const name of REAL_NAMES) expect(text, `${file}: ${name}`).not.toContain(name);
    }
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

  it("nav items use known icons, unique ids, and follow the web-order §2.1 order", () => {
    const icons = new Set<string>(ICON_NAMES);
    for (const n of [...fixtures.NAV_FIXTURE, ...fixtures.ADMIN_NAV_FIXTURE])
      expect(icons.has(n.icon), n.icon).toBe(true);
    const ids = fixtures.NAV_FIXTURE.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    // no home item; 技能 and 连接器 sit under 智能体 (acceptance 2026-11-07)
    expect(fixtures.NAV_FIXTURE.filter((n) => n.place === "primary").map((n) => n.id)).toEqual([
      "agents",
      "skills",
      "connectors",
    ]);
    // the inbox is a brand-row icon button (acceptance round 2, B2)
    expect(fixtures.NAV_FIXTURE.filter((n) => n.place === "brand").map((n) => n.id)).toEqual([
      "inbox",
    ]);
    expect(fixtures.NAV_FIXTURE.filter((n) => n.place === "more").map((n) => n.id)).toEqual([
      "plugins",
      "extensions",
      "agent-templates",
      "channels",
      "evals",
      "settings",
    ]);
    expect(fixtures.ADMIN_NAV_FIXTURE.map((n) => n.label)).toEqual([
      "概览",
      "账号",
      "组织",
      "扩展",
      "平台目录",
      "市场",
      "模型",
      "部署设置",
    ]);
    expect(fixtures.EXTENSION_PAGES_FIXTURE).toHaveLength(2);
  });

  describe("conversation (UI refresh B)", () => {
    it("the diff fixture has added and removed lines", () => {
      const diff = fixtures.TOOL_FIXTURES.diff[0]?.diff ?? [];
      expect(diff.some((l) => l.kind === "add")).toBe(true);
      expect(diff.some((l) => l.kind === "del")).toBe(true);
    });

    it("six file outputs for the collapsed block, one 60+ character .xlsx name", () => {
      expect(fixtures.FILE_FIXTURE.many.length).toBe(6);
      const long = [...fixtures.FILE_FIXTURE.outputs, ...fixtures.FILE_FIXTURE.many].filter(
        (f) => [...f.name].length >= 60,
      );
      expect(long.length).toBeGreaterThan(0);
      expect(long.every((f) => f.name.endsWith(".xlsx"))).toBe(true);
    });

    it("two running sub-agents", () => {
      expect(fixtures.SUBAGENT_FIXTURE.running.length).toBe(2);
    });

    it("tool rows are well-formed: failed rows carry an error, running rows elapsed time", () => {
      for (const [state, rows] of Object.entries(fixtures.TOOL_FIXTURES)) {
        expect(rows.length, state).toBeGreaterThan(0);
        for (const r of rows) {
          if (r.status === "failed") expect(r.error, `${state}/${r.id}`).toBeTruthy();
          // a call waiting for a person shows no timer (§6.16.9)
          if (r.status === "running" && r.waiting === undefined)
            expect(r.elapsed, `${state}/${r.id}`).toBeTruthy();
        }
      }
      const ids = Object.values(fixtures.TOOL_FIXTURES).flatMap((rows) => rows.map((r) => r.id));
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("file paths mentioned in prose name file outputs (a chip only for a known file)", () => {
      const names = new Set(
        [...fixtures.FILE_FIXTURE.outputs, ...fixtures.FILE_FIXTURE.many].map((f) => f.name),
      );
      for (const p of fixtures.FILE_FIXTURE.paths) {
        expect(names.has(p.split("/").pop() ?? ""), p).toBe(true);
      }
    });

    it("the selected model and effort are among the listed ones", () => {
      const { selected, models } = fixtures.CONV_FIXTURE;
      const provider = models.find((p) => p.provider === selected.provider);
      const model = provider?.models.find((m) => m.id === selected.model);
      expect(model?.efforts).toContain(selected.effort);
    });
  });
});
