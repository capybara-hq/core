import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Callout,
  Card,
  CodeBlock,
  type Column,
  DataTable,
  DesignProvider,
  Dialog,
  EmbedFrame,
  FilePicker,
  FormPage,
  FormSection,
  InlineCard,
  ItemList,
  ItemListItem,
  PropertySection,
  RadioGroup,
  Repeater,
  RightPanel,
  SettingsPage,
  Sheet,
  Subsection,
  ToastProvider,
} from "../src/index";
import { BoxScope } from "../src/layout/box";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

// The box-in-box guard (spec §1 "One box is enough", acceptance item AB): a boxed design component
// never draws another boxed component inside it; components with an unboxed form draw it inside
// a box by themselves.

afterEach(cleanup);
const noop = () => {};

function zh(ui: ReactNode) {
  return render(
    <DesignProvider locale="zh">
      <ToastProvider>{ui}</ToastProvider>
    </DesignProvider>,
  );
}

/** Everything rendered, portals (Dialog, Sheet) included. */
const nested = () => findNestedBoxes(document.body).map(describeNestedBox);

type Row = { id: string; name: string };
const COLUMNS: Column<Row>[] = [{ key: "name", header: "名称", cell: (r) => r.name }];
const table = (
  <DataTable<Row>
    label="模型"
    columns={COLUMNS}
    rows={[{ id: "a", name: "deepseek-chat" }]}
    rowKey={(r) => r.id}
  />
);
const repeater = (
  <Repeater
    label="端点"
    addLabel="添加端点"
    onAdd={noop}
    onRemove={() => noop}
    items={[{ key: "a", title: "deepseek", body: <span>字段</span> }]}
  />
);
const adaptive = (
  <>
    <CodeBlock language="sql" text="DROP TABLE x;" />
    <EmbedFrame src="https://example.com" title="看板" onMessage={noop} />
    {table}
    {repeater}
  </>
);

const CONTAINERS: [string, (children: ReactNode) => ReactNode][] = [
  ["Card", (c) => <Card title="卡片">{c}</Card>],
  [
    "FormSection",
    (c) => (
      <FormSection id="s" title="分组">
        {c}
      </FormSection>
    ),
  ],
  [
    "Dialog",
    (c) => (
      <Dialog open onOpenChange={noop} title="对话框" footer={null}>
        {c}
      </Dialog>
    ),
  ],
  [
    "Sheet",
    (c) => (
      <Sheet open onOpenChange={noop} title="侧板">
        {c}
      </Sheet>
    ),
  ],
  [
    "InlineCard",
    (c) => (
      <InlineCard source="看板" state="ready">
        {c}
      </InlineCard>
    ),
  ],
  ["PropertySection", (c) => <PropertySection title="看板">{c}</PropertySection>],
];

describe("findNestedBoxes (the guard itself, red first)", () => {
  it("finds a Card inside a Card", () => {
    zh(
      <Card title="外">
        <Card title="内">正文</Card>
      </Card>,
    );
    expect(nested()).toEqual(["Card inside Card: 内正文"]);
  });

  it("finds a Card per purpose inside a form card (the /admin/models 用途 pattern)", () => {
    zh(
      <FormSection id="purposes" title="用途">
        <Card title="eval">一</Card>
        <Card title="title">二</Card>
      </FormSection>,
    );
    expect(nested()).toEqual([
      "Card inside FormSection card: eval一",
      "Card inside FormSection card: title二",
    ]);
  });

  it("finds a Callout inside a form card and a framed CodeBlock forced into a Card", () => {
    zh(
      <>
        <FormSection id="m" title="模型">
          <Callout tone="warn">没有可用模型。</Callout>
        </FormSection>
        <Card>
          <CodeBlock text="x" framed />
        </Card>
      </>,
    );
    expect(nested()).toEqual([
      "Callout inside FormSection card: 没有可用模型。",
      "CodeBlock inside Card: x",
    ]);
  });

  it("finds a FilePicker inside a Card (it is allowed only in a Dialog)", () => {
    zh(
      <Card>
        <FilePicker dropLabel="拖到这里" onFiles={noop} />
      </Card>,
    );
    expect(nested().map((s) => s.split(":")[0])).toEqual(["FilePicker inside Card"]);
  });
});

describe("boxed pieces draw their unboxed form inside a box", () => {
  it.each(CONTAINERS)("inside a %s: CodeBlock, EmbedFrame, DataTable and Repeater", (_, wrap) => {
    zh(wrap(adaptive));
    expect(nested()).toEqual([]);
    expect(document.querySelector(".cb-code")?.getAttribute("data-framed")).toBe("false");
    expect(document.querySelector(".cb-embed")?.getAttribute("data-framed")).toBe("false");
    expect(document.querySelector(".cb-table")?.getAttribute("data-framed")).toBe("false");
    expect(document.querySelector(".cb-repeater")?.getAttribute("data-variant")).toBe("divided");
  });

  it("on the page ground they keep their box", () => {
    zh(adaptive);
    expect(document.querySelector(".cb-code")?.getAttribute("data-framed")).toBe("true");
    expect(document.querySelector(".cb-embed")?.getAttribute("data-framed")).toBe("true");
    expect(document.querySelector(".cb-table")?.getAttribute("data-framed")).toBe("true");
    expect(document.querySelector(".cb-repeater")?.getAttribute("data-variant")).toBe("cards");
  });

  it("an explicit choice wins over the box", () => {
    zh(
      <Card>
        <CodeBlock text="x" framed={false} />
        <DataTable<Row>
          label="表"
          columns={COLUMNS}
          rows={[]}
          rowKey={(r) => r.id}
          framed={false}
        />
        <Repeater
          label="模型"
          addLabel="添加"
          variant="rows"
          onAdd={noop}
          onRemove={() => noop}
          items={[]}
        />
      </Card>,
    );
    expect(document.querySelector(".cb-repeater")?.getAttribute("data-variant")).toBe("rows");
    expect(nested()).toEqual([]);
  });

  it("a PropertySection inside a box (the narrow properties sheet) is a heading and hairline group", () => {
    zh(
      <BoxScope kind="properties-sheet">
        <PropertySection title="上下文">
          <CodeBlock text="x" />
        </PropertySection>
        <PropertySection title="文件">一个文件</PropertySection>
      </BoxScope>,
    );
    const sections = document.querySelectorAll(".cb-property-section");
    expect([...sections].map((s) => s.getAttribute("data-inset"))).toEqual(["box", "box"]);
    expect(document.querySelector(".cb-code")?.getAttribute("data-framed")).toBe("false");
  });

  it("a full-height pane holds content like a page, even inside a box", () => {
    zh(
      <BoxScope kind="properties-sheet">
        <RightPanel title="看板" onClose={noop}>
          <CodeBlock text="x" />
          {table}
        </RightPanel>
      </BoxScope>,
    );
    expect(document.querySelector(".cb-code")?.getAttribute("data-framed")).toBe("true");
    expect(nested()).toEqual([]);
  });
});

describe("the allowed exceptions", () => {
  it("option cards and form controls inside a form card", () => {
    zh(
      <FormSection id="sandbox" title="沙箱工具">
        <RadioGroup
          label="策略"
          variant="card"
          value="allow"
          onChange={noop}
          options={[
            { value: "allow", label: "直接执行" },
            { value: "ask", label: "需要审批" },
          ]}
        />
      </FormSection>,
    );
    expect(nested()).toEqual([]);
  });

  it("one FilePicker in a Dialog", () => {
    zh(
      <Dialog open onOpenChange={noop} title="上传插件" footer={null}>
        <FilePicker dropLabel="拖到这里" onFiles={noop} />
      </Dialog>,
    );
    expect(nested()).toEqual([]);
  });
});

describe("the in-box groupings and loading shapes hold no second box", () => {
  it("item rows, a subsection and a flush subsection with tables", () => {
    zh(
      <>
        <FormSection id="purposes" title="用途" flush>
          <ItemList label="用途" inset="flush">
            <ItemListItem title="评测" code="eval" meta="由内核声明">
              <CodeBlock text="x" />
            </ItemListItem>
          </ItemList>
        </FormSection>
        <FormSection id="providers" title="供应商" flush>
          <Subsection title="deepseek" variant="flush">
            {table}
          </Subsection>
          <Subsection title="qwen" variant="flush">
            {table}
          </Subsection>
        </FormSection>
        <Card title="凭据">
          <Subsection title="高级" description="一般不用改。">
            {repeater}
          </Subsection>
        </Card>
      </>,
    );
    expect(nested()).toEqual([]);
  });

  it("FormSection items, SettingsPage item-group and list-editor shapes", () => {
    zh(
      <>
        <FormPage
          header={{ path: [{ label: "x" }], title: "表单" }}
          actionRow={{ primary: { label: "保存", onSelect: noop } }}
          loading
        >
          <FormSection
            id="purposes"
            title="用途"
            loading={{ items: [{ lines: 2, lineSize: "small", field: { control: "select" } }] }}
          />
        </FormPage>
        <SettingsPage
          header={{ path: [{ label: "x" }], title: "" }}
          nav={[]}
          activeNav=""
          loading={{
            sections: [
              { items: [{ lines: 1 }] },
              { fields: [{ control: "item-group" }, { control: "list-editor" }] },
              { fields: [{ control: "radio-cards" }] },
            ],
          }}
        />
      </>,
    );
    expect(nested()).toEqual([]);
  });
});
