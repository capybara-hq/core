import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
} from "../src/index";

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

  it("checked items: menuitemcheckbox with aria-checked and a check icon, not a character", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    zh(
      <Menu
        trigger={<button type="button">组织</button>}
        items={[
          { label: "Acme", checked: true, onSelect },
          { label: "Beta", checked: false, onSelect },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "组织" }));
    const acme = await screen.findByRole("menuitemcheckbox", { name: "Acme" });
    const beta = screen.getByRole("menuitemcheckbox", { name: "Beta" });
    expect(acme.getAttribute("aria-checked")).toBe("true");
    expect(beta.getAttribute("aria-checked")).toBe("false");
    expect(acme.querySelector("svg")).toBeTruthy();
    expect(beta.querySelector("svg")).toBeNull();
    expect(acme.textContent).toBe("Acme");
    await user.click(beta);
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
    // 两列网格：标题行（标题 + 计数）与关闭按钮同在第一行，进度条在第二行左列，
    // 宽度由网格列决定，不再用写死的右外边距让出关闭按钮
    const toast = screen.getByText("上传").closest(".cb-toast") as HTMLElement;
    const head = toast.querySelector(".cb-toast-head") as HTMLElement;
    expect(head.textContent).toContain("上传");
    expect(within(head).getByText("1/4")).toBeTruthy();
    const close = head.nextElementSibling as HTMLElement;
    expect(close.className).toBe("cb-toast-close");
    expect(within(close).getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(close.nextElementSibling?.getAttribute("role")).toBe("progressbar");
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/overlays.css"), "utf8");
    const bar = css.match(/\.cb-toast-bar \{([^}]*)\}/)?.[1] ?? "";
    expect(bar).toContain("grid-column: 1");
    expect(bar).not.toMatch(/margin/);
    act(() => screen.getByRole("button", { name: "关闭" }).click());
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
  it("error（role=alert）不在 aria-live 区域内；success 在 role=status 区域内", () => {
    zh(
      <ToastProvider>
        <T />
      </ToastProvider>,
    );
    act(() => screen.getByRole("button", { name: "ok" }).click());
    act(() => screen.getByRole("button", { name: "err" }).click());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("失败了");
    expect(alert.parentElement?.closest("[aria-live], [role=status], [role=alert]")).toBeNull();
    const ok = screen.getByText("已保存").closest(".cb-toast") as HTMLElement;
    const live = ok.closest("[aria-live]");
    expect(live?.getAttribute("role")).toBe("status");
    expect(live?.contains(alert)).toBe(false);
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

describe("清理：DangerConfirm 失败、关闭与描述", () => {
  function H({ onConfirm }: { onConfirm(): Promise<void> }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          re
        </button>
        <DangerConfirm
          open={open}
          onOpenChange={setOpen}
          title="删除 Agent"
          description="不可恢复"
          confirmName="abc"
          confirmLabel="确认删除"
          onConfirm={onConfirm}
        />
      </>
    );
  }

  it("描述通过 aria-describedby 关联到对话框", () => {
    zh(<H onConfirm={async () => {}} />);
    const dlg = screen.getByRole("dialog");
    const id = dlg.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id as string)?.textContent).toBe("不可恢复");
  });

  it("onConfirm 拒绝：对话框保持打开、停止加载、显示错误", async () => {
    const user = userEvent.setup();
    zh(<H onConfirm={() => Promise.reject(new Error("E_CONFLICT · 仍有运行中的任务"))} />);
    await user.type(screen.getByRole("textbox"), "abc");
    const confirm = screen.getByRole("button", { name: "确认删除" }) as HTMLButtonElement;
    await user.click(confirm);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("E_CONFLICT · 仍有运行中的任务");
    expect(confirm.getAttribute("aria-busy")).toBeNull();
    expect(confirm.disabled).toBe(false);
  });

  it("非 Error 的拒绝显示通用文案", async () => {
    const user = userEvent.setup();
    zh(<H onConfirm={() => Promise.reject("x")} />);
    await user.type(screen.getByRole("textbox"), "abc");
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    expect(screen.getByRole("alert").textContent).toBe("操作失败，请重试");
  });

  it("处理中关闭再打开：busy 与错误已重置", async () => {
    const user = userEvent.setup();
    let reject: (e: Error) => void = () => {};
    zh(
      <H
        onConfirm={() =>
          new Promise<void>((_, rej) => {
            reject = rej;
          })
        }
      />,
    );
    await user.type(screen.getByRole("textbox"), "abc");
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    expect(screen.getByRole("button", { name: "确认删除" }).getAttribute("aria-busy")).toBe("true");
    await user.click(screen.getByRole("button", { name: "取消" }));
    act(() => screen.getByRole("button", { name: "re", hidden: true }).click());
    const confirm = screen.getByRole("button", { name: "确认删除" });
    expect(confirm.getAttribute("aria-busy")).toBeNull();
    await act(async () => reject(new Error("迟到的失败")));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("清理：Menu 禁用的导航项", () => {
  it("href + disabled 不渲染链接、aria-disabled，选中不跳转", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    zh(
      <Menu
        trigger={<button type="button">更多</button>}
        items={[
          { label: "设置", href: "/settings", disabled: true, onSelect },
          { label: "文档", href: "/docs" },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "更多" }));
    const menu = await screen.findByRole("menu");
    const disabled = within(menu).getByRole("menuitem", { name: "设置" });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.tagName).not.toBe("A");
    expect(disabled.querySelector("a")).toBeNull();
    await user.click(disabled);
    expect(onSelect).not.toHaveBeenCalled();
    expect(within(menu).getByRole("menuitem", { name: "文档" }).getAttribute("href")).toBe("/docs");
  });

  it("Menu / Popover 的触发按钮带 data-cb-trigger；打开态底色只作用于它们且不覆盖实心变体", async () => {
    const user = userEvent.setup();
    zh(<Menu trigger={<Button>更多</Button>} items={[{ label: "复制", onSelect() {} }]} />);
    const trigger = screen.getByRole("button", { name: "更多" });
    expect(trigger.getAttribute("data-cb-trigger")).toBe("menu");
    await user.click(trigger);
    expect(trigger.getAttribute("data-state")).toBe("open");
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/overlays.css"), "utf8");
    expect(css).not.toMatch(/\[data-state="open"\]:is\(/);
    expect(css).toMatch(
      /\[data-cb-trigger\]\[data-state="open"\]:not\(\[data-variant="primary"\], \[data-variant="danger-solid"\]\)/,
    );
  });
});
