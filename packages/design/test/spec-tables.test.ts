import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkSpecTables,
  missingStates,
  parseSizeTables,
  parseStateLists,
  partSelector,
  resolveToken,
  SpecFormatError,
} from "../src/reference/index";

const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "fixtures", `spec-${name}.md`), "utf8");
const repo = (path: string) => readFileSync(resolve(import.meta.dirname, "../../..", path), "utf8");
const tokens = JSON.parse(repo("docs/design/tokens.json")) as unknown;

describe("parseSizeTables / parseStateLists", () => {
  it("parses one table with three rows and one state list", () => {
    const md = fixture("valid");
    const tables = parseSizeTables(md);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.component).toBe("sidebar");
    expect(tables[0]?.rows).toEqual([
      { part: "sidebar", state: "default", property: "width", value: "layout.sidebar", line: 11 },
      {
        part: "nav-item[aria-current=page]",
        state: "default",
        property: "background-color",
        value: "color.sidebar-active",
        line: 12,
      },
      { part: "empty-hint", state: "empty", property: "font-size", value: "type.small", line: 13 },
    ]);
    expect(parseStateLists(md)).toEqual([
      { component: "sidebar", states: ["default", "empty", "rail"], line: 5 },
    ]);
  });

  it("throws SpecFormatError on a table with the wrong header", () => {
    expect(() => parseSizeTables(fixture("malformed"))).toThrow(SpecFormatError);
  });
});

describe("missingStates", () => {
  it("reports a listed state that has no rendered block (the coverage check's violation)", () => {
    const lists = parseStateLists(fixture("valid"));
    const rendered = ["sidebar-default", "sidebar-rail"];
    expect(missingStates(lists, rendered, ["sidebar"])).toEqual(["sidebar-empty"]);
  });

  it("is empty when every state is rendered, and ignores components not asked for", () => {
    const lists = parseStateLists(fixture("valid"));
    expect(
      missingStates(lists, ["sidebar-default", "sidebar-empty", "sidebar-rail"], ["sidebar"]),
    ).toEqual([]);
    expect(missingStates(lists, [], [])).toEqual([]);
  });

  it("reports an asked-for component that has no state list", () => {
    expect(missingStates([], [], ["switch"])).toEqual(["switch: no state list"]);
  });
});

describe("resolveToken", () => {
  it("resolves sizes, type sizes and line heights, padding and colors per theme", () => {
    expect(resolveToken(tokens, "row.default", "dark")).toBe(32);
    expect(resolveToken(tokens, "type.body", "dark")).toBe(13);
    expect(resolveToken(tokens, "type.body.line", "dark")).toBe(20);
    expect(resolveToken(tokens, "type.prose-small.line", "light")).toBe(20);
    expect(resolveToken(tokens, "pad.default.x", "dark")).toBe(12);
    expect(resolveToken(tokens, "pad.dense.y", "dark")).toBe(4);
    expect(resolveToken(tokens, "layout.sidebar", "dark")).toBe(256);
    expect(resolveToken(tokens, "color.ink", "light")).toBe("#1A1A18");
    expect(resolveToken(tokens, "color.muted", "dark")).toBe("#8E8E89");
    expect(resolveToken(tokens, "1.5", "dark")).toBe(1.5);
    expect(resolveToken(tokens, "0", "dark")).toBe(0);
  });

  it("throws on a path tokens.json lacks", () => {
    expect(() => resolveToken(tokens, "row.huge", "dark")).toThrow(/row\.huge/);
    expect(() => resolveToken(tokens, "color.nope", "dark")).toThrow(/color\.nope/);
    expect(() => resolveToken(tokens, "type.body.weight", "dark")).toThrow();
  });
});

describe("partSelector", () => {
  it("turns a part into a CSS selector", () => {
    expect(partSelector("root")).toBe(":scope");
    expect(partSelector("cell")).toBe('[data-part="cell"]');
    expect(partSelector("button[data-variant=primary]")).toBe(
      '[data-part="button"][data-variant="primary"]',
    );
    expect(partSelector("row[aria-current=true] cell")).toBe(
      '[data-part="row"][aria-current="true"] [data-part="cell"]',
    );
  });

  it("rejects anything else", () => {
    expect(() => partSelector("div > span")).toThrow(SpecFormatError);
    expect(() => partSelector('a[x="1"]')).toThrow(SpecFormatError);
  });
});

describe("checkSpecTables", () => {
  it("passes a valid spec", () => {
    expect(checkSpecTables(fixture("valid"), tokens)).toEqual([]);
  });

  it("reports a value tokens.json lacks, with the row's line", () => {
    expect(checkSpecTables(fixture("bad-value"), tokens)).toEqual([
      { line: 8, message: expect.stringContaining("row.huge") },
      { line: 9, message: expect.stringContaining("color.nope") },
    ]);
  });

  it("reports a row state that is not in the state list", () => {
    expect(checkSpecTables(fixture("missing-state"), tokens)).toEqual([
      { line: 8, message: expect.stringContaining("sidebar-rail") },
    ]);
  });

  it("reports a size table without a state list", () => {
    expect(checkSpecTables(fixture("no-states"), tokens)).toEqual([
      { line: 1, message: expect.stringContaining("no state list") },
    ]);
  });

  it("reports a duplicate size-table marker", () => {
    expect(checkSpecTables(fixture("dup-table"), tokens)).toEqual([
      { line: 9, message: expect.stringContaining("duplicate") },
    ]);
  });

  it("reports a malformed table instead of throwing", () => {
    expect(checkSpecTables(fixture("malformed"), tokens)).toEqual([
      { line: 2, message: expect.stringContaining("header") },
    ]);
  });

  it("passes the repository's design spec against tokens.json", () => {
    expect(checkSpecTables(repo("docs/design/spec.md"), tokens)).toEqual([]);
    const components = parseStateLists(repo("docs/design/spec.md")).map((l) => l.component);
    expect(components).toEqual(
      expect.arrayContaining([
        "sidebar",
        "page-header",
        "stat-cards",
        "status-bar",
        "action-row",
        "button",
        "input",
        "segmented",
        "switch",
        "filter-chip",
        "table",
        "icon",
        "template-list",
        "template-form",
      ]),
    );
  });
});
