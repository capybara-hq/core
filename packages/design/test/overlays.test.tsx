import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  CommandPalette,
  DangerConfirm,
  DesignProvider,
  Dialog,
  Menu,
  Sheet,
  ToastProvider,
  useToast,
} from "../src/index.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

function DialogHarness({ initialFocus }: { initialFocus?: "primary" | "cancel" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="新建"
        initialFocus={initialFocus}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="primary" shortcut="↵">
              创建
            </Button>
          </>
        }
      >
        <p>正文</p>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("焦点在主操作；Tab 不离开；Esc 后焦点归还触发按钮", async () => {
    const user = userEvent.setup();
    zh(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "打开" });
    await user.click(trigger);
    const dlg = screen.getByRole("dialog");
    expect(dlg.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /创建/ }));
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("initialFocus=cancel 焦点在取消", async () => {
    const user = userEvent.setup();
    zh(<DialogHarness initialFocus="cancel" />);
    await user.click(screen.getByRole("button", { name: "打开" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
  });
});

describe("DangerConfirm", () => {
  it("名称匹配前禁用，匹配后 danger-solid，点击调用一次", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    zh(
      <DangerConfirm
        open
        onOpenChange={() => {}}
        title="删除 Agent"
        description="不可恢复"
        confirmName="support-triage"
        confirmLabel="删除"
        onConfirm={onConfirm}
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
    const confirm = screen.getByRole("button", { name: /删除$/ }) as HTMLButtonElement;
    const input = screen.getByRole("textbox");
    await user.type(input, "support-tri");
    expect(confirm.disabled).toBe(true);
    await user.type(input, "age");
    expect(confirm.disabled).toBe(false);
    expect(confirm.getAttribute("data-variant")).toBe("danger-solid");
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("DangerConfirm reset", () => {
  it("取消后重开，确认按钮重新禁用", async () => {
    const user = userEvent.setup();
    function H() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            re
          </button>
          <DangerConfirm
            open={open}
            onOpenChange={setOpen}
            title="删除"
            description="x"
            confirmName="abc"
            confirmLabel="确认删除"
            onConfirm={() => {}}
          />
        </>
      );
    }
    zh(<H />);
    await user.type(screen.getByRole("textbox"), "abc");
    expect((screen.getByRole("button", { name: "确认删除" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await user.click(screen.getByRole("button", { name: "取消" }));
    act(() => screen.getByRole("button", { name: "re", hidden: true }).click());
    expect((screen.getByRole("button", { name: "确认删除" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("焦点归还", () => {
  function H({ kind }: { kind: "palette" | "sheet" }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          go
        </button>
        {kind === "palette" ? (
          <CommandPalette open={open} onOpenChange={setOpen} groups={[]} />
        ) : (
          <Sheet open={open} onOpenChange={setOpen} title="S">
            x
          </Sheet>
        )}
      </>
    );
  }
  it.each(["palette", "sheet"] as const)("%s 关闭后焦点回到触发按钮", async (kind) => {
    const user = userEvent.setup();
    zh(<H kind={kind} />);
    const go = screen.getByRole("button", { name: "go" });
    await user.click(go);
    expect(document.activeElement).not.toBe(go);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(go);
  });
});

describe("Sheet", () => {
  it("dirty 时关闭先确认", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    zh(
      <Sheet open onOpenChange={onOpenChange} title="Agent" dirty>
        内容
      </Sheet>,
    );
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("放弃未保存的修改？")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "放弃" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("非 dirty 直接关闭", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    zh(
      <Sheet open onOpenChange={onOpenChange} title="Agent" openHref="/a/1">
        内容
      </Sheet>,
    );
    expect(screen.getByRole("link", { name: "在新页打开" }).getAttribute("href")).toBe("/a/1");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("Menu", () => {
  it("danger 项排最后且其前有分隔线", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    zh(
      <Menu
        trigger={<button type="button">更多</button>}
        items={[
          { label: "删除", danger: true, onSelect },
          { label: "重命名", onSelect },
          { label: "复制", shortcut: "⌘D", onSelect },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "更多" }));
    const menu = await screen.findByRole("menu");
    const kids = Array.from(menu.children);
    const roles = kids.map((k) => k.getAttribute("role"));
    expect(roles).toEqual(["menuitem", "menuitem", "separator", "menuitem"]);
    expect(kids[3]?.textContent).toContain("删除");
    await user.click(kids[0] as HTMLElement);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("Toast", () => {
  function T() {
    const toast = useToast();
    return (
      <>
        <button type="button" onClick={() => toast.success("已保存")}>
          ok
        </button>
        <button
          type="button"
          onClick={() => toast.error("失败了", { actionLabel: "查看", onAction() {} })}
        >
          err
        </button>
        <button type="button" onClick={() => toast.progress("上传", { done: 1, total: 4 })}>
          prog
        </button>
      </>
    );
  }
  it("success 4000ms 后消失；error 10000ms 后仍在且 role=alert", () => {
    vi.useFakeTimers();
    zh(
      <ToastProvider>
        <T />
      </ToastProvider>,
    );
    act(() => screen.getByRole("button", { name: "ok" }).click());
    act(() => screen.getByRole("button", { name: "err" }).click());
    expect(screen.getByText("已保存")).toBeTruthy();
    expect(screen.getByText("失败了").closest("[role=alert]")).toBeTruthy();
    expect(screen.getByRole("button", { name: /查看/ })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(screen.queryByText("已保存")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("已保存")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("失败了")).toBeTruthy();
    act(() => screen.getAllByRole("button", { name: "关闭" })[0]?.click());
    expect(screen.queryByText("失败了")).toBeNull();
  });
  it("progress 可更新与关闭", () => {
    zh(
      <ToastProvider>
        <T />
      </ToastProvider>,
    );
    act(() => screen.getByRole("button", { name: "prog" }).click());
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  });
});

describe("CommandPalette", () => {
  it("输入 sup 过滤；↵ 调用 onSelect", async () => {
    const user = userEvent.setup();
    const a = vi.fn();
    const b = vi.fn();
    zh(
      <CommandPalette
        open
        onOpenChange={() => {}}
        groups={[
          {
            label: "Agent",
            items: [
              { id: "1", label: "support-triage", onSelect: a },
              { id: "2", label: "billing", onSelect: b },
            ],
          },
        ]}
      />,
    );
    await user.type(screen.getByRole("combobox"), "sup");
    expect(screen.queryByText("billing")).toBeNull();
    expect(screen.getByText("support-triage")).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });
});
