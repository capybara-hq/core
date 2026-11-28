// Header tabs are one level (spec §4.2 path rule, maintainer decision 2026-11-28): a head whose
// tabs are routes stands at its first tab's level on every tab, so a tab's own route draws no path
// row where its sibling tabs draw none; a page without tabs keeps its path.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, headPath, ListPage, PageLevelContext } from "../src/index";

afterEach(cleanup);

const TABS = [
  { id: "items", label: "连接器", href: "/admin/connectors" },
  { id: "templates", label: "模板", href: "/admin/connectors/templates" },
];
const PATH = [
  { label: "管理后台", href: "/admin" },
  { label: "连接器", href: "/admin/connectors" },
  { label: "模板" },
];

describe("headPath", () => {
  it("drops the segments a tab's route adds to its first tab's", () => {
    expect(headPath(PATH, TABS, "templates")).toEqual(PATH.slice(0, 2));
    expect(headPath(PATH.slice(0, 2), TABS, "items")).toEqual(PATH.slice(0, 2));
  });
  it("leaves in-page tabs, tabs of one level and heads without tabs alone", () => {
    const inPage = TABS.map(({ id, label }) => ({ id, label }));
    expect(headPath(PATH, inPage, "templates")).toEqual(PATH);
    const level = [
      { id: "sets", label: "评测集", href: "/evals" },
      { id: "runs", label: "运行记录", href: "/trajectories?x=1" },
    ];
    expect(headPath(PATH.slice(0, 2), level, "runs")).toEqual(PATH.slice(0, 2));
    expect(headPath(PATH, undefined, undefined)).toEqual(PATH);
  });
});

describe("a tab route's head", () => {
  const head = (activeTab: string, path = PATH) =>
    render(
      <DesignProvider locale="zh">
        <ListPage header={{ path, title: "连接器模板", tabs: TABS, activeTab }}>
          <p>rows</p>
        </ListPage>
      </DesignProvider>,
    );
  it("draws no path row, as its first tab does", () => {
    head("templates");
    expect(screen.queryByRole("navigation", { name: "路径" })).toBeNull();
  });
  it("a deeper page (no tabs) keeps its path row", () => {
    render(
      <DesignProvider locale="zh">
        <ListPage header={{ path: PATH, title: "连接器模板" }}>
          <p>rows</p>
        </ListPage>
      </DesignProvider>,
    );
    expect(screen.getByRole("navigation", { name: "路径" })).toBeTruthy();
  });
});

describe("the app's navigation level decides the path row (maintainer decision 2026-11-29)", () => {
  const head = (level: "first" | "deeper" | undefined, path = PATH) =>
    render(
      <DesignProvider locale="zh">
        <PageLevelContext.Provider value={level}>
          <ListPage header={{ path, title: "页" }}>
            <p>rows</p>
          </ListPage>
        </PageLevelContext.Provider>
      </DesignProvider>,
    );
  it("a first-level page draws none, whatever its segment count (a settings sub-page)", () => {
    head("first");
    expect(screen.queryByRole("navigation", { name: "路径" })).toBeNull();
  });
  it("a deeper page draws it from two segments (a plugin item: scope / page)", () => {
    head("deeper", PATH.slice(0, 2));
    expect(screen.getByRole("navigation", { name: "路径" })).toBeTruthy();
  });
  it("unset (a catalog page), the segment count decides", () => {
    head(undefined, PATH.slice(0, 2));
    expect(screen.queryByRole("navigation", { name: "路径" })).toBeNull();
  });
});
