import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Column,
  DataTable,
  DesignProvider,
  DetailPage,
  type InboxLoading,
  InboxPage,
  OverviewPage,
} from "../src/index";

afterEach(cleanup);
const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

const header = { path: [{ label: "capybara" }, { label: "agents" }], title: "研究助手" };
const tabs = {
  items: [
    { id: "summary", label: "概要" },
    { id: "runs", label: "运行" },
  ],
  value: "summary",
  label: "页面",
};
const metrics = [
  { label: "运行", value: 12 },
  { label: "失败", value: 1 },
];

const parts = (name: string) => document.querySelectorAll(`[data-part="${name}"]`);
const count = (selector: string) => document.querySelectorAll(selector).length;

describe("DetailPage loading", () => {
  it("DetailPage loading draws the frame and no children", () => {
    zh(
      <DetailPage header={header} tabs={tabs} loading={{ inspector: true }}>
        <p>REAL CONTENT</p>
      </DetailPage>,
    );
    expect(screen.queryByText("REAL CONTENT")).toBeNull();
    expect(document.querySelector('[data-template="DetailPage"]')).not.toBeNull();
    expect(parts("page-header")).toHaveLength(1);
    expect(parts("content")).toHaveLength(1);
    expect(count(".cb-body-inspector")).toBe(1);
    // The default is two card-shaped blocks, and the group announces once.
    expect(count('[data-part="loading-card"]')).toBe(2);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("takes the block count as given, and no inspector unless flagged", () => {
    zh(<DetailPage header={header} tabs={tabs} loading={{ blocks: 3 }} />);
    expect(count('[data-part="loading-card"]')).toBe(3);
    expect(count(".cb-body-inspector")).toBe(0);
  });

  it("tabs stay real while loading", () => {
    zh(<DetailPage header={header} tabs={tabs} loading={{ inspector: true }} />);
    expect(screen.getByRole("tab", { name: "概要" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "运行" })).toBeTruthy();
  });

  it("the inspector placeholder is KeyValue's own box", () => {
    zh(<DetailPage header={header} tabs={tabs} loading={{ inspector: true }} />);
    const dl = document.querySelector('[data-part="loading-inspector"]');
    expect(dl?.tagName).toBe("DL");
    expect(dl?.className).toBe("cb-kv");
    expect(dl?.querySelectorAll(".cb-kv-row")).toHaveLength(4);
    expect(dl?.querySelector(".cb-kv-key")).not.toBeNull();
    expect(dl?.querySelector(".cb-kv-value")).not.toBeNull();
  });

  it("a real inspector stays while loading unless it is flagged", () => {
    zh(<DetailPage header={header} tabs={tabs} inspector={<p>REAL INSPECTOR</p>} loading={{}} />);
    expect(screen.getByText("REAL INSPECTOR")).toBeTruthy();
  });
});

describe("OverviewPage loading", () => {
  it("OverviewPage loading draws the frame and no children", () => {
    zh(
      <OverviewPage header={header} loading={{}}>
        <p>REAL CONTENT</p>
      </OverviewPage>,
    );
    expect(screen.queryByText("REAL CONTENT")).toBeNull();
    expect(document.querySelector('[data-template="OverviewPage"]')).not.toBeNull();
    expect(parts("page-header")).toHaveLength(1);
    // Defaults: four stat cards and two sections.
    expect(parts("stat-card")).toHaveLength(4);
    expect(count('[data-part="loading-card"]')).toBe(2);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("takes the stat and section counts as given", () => {
    zh(<OverviewPage header={header} loading={{ stats: 3, sections: 1 }} />);
    expect(parts("stat-card")).toHaveLength(3);
    expect(count('[data-part="loading-card"]')).toBe(1);
  });

  it("known metrics render for real", () => {
    zh(<OverviewPage header={{ ...header, metrics }} loading={{ stats: 4 }} />);
    expect(parts("stat-card")).toHaveLength(2);
    expect(screen.getByText("失败")).toBeTruthy();
  });
});

describe("DataTable loading announcement", () => {
  it("announces by itself when it stands alone", () => {
    zh(
      <DataTable<{ id: string }>
        label="t"
        state="loading"
        columns={[{ key: "a", header: "A", cell: () => null }]}
        rows={[]}
        rowKey={(r) => r.id}
      />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("正在加载")).toBeTruthy();
  });
});

describe("InboxPage loading", () => {
  it("InboxPage loading draws the frame and no children", () => {
    zh(
      <InboxPage header={header} list={<p>REAL LIST</p>} filters={<p>REAL FILTERS</p>} loading={{}}>
        <p>REAL CONTENT</p>
      </InboxPage>,
    );
    expect(screen.queryByText("REAL LIST")).toBeNull();
    expect(screen.queryByText("REAL CONTENT")).toBeNull();
    expect(document.querySelector('[data-template="InboxPage"]')).not.toBeNull();
    // The rail's filters are static: they stay; the list is four 64 px rows by default.
    expect(screen.getByText("REAL FILTERS")).toBeTruthy();
    expect(count(".cb-body-rail")).toBe(1);
    expect(count('[data-part="loading-row"]')).toBe(4);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("takes the row count as given", () => {
    zh(<InboxPage header={header} loading={{ rows: 6 }} />);
    expect(count('[data-part="loading-row"]')).toBe(6);
  });

  it("loading rows sit in the object list's own container", () => {
    zh(<InboxPage header={header} filters={<p>F</p>} loading={{ rows: 2 }} />);
    const list = document.querySelector('[data-part="loading-list"]');
    expect(list?.className).toBe("cb-object-list");
    const rows = list?.querySelectorAll('[data-part="loading-row"]') ?? [];
    expect(rows).toHaveLength(2);
    // The first row is the list's first child, so it takes no top border.
    expect(rows[0]).toBe(list?.firstElementChild);
  });

  it("a records list draws the DataTable loading state in the caller's table shape", () => {
    zh(
      <InboxPage
        header={header}
        filters={<p>F</p>}
        loading={{
          list: "records",
          table: {
            label: "待处理",
            columns: [{ key: "t", header: "事项", cell: () => null }],
            rowHeight: "dense",
            framed: false,
          },
        }}
      />,
    );
    expect(count('[data-part="loading-row"]')).toBe(0);
    expect(document.querySelector('[data-empty="loading"]')).not.toBeNull();
    expect(screen.getByText("事项")).toBeTruthy();
    expect(screen.getByText("F")).toBeTruthy();
    expect(document.querySelector(".cb-table-panel")).not.toBeNull();
    // The page's group announces once; the table adds none (spec §6.29).
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getAllByText("正在加载")).toHaveLength(1);
  });

  it("takes a page's own typed columns without a cast", () => {
    type Row = { id: string; title: string };
    const columns: Column<Row>[] = [{ key: "title", header: "事项", cell: (r) => r.title }];
    const loading: InboxLoading = {
      list: "records",
      table: { label: "待处理", columns, rowHeight: "dense", framed: false },
    };
    zh(<InboxPage header={header} loading={loading} />);
    expect(screen.getByText("事项")).toBeTruthy();
  });

  it("without loading, the filters sit above the list", () => {
    zh(
      <InboxPage header={header} filters={<p>F</p>} list={<p>第一项</p>}>
        x
      </InboxPage>,
    );
    expect(screen.getByText("F")).toBeTruthy();
    expect(screen.getByText("第一项")).toBeTruthy();
    expect(count('[data-part="loading-row"]')).toBe(0);
  });
});
