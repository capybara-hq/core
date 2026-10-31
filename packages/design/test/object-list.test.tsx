import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Callout,
  DesignProvider,
  EmptyState,
  ListPage,
  ObjectList,
  ObjectRow,
  SettingsPage,
} from "../src/index";

afterEach(cleanup);
const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);
const header = { path: [{ label: "capybara" }], title: "Agents" };

describe("ObjectRow", () => {
  it("shows name, chips, description, meta, state and one action", () => {
    zh(
      <ObjectList label="Agent 列表">
        <ObjectRow
          mark={{ text: "研" }}
          name="研究助手"
          href="/agents/a"
          chips={[{ label: "组织共享" }]}
          description="查资料、读文件"
          meta="deepseek-chat · 4 技能"
          state={{ label: "已启用", tone: "ok" }}
          trailing="刚刚"
          action={{ label: "对话", href: "/chat" }}
          menu={[{ label: "删除", danger: true, onSelect: () => {} }]}
        />
      </ObjectList>,
    );
    const row = within(screen.getByRole("list", { name: "Agent 列表" })).getByRole("listitem");
    expect(within(row).getByRole("link", { name: "研究助手" }).getAttribute("href")).toBe(
      "/agents/a",
    );
    expect(within(row).getByText("组织共享")).toBeTruthy();
    expect(within(row).getByText("查资料、读文件")).toBeTruthy();
    expect(within(row).getByText("deepseek-chat · 4 技能")).toBeTruthy();
    expect(within(row).getByText("已启用").getAttribute("data-tone")).toBe("ok");
    expect(within(row).getByText("刚刚")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "对话" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "更多操作" })).toBeTruthy();
  });

  it("warn mark and chip use the warn tone", () => {
    zh(
      <ObjectList label="l">
        <ObjectRow
          mark={{ icon: "extension", tone: "warn" }}
          name="x"
          chips={[{ label: "回退模型不可用", tone: "warn" }]}
        />
      </ObjectList>,
    );
    expect(document.querySelector(".cb-object-mark")?.getAttribute("data-tone")).toBe("warn");
    expect(screen.getByText("回退模型不可用").getAttribute("data-tone")).toBe("warn");
  });
});

describe("EmptyState and Callout", () => {
  it("EmptyState shows icon, sentence and the primary action", () => {
    zh(
      <EmptyState
        icon="empty"
        text="还没有 agent"
        action={{ label: "新建", variant: "primary", href: "/new" }}
      />,
    );
    expect(screen.getByText("还没有 agent")).toBeTruthy();
    expect(screen.getByRole("link", { name: "新建" })).toBeTruthy();
  });

  it("EmptyState: the pixel capybara by default, the sentence in ink, a muted hint, page size", () => {
    zh(<EmptyState text="还没有 agent" hint="新建一个开始对话" />);
    const el = document.querySelector('[data-part="empty-state"]') as HTMLElement;
    expect(el.getAttribute("data-size")).toBe("page");
    expect(el.querySelector('[data-part="empty-illustration"] svg')).not.toBeNull();
    expect(el.querySelector(".cb-icon")).toBeNull();
    expect(el.querySelector('[data-part="empty-state-text"]')?.textContent).toBe("还没有 agent");
    expect(el.querySelector('[data-part="empty-state-hint"]')?.textContent).toBe(
      "新建一个开始对话",
    );
  });

  it("EmptyState compact: a smaller illustration; an icon overrides it", () => {
    zh(<EmptyState size="compact" text="没有匹配的会话" icon="search" />);
    const el = document.querySelector('[data-part="empty-state"]') as HTMLElement;
    expect(el.getAttribute("data-size")).toBe("compact");
    expect(el.querySelector('[data-part="empty-illustration"]')).toBeNull();
    expect(el.querySelector('[data-part="empty-state-icon"]')).not.toBeNull();
  });

  it("Callout is a status with the tone and its button", () => {
    zh(
      <Callout tone="warn" action={{ label: "去配置", href: "/c" }}>
        还没有配置
      </Callout>,
    );
    const el = screen.getByRole("status");
    expect(el.getAttribute("data-tone")).toBe("warn");
    expect(within(el).getByRole("link", { name: "去配置" })).toBeTruthy();
  });
});

describe("ListPage variants", () => {
  it("objects variant wraps rows in one panel", () => {
    zh(
      <ListPage header={header} variant="objects" listLabel="列表">
        <ObjectRow mark={{ text: "a" }} name="a" />
        <ObjectRow mark={{ text: "b" }} name="b" />
      </ListPage>,
    );
    expect(document.querySelectorAll(".cb-object-list")).toHaveLength(1);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("loading draws skeleton rows in the object row shape, busy, in place of the rows", () => {
    zh(
      <ListPage header={header} variant="objects" listLabel="列表" loading>
        <ObjectRow mark={{ text: "a" }} name="a" />
      </ListPage>,
    );
    const list = screen.getByRole("list", { name: "列表" });
    expect(list.getAttribute("aria-busy")).toBe("true");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.classList.contains("cb-object-row")).toBe(true);
      expect(r.getAttribute("data-skeleton")).toBe("true");
      expect(r.querySelector(".cb-object-mark")).not.toBeNull();
    }
    expect(screen.queryByText("a")).toBeNull();
    expect(screen.getByText("正在加载")).toBeTruthy();
  });

  it("loading wins over empty: no empty state flashes before the first answer", () => {
    zh(
      <ListPage
        header={header}
        variant="objects"
        loading
        empty={{ icon: "empty", text: "还没有 agent" }}
      />,
    );
    expect(screen.queryByText("还没有 agent")).toBeNull();
    expect(document.querySelectorAll('[data-skeleton="true"]').length).toBe(3);
  });

  it("ObjectList takes the row count of its skeleton", () => {
    zh(<ObjectList label="l" loading={5} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("a records list page shows a skeleton while loading", () => {
    zh(
      <ListPage header={header} loading>
        <table />
      </ListPage>,
    );
    expect(document.querySelector("table")).toBeNull();
    expect(document.querySelector(".cb-skeleton")).not.toBeNull();
  });

  it("empty replaces the content", () => {
    zh(
      <ListPage
        header={header}
        variant="objects"
        empty={{ icon: "empty", text: "空空如也" }}
        callout={{ tone: "warn", children: "注意" }}
      >
        <ObjectRow mark={{ text: "a" }} name="a" />
      </ListPage>,
    );
    expect(screen.getByText("空空如也")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});

describe("SettingsPage grouped nav", () => {
  it("draws group labels and counts and marks the current item", () => {
    zh(
      <SettingsPage
        header={header}
        nav={[
          {
            group: "组织",
            items: [
              { id: "members", label: "成员", href: "/m", count: 5 },
              { id: "models", label: "模型", href: "/mo" },
            ],
          },
          { group: "安全", items: [{ id: "grants", label: "授权", href: "/g" }] },
        ]}
        activeNav="models"
      >
        x
      </SettingsPage>,
    );
    expect(screen.getByText("组织").className).toContain("cb-settings-nav-group");
    expect(screen.getByText("安全")).toBeTruthy();
    expect(screen.getByText("5").className).toContain("cb-settings-nav-count");
    expect(screen.getByRole("link", { name: "模型" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /成员/ }).getAttribute("aria-current")).toBeNull();
  });
});
