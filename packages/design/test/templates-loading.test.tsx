import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthPage,
  type Column,
  DataTable,
  DesignProvider,
  DetailPage,
  FormPage,
  FormSection,
  type InboxLoading,
  InboxPage,
  OverviewPage,
  SettingsPage,
  WizardPage,
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

const actionRow = {
  unsaved: 2,
  errors: 1,
  cancel: { label: "放弃", onSelect: () => {} },
  secondary: { label: "存草稿", onSelect: () => {} },
  primary: { label: "保存", onSelect: () => {} },
};

describe("FormPage / FormSection loading", () => {
  it("FormPage loading draws the frame and no children", () => {
    zh(
      <FormPage header={header} actionRow={actionRow} loading>
        <FormSection id="a" title="基本信息" description="名称与说明" loading={{ fields: 3 }}>
          <p>REAL FIELD</p>
        </FormSection>
        <FormSection id="b" title="模型" loading={{ fields: 2 }} />
      </FormPage>,
    );
    expect(screen.queryByText("REAL FIELD")).toBeNull();
    expect(document.querySelector('[data-template="FormPage"]')).not.toBeNull();
    expect(parts("page-header")).toHaveLength(1);
    expect(parts("content")).toHaveLength(1);
    expect(count(".cb-form-section")).toBe(2);
    expect(count('[data-part="loading-field"]')).toBe(5);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getAllByText("正在加载")).toHaveLength(1);
  });

  it("loading form keeps the action row with disabled buttons", () => {
    zh(<FormPage header={header} actionRow={actionRow} loading />);
    expect(parts("action-row")).toHaveLength(1);
    for (const name of ["放弃", "存草稿", "保存"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    // Nothing is known to be unsaved yet.
    expect(parts("action-row-unsaved")).toHaveLength(0);
    expect(parts("action-row-errors")).toHaveLength(0);
  });

  it("a loading section keeps its title and description real", () => {
    zh(
      <FormSection id="a" title="基本信息" description="名称与说明" loading={{ fields: 2 }}>
        <p>REAL FIELD</p>
      </FormSection>,
    );
    expect(screen.getByRole("heading", { name: "基本信息" })).toBeTruthy();
    expect(screen.getByText("名称与说明")).toBeTruthy();
    expect(screen.queryByText("REAL FIELD")).toBeNull();
  });

  it("a field placeholder is the loaded field's own box: label slot, then a control-height box", () => {
    zh(<FormSection id="a" title="T" loading={{ fields: 2 }} />);
    const card = document.querySelector(".cb-form-section-fields");
    const fields = card?.querySelectorAll(":scope > .cb-field");
    expect(fields).toHaveLength(2);
    const field = fields?.[0];
    const head = field?.querySelector(":scope > .cb-field-head");
    expect(head?.querySelector('[data-part="skeleton-text"][data-size="body"]')).not.toBeNull();
    const box = field?.querySelector(':scope > [data-part="skeleton-box"]') as HTMLElement | null;
    expect(box?.dataset.box).toBe("default");
    // No width of its own: the field's rule decides, as for the loaded control.
    expect(box?.style.width).toBe("");
  });

  it("a loading flush section keeps its flush card and draws the loaded switch rows", () => {
    zh(
      <FormPage header={header} actionRow={actionRow} loading>
        <FormSection id="t" title="工具" flush loading={{ fields: 3 }} />
      </FormPage>,
    );
    const card = document.querySelector(".cb-form-section-fields");
    expect(card?.getAttribute("data-flush")).toBe("true");
    const rows = card?.querySelectorAll(":scope > ul.cb-switch-list > li.cb-switch-row");
    expect(rows).toHaveLength(3);
    expect(rows?.[0]?.querySelector(".cb-switch-row-text")).not.toBeNull();
    expect(rows?.[0]?.querySelector('[data-part="skeleton-box"]')).not.toBeNull();
    expect(count('[data-part="loading-field"]')).toBe(0);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("a ready section renders for real next to a loading one", () => {
    zh(
      <FormPage header={header} actionRow={actionRow} loading>
        <FormSection id="a" title="基本信息">
          <p>READY FIELD</p>
        </FormSection>
        <FormSection id="b" title="模型" loading={{ fields: 1 }} />
      </FormPage>,
    );
    expect(screen.getByText("READY FIELD")).toBeTruthy();
    expect(count('[data-part="loading-field"]')).toBe(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("a loading section outside a loading page announces itself, without a status role", () => {
    zh(<FormSection id="a" title="T" loading={{ fields: 1 }} />);
    expect(screen.getAllByText("正在加载")).toHaveLength(1);
    expect(document.querySelector(".cb-form-section")?.getAttribute("aria-busy")).toBe("true");
  });

  it("a page that is not loading draws no placeholder and no busy mark", () => {
    zh(
      <FormPage header={header} actionRow={actionRow}>
        <FormSection id="a" title="T">
          <p>REAL FIELD</p>
        </FormSection>
      </FormPage>,
    );
    expect(screen.getByText("REAL FIELD")).toBeTruthy();
    expect(count('[data-part="loading-field"]')).toBe(0);
    expect(count('[aria-busy="true"]')).toBe(0);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("SettingsPage loading", () => {
  const nav = [
    {
      group: "组织",
      items: [
        { id: "general", label: "常规", href: "/s/general" },
        { id: "members", label: "成员", href: "/s/members" },
      ],
    },
  ];

  it("SettingsPage loading draws the frame and no children", () => {
    zh(
      <SettingsPage
        header={{ ...header, description: "管理组织" }}
        nav={nav}
        activeNav="general"
        loading={{ sections: [{ fields: 2 }, { fields: 3, title: "安全" }] }}
      >
        <p>REAL CONTENT</p>
      </SettingsPage>,
    );
    expect(screen.queryByText("REAL CONTENT")).toBeNull();
    expect(document.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
    expect(parts("page-header")).toHaveLength(1);
    expect(count(".cb-settings-content > .cb-form-section")).toBe(2);
    expect(count('[data-part="loading-field"]')).toBe(5);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    // What the page knows stays real: the sub-nav, the description, a known title.
    expect(screen.getByRole("link", { name: "成员" })).toBeTruthy();
    expect(screen.getByText("管理组织")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "安全" })).toBeTruthy();
    // An unknown title and description are slots in the section's head.
    const first = document.querySelectorAll(".cb-form-section-head")[0];
    expect(first?.querySelector('[data-size="heading"]')).not.toBeNull();
  });

  it("without sections the children render as they are", () => {
    zh(
      <SettingsPage header={header} nav={nav} activeNav="general" loading={{}}>
        <FormSection id="a" title="T" loading={{ fields: 1 }} />
      </SettingsPage>,
    );
    expect(count('[data-part="loading-field"]')).toBe(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("keeps the action row, disabled", () => {
    zh(
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="general"
        actionRow={actionRow}
        loading={{ sections: [{ fields: 1 }] }}
      />,
    );
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("WizardPage loading", () => {
  const steps = ["类型", "端点", "完成"];

  it("WizardPage loading draws the frame and no children", () => {
    zh(
      <WizardPage
        header={header}
        steps={steps}
        current={1}
        actionRow={actionRow}
        loading={{ fields: 3 }}
      >
        <p>REAL CONTENT</p>
      </WizardPage>,
    );
    expect(screen.queryByText("REAL CONTENT")).toBeNull();
    expect(document.querySelector('[data-template="WizardPage"]')).not.toBeNull();
    expect(parts("page-header")).toHaveLength(1);
    expect(parts("content")).toHaveLength(1);
    // The step bar is real, and the fields sit in a card.
    expect(document.querySelectorAll(".cb-step")).toHaveLength(3);
    expect(screen.getByText("端点")).toBeTruthy();
    expect(document.querySelector(".cb-card .cb-stack > .cb-field")).not.toBeNull();
    expect(count('[data-part="loading-field"]')).toBe(3);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("AuthPage loading", () => {
  it("AuthPage loading draws the frame and no children", () => {
    zh(
      <AuthPage title="登录" subtitle="欢迎回来" loading={{ fields: 2 }}>
        <p>REAL CONTENT</p>
      </AuthPage>,
    );
    expect(screen.queryByText("REAL CONTENT")).toBeNull();
    expect(document.querySelector('[data-template="AuthPage"]')).not.toBeNull();
    expect(count(".cb-auth-side")).toBe(2);
    expect(count(".cb-auth-card")).toBe(1);
    expect(screen.getByRole("heading", { name: "登录" })).toBeTruthy();
    expect(screen.getByText("欢迎回来")).toBeTruthy();
    expect(count('[data-part="loading-field"]')).toBe(2);
    // The submit button is part of the loaded card: a prominent box.
    expect(count('.cb-auth-card [data-box="prominent"]')).toBe(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("an unknown title is a bar", () => {
    zh(<AuthPage title="" loading={{ fields: 1 }} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.querySelector('.cb-auth-head [data-size="title"]')).not.toBeNull();
  });
});
