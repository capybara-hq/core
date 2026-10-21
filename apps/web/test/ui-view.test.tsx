import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { UiViewRenderer } from "../src/components/ui-view/UiViewRenderer";
import type { UiView } from "../src/lib/ui";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

afterEach(cleanup);

const VIEW: UiView = {
  badge: "1/2",
  blocks: [
    { type: "heading", text: "Weekly report" },
    {
      type: "text",
      markdown: "Line one\nSee [docs](https://example.com) <b>bold</b> [bad](javascript:alert(1))",
    },
    {
      type: "checklist",
      items: [
        { text: "Collect feedback", status: "completed" },
        { text: "Cluster topics", status: "in_progress" },
      ],
    },
    { type: "keyValue", items: [{ label: "Owner", value: "Ada" }] },
    {
      type: "table",
      columns: [
        { key: "name", label: "Name" },
        { key: "constructor", label: "Ctor" },
      ],
      rows: [{ name: "row-1" }],
    },
    { type: "code", language: "ts", text: "const answer = 42;" },
    { type: "image", url: "https://example.com/a.png", alt: "Diagram" },
    { type: "image", url: "javascript:alert(1)", alt: "Evil" },
    {
      type: "chart",
      kind: "bar",
      series: [
        { label: "Mon", value: 3 },
        { label: "Tue", value: 5 },
      ],
    },
    {
      type: "chart",
      kind: "line",
      series: [
        { label: "w1", value: 1 },
        { label: "w2", value: 2 },
      ],
    },
    {
      type: "actions",
      buttons: [
        { actionId: "refresh", label: "Refresh", payload: { page: 2 } },
        { actionId: "wipe", label: "Wipe all", danger: true, payload: { all: true } },
      ],
    },
    {
      type: "form",
      actionId: "add",
      submitLabel: "Add task",
      form: {
        title: "New task",
        fields: [{ key: "title", label: "Title", schema: { type: "string" }, required: true }],
      },
    },
  ],
};

const blockOf = (container: HTMLElement, type: string, nth = 0) =>
  container.querySelectorAll(`[data-block="${type}"]`)[nth] as HTMLElement;

describe("UiViewRenderer", () => {
  it("每种块都映射到 design 组件", () => {
    const { container } = renderPage(<UiViewRenderer view={VIEW} onAction={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Weekly report" })).toBeTruthy();

    // 文本按纯文本显示（保留换行）：不渲染原生 HTML，也不生成链接
    const text = blockOf(container, "text");
    expect(text.textContent).toContain("Line one\nSee [docs](https://example.com) <b>bold</b>");
    expect(text.querySelector("a")).toBeNull();
    expect(text.querySelector("b")).toBeNull();

    const checklist = blockOf(container, "checklist");
    expect(within(checklist).getByText("Cluster topics").closest("li")?.ariaCurrent).toBe("step");

    expect(within(blockOf(container, "keyValue")).getByText("Ada")).toBeTruthy();

    // 表格单元格用 Object.hasOwn 读取：列 key 为 constructor 时不取到原型链上的函数
    const table = blockOf(container, "table");
    expect(within(table).getByText("row-1")).toBeTruthy();
    expect(table.textContent).not.toMatch(/function|native code/);

    expect(within(blockOf(container, "code")).getByText("const answer = 42;")).toBeTruthy();

    // 图片只认 http(s)
    expect(screen.getByRole("img", { name: "Diagram" }).getAttribute("src")).toBe(
      "https://example.com/a.png",
    );
    expect(screen.queryByRole("img", { name: "Evil" })).toBeNull();

    expect(
      within(blockOf(container, "chart", 0)).getByRole("img", { name: /Mon: 3/ }),
    ).toBeTruthy();
    expect(within(blockOf(container, "chart", 1)).getByRole("img", { name: /w2: 2/ })).toBeTruthy();

    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add task" })).toBeTruthy();
    // 插件视图里不出现主操作（对话里唯一的主操作是输入框的「发送」）
    expect(container.querySelector('[data-variant="primary"]')).toBeNull();
  });

  it("按钮回传 actionId 与 payload", async () => {
    const onAction = vi.fn(async () => {});
    renderPage(<UiViewRenderer view={VIEW} onAction={onAction} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh" }));
    expect(onAction).toHaveBeenCalledWith({ actionId: "refresh", payload: { page: 2 } });
  });

  it("危险按钮先经 DangerConfirm 二次确认", async () => {
    const onAction = vi.fn(async () => {});
    renderPage(<UiViewRenderer view={VIEW} onAction={onAction} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Wipe all" }));
    const dialog = await screen.findByRole("dialog");
    expect(onAction).not.toHaveBeenCalled();
    await user.type(within(dialog).getByRole("textbox"), "Wipe all");
    const confirm = within(dialog)
      .getAllByRole("button", { name: "Wipe all" })
      .find((b) => b.getAttribute("data-variant") === "danger-solid") as HTMLElement;
    await user.click(confirm);
    expect(onAction).toHaveBeenCalledWith({ actionId: "wipe", payload: { all: true } });
  });

  it("表单提交带 answer；必填项为空时不提交", async () => {
    const onAction = vi.fn(async () => {});
    renderPage(<UiViewRenderer view={VIEW} onAction={onAction} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add task" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(en.question.fieldRequired))).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: /Title/ }), "Buy milk");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    expect(onAction).toHaveBeenCalledWith({ actionId: "add", answer: { title: "Buy milk" } });
  });
});
