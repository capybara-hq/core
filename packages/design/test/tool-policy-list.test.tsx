import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, ToolPolicyList, type ToolPolicyRow } from "../src/index";

afterEach(cleanup);
const css = readFileSync(resolve(import.meta.dirname, "../src/styles/controls.css"), "utf8");

const OPTIONS = [
  { value: "", label: "默认" },
  { value: "ask", label: "需审批" },
  { value: "deny", label: "禁止" },
];

const ROWS: ToolPolicyRow[] = [
  { id: "write", label: "更新待办", checked: true, policy: "ask" },
  { id: "read", label: "读取待办", checked: false, policy: "" },
  {
    id: "gone",
    label: "清空待办",
    checked: true,
    policy: "",
    note: { text: "不可用：扩展已停用", tone: "warn" },
  },
];

/** A controlled list, as a page holds it. */
function Harness({
  rows: initial = ROWS,
  search,
  selectAll = true,
  disabled,
  onPolicy = () => {},
}: {
  rows?: ToolPolicyRow[];
  search?: boolean;
  selectAll?: boolean;
  disabled?: boolean;
  onPolicy?: (id: string, v: string) => void;
}) {
  const [rows, setRows] = useState(initial);
  const check = (ids: string[], next: boolean) =>
    setRows((cur) => cur.map((r) => (ids.includes(r.id) ? { ...r, checked: next } : r)));
  return (
    <DesignProvider locale="zh">
      <ToolPolicyList
        label="待办清单的工具"
        rows={rows}
        policyOptions={OPTIONS}
        onCheck={(id, next) => check([id], next)}
        onPolicy={onPolicy}
        {...(selectAll ? { onCheckAll: check } : {})}
        {...(search !== undefined ? { search } : {})}
        {...(disabled !== undefined ? { disabled } : {})}
      />
    </DesignProvider>
  );
}

describe("ToolPolicyList (spec §6.36)", () => {
  it("one row per tool: its checkbox named by the title and its policy select beside it", () => {
    render(<Harness />);
    const list = screen.getByRole("list", { name: "待办清单的工具" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    const write = within(rows[0] as HTMLElement);
    expect(write.getByRole("checkbox", { name: "更新待办" })).toHaveProperty("checked", true);
    const select = write.getByRole("combobox", { name: "更新待办 的策略" });
    expect(select.textContent).toContain("需审批");
    expect(select).toHaveProperty("disabled", false);
    // a warn note sits under its title
    expect(within(rows[2] as HTMLElement).getByText("不可用：扩展已停用")).toBeTruthy();
  });

  it("an unchecked tool's select is disabled; checking it enables the select", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const select = () => screen.getByRole("combobox", { name: "读取待办 的策略" });
    expect(select()).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("checkbox", { name: "读取待办" }));
    expect(select()).toHaveProperty("disabled", false);
  });

  it("picking a policy reports the row and the value", async () => {
    const onPolicy = vi.fn();
    render(<Harness onPolicy={onPolicy} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "更新待办 的策略" }));
    await user.click(screen.getByRole("option", { name: "禁止" }));
    expect(onPolicy).toHaveBeenCalledWith("write", "deny");
  });

  it("select-all shows the count, is mixed while some are checked, and checks every row", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const all = screen.getByRole("checkbox", { name: "全选" });
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    expect(screen.getByText("2/3")).toBeTruthy();
    await user.click(all);
    expect(screen.getAllByRole("checkbox").every((c) => (c as HTMLInputElement).checked)).toBe(
      true,
    );
    expect(screen.getByText("3/3")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "全选" }));
    expect(screen.getByText("0/3")).toBeTruthy();
  });

  it("the filter narrows the rows by title; select-all acts on the rows shown", async () => {
    render(<Harness search />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "搜索工具" }), "读取");
    const list = screen.getByRole("list", { name: "待办清单的工具" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await user.click(screen.getByRole("checkbox", { name: "全选" }));
    await user.clear(screen.getByRole("searchbox", { name: "搜索工具" }));
    // only 读取待办 was switched on; the others kept their state
    expect(screen.getByRole("checkbox", { name: "读取待办" })).toHaveProperty("checked", true);
    expect(screen.getByRole("checkbox", { name: "更新待办" })).toHaveProperty("checked", true);
    await user.type(screen.getByRole("searchbox", { name: "搜索工具" }), "没有这个");
    expect(screen.getByText("没有匹配的工具")).toBeTruthy();
    // a filter matching nothing is the panel empty state, as the sidebar's (spec §6.18)
    expect(
      screen
        .getByText("没有匹配的工具")
        .closest('[data-part="empty-state"]')
        ?.getAttribute("data-size"),
    ).toBe("panel");
  });

  it("without onCheckAll and search, neither the select-all row nor the filter is drawn", () => {
    render(<Harness selectAll={false} />);
    expect(screen.queryByRole("checkbox", { name: "全选" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("disabled turns every checkbox and select off", () => {
    render(<Harness disabled />);
    for (const c of screen.getAllByRole("checkbox")) expect(c).toHaveProperty("disabled", true);
    for (const s of screen.getAllByRole("combobox")) expect(s).toHaveProperty("disabled", true);
  });

  it("rows are split by line-soft and the select takes the layout.policy-select width", () => {
    expect(css).toMatch(
      /\.cb-tool-policy-row \+ \.cb-tool-policy-row \{\s*border-top: 1px solid var\(--cb-line-soft\);/,
    );
    expect(css).toMatch(/\.cb-tool-policy-select \{[^}]*width: var\(--cb-layout-policy-select\);/);
  });
});

describe("ToolPolicyList without onCheck", () => {
  it("draws the title and the select only; a locked row's select is off", async () => {
    const onPolicy = vi.fn();
    render(
      <DesignProvider locale="zh">
        <ToolPolicyList
          label="Slack 的工具"
          rows={[
            { id: "read", label: "读取频道", checked: false, policy: "allow" },
            {
              id: "post",
              label: "发送消息",
              checked: false,
              policy: "deny",
              locked: true,
              note: { text: "组织已禁止这个工具", tone: "warn" },
            },
          ]}
          policyOptions={[
            { value: "allow", label: "允许" },
            { value: "ask", label: "询问" },
            { value: "deny", label: "禁止" },
          ]}
          onPolicy={onPolicy}
          onCheckAll={() => {}}
        />
      </DesignProvider>,
    );
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    const list = screen.getByRole("list", { name: "Slack 的工具" });
    expect(within(list).getByText("读取频道")).toBeTruthy();
    const read = screen.getByRole("combobox", { name: "读取频道 的策略" });
    const post = screen.getByRole("combobox", { name: "发送消息 的策略" });
    expect(read).toHaveProperty("disabled", false);
    expect(post).toHaveProperty("disabled", true);
    await userEvent.click(read);
    await userEvent.click(screen.getByRole("option", { name: "询问" }));
    expect(onPolicy).toHaveBeenCalledWith("read", "ask");
  });
});

describe("ToolPolicyList with control: switch", () => {
  const POLICY = [
    { value: "allow", label: "允许" },
    { value: "ask", label: "询问" },
    { value: "deny", label: "禁止" },
  ];
  const SWITCH_ROWS: ToolPolicyRow[] = [
    {
      id: "send",
      label: "Send message",
      tooltip: "mcp__slack__send_message\nSend a message",
      checked: true,
      policy: "ask",
    },
    {
      id: "draft",
      label: "draft_message",
      checked: false,
      policy: "ask",
      checkLocked: true,
      note: { text: "待复核", tone: "warn", action: { label: "去复核", onClick: () => {} } },
    },
  ];

  it("draws a switch after the select; the select stays on while the tool is off", async () => {
    const onCheck = vi.fn();
    const onPolicy = vi.fn();
    render(
      <DesignProvider locale="zh">
        <ToolPolicyList
          label="Slack 的工具"
          rows={SWITCH_ROWS}
          policyOptions={POLICY}
          control="switch"
          onCheck={onCheck}
          onCheckAll={() => {}}
          onPolicy={onPolicy}
        />
      </DesignProvider>,
    );
    // no checkbox and no select-all: the use control is the switch
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    const send = screen.getByRole("switch", { name: "启用 Send message" });
    expect(send.getAttribute("aria-checked")).toBe("true");
    const row = send.closest("li") as HTMLElement;
    // the switch is the row's last control, after the select
    const select = within(row).getByRole("combobox", { name: "Send message 的策略" });
    expect(select.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the title carries the tooltip (key and description), never a second visible line
    expect(within(row).getByText("Send message").getAttribute("title")).toBe(
      "mcp__slack__send_message\nSend a message",
    );
    expect(within(row).queryByText(/mcp__slack__send_message/)).toBeNull();
    await userEvent.click(send);
    expect(onCheck).toHaveBeenCalledWith("send", false);
    // an off, locked row: the switch is off, its select is not
    expect(screen.getByRole("switch", { name: "启用 draft_message" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("combobox", { name: "draft_message 的策略" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("a note's action is a button after its text", async () => {
    const onClick = vi.fn();
    render(
      <DesignProvider locale="zh">
        <ToolPolicyList
          label="Slack 的工具"
          rows={[
            {
              id: "draft",
              label: "draft_message",
              checked: false,
              policy: "ask",
              note: {
                text: "待复核",
                tone: "warn",
                action: { label: "去复核", ariaLabel: "复核 draft_message", onClick },
              },
            },
          ]}
          policyOptions={POLICY}
          control="switch"
          onCheck={() => {}}
          onPolicy={() => {}}
        />
      </DesignProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "复核 draft_message" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(css).toMatch(/\.cb-tool-policy-note-action \{[^}]*text-decoration: underline;/);
  });

  it("readOnly: the policy is text, no switch, no select", () => {
    render(
      <DesignProvider locale="zh">
        <ToolPolicyList
          label="Slack 的工具"
          rows={SWITCH_ROWS}
          policyOptions={POLICY}
          control="switch"
          readOnly
          onCheck={() => {}}
          onPolicy={() => {}}
        />
      </DesignProvider>,
    );
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.getAllByText("询问")).toHaveLength(2);
  });
});
