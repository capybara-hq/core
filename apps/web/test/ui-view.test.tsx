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

    // Text is Markdown by the design rules: http(s) links only, raw HTML stays text
    const text = blockOf(container, "text");
    expect(text.querySelector('a[href="https://example.com"]')?.textContent).toBe("docs");
    expect(text.textContent).toContain("<b>bold</b>");
    expect(text.querySelector("b")).toBeNull();
    expect(text.querySelector('a[href^="javascript"]')).toBeNull();

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

  it("a view with nothing to show draws one panel empty state, not a blank body (spec §6.18)", () => {
    // the todo panel with no tasks: one checklist without items
    const { container } = renderPage(
      <UiViewRenderer
        view={{ badge: "0/0", blocks: [{ type: "checklist", items: [] }] }}
        onAction={vi.fn()}
      />,
    );
    const state = container.querySelector('[data-part="empty-state"]');
    expect(state?.getAttribute("data-size")).toBe("panel");
    expect(state?.textContent).toContain(en.ui.empty);
    expect(container.querySelector("[data-block]")).toBeNull();
    cleanup();
    // no blocks at all, and an empty table or key-value list, are the same
    for (const blocks of [
      [],
      [
        { type: "table" as const, columns: [{ key: "a", label: "A" }], rows: [] },
        { type: "keyValue" as const, items: [] },
      ],
    ]) {
      const r = renderPage(<UiViewRenderer view={{ blocks }} onAction={vi.fn()} />);
      expect(screen.getByText(en.ui.empty)).toBeTruthy();
      expect(r.container.querySelectorAll('[data-part="empty-state"]')).toHaveLength(1);
      cleanup();
    }
  });

  it("an empty list among other blocks: the panel empty state in its place; an extension page draws the page style", () => {
    const { container } = renderPage(
      <UiViewRenderer
        view={{
          blocks: [
            { type: "heading", text: "Tasks" },
            { type: "checklist", items: [] },
          ],
        }}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(
      blockOf(container, "checklist")
        .querySelector('[data-part="empty-state"]')
        ?.getAttribute("data-size"),
    ).toBe("panel");
    cleanup();
    const page = renderPage(
      <UiViewRenderer view={{ blocks: [] }} onAction={vi.fn()} emptySize="page" />,
    );
    expect(
      page.container.querySelector('[data-part="empty-state"]')?.getAttribute("data-size"),
    ).toBe("page");
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
