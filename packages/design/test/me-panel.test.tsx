import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, MePanel, type MePanelProps, type MeRow } from "../src/index";

afterEach(cleanup);

const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

const org = {
  name: "示例组织",
  initial: "示",
  slug: "demo",
  role: "组织所有者",
  menu: [{ label: "示例组织", checked: true, onSelect: () => {} }],
};
const link = (id: string, label: string, extra: Partial<MeRow> = {}): MeRow => ({
  id,
  label,
  icon: "skills",
  href: `/${id}`,
  ...extra,
});
const accountRows = (onSignOut = vi.fn()): MeRow[] => [
  link("account", "个人设置"),
  {
    id: "language",
    label: "语言",
    icon: "languages",
    value: "简体中文",
    menu: [{ label: "English", onSelect: () => {} }],
  },
  {
    id: "theme",
    label: "主题",
    icon: "sun",
    theme: {
      label: "主题",
      value: "light",
      lightLabel: "浅色",
      darkLabel: "深色",
      onChange: () => {},
    },
  },
  { id: "sign-out", label: "退出登录", icon: "log-out", onSelect: onSignOut },
];
const base = (extra: Partial<MePanelProps> = {}): MePanelProps => ({
  account: { name: "grant" },
  org,
  workspace: [link("skills", "技能"), link("devices", "设备")],
  manage: [],
  accountRows: accountRows(),
  system: "系统正常 · v0.1.0 · UTC+8",
  ...extra,
});

const labels = () =>
  [...document.querySelectorAll('[data-part="group-label"]')].map((e) => e.textContent);

describe("MePanel", () => {
  it("draws the account, the org switcher, 工作区, 账户 and the system line in no box", () => {
    zh(<MePanel {...base()} />);
    expect(document.querySelector('[data-part="account"]')?.textContent).toContain("grant");
    expect(screen.getByRole("button", { name: "当前组织：示例组织，切换组织" })).toBeTruthy();
    expect(labels()).toEqual(["工作区", "账户"]);
    expect(document.querySelector('[data-part="system-status"]')?.textContent).toBe(
      "系统正常 · v0.1.0 · UTC+8",
    );
  });

  it("a group with no row draws neither its label nor its rows", () => {
    zh(<MePanel {...base({ workspace: [], manage: [] })} />);
    expect(labels()).toEqual(["账户"]);
  });

  it("the manage group lists admin rows, the admin entry ends with an outward arrow", () => {
    zh(
      <MePanel
        {...base({
          manage: [
            link("channels", "渠道"),
            link("admin", "管理后台", { external: true, icon: "admin" }),
          ],
        })}
      />,
    );
    expect(labels()).toEqual(["工作区", "管理", "账户"]);
    const entry = document.querySelector('[data-part="admin-entry"]') as HTMLElement;
    expect(entry.getAttribute("href")).toBe("/admin");
    expect(entry.querySelector('[data-icon="arrow-up-right"]')).not.toBeNull();
    expect(entry.querySelector('[data-icon="chevron-right"]')).toBeNull();
    const channels = document.querySelector('[data-id="channels"]') as HTMLElement;
    expect(channels.querySelector('[data-icon="chevron-right"]')).not.toBeNull();
  });

  it("the admin context draws the context block, no workspace group, the console's pages and the back row last", () => {
    zh(
      <MePanel
        {...base({
          adminContext: true,
          org: null,
          manage: [link("overview", "概览"), link("models", "模型")],
          back: link("back", "回到工作区", { icon: "arrow-left", href: "/" }),
        })}
      />,
    );
    expect(labels()).toEqual(["管理", "账户"]);
    expect(document.querySelector('[data-part="context-block"]')).not.toBeNull();
    expect(document.querySelector('[data-part="org-switcher"]')).toBeNull();
    const group = document.querySelector('[data-group="manage"]') as HTMLElement;
    const rows = [...group.querySelectorAll('[data-part="row"], [data-part="back-row"]')];
    expect(rows.map((r) => r.getAttribute("data-id"))).toEqual(["overview", "models", "back"]);
    expect(rows.at(-1)?.getAttribute("data-part")).toBe("back-row");
    expect(rows.at(-1)?.querySelector('[data-icon="chevron-right"]')).toBeNull();
    // the account group and the status line stay
    expect(document.querySelector('[data-part="system-status"]')).not.toBeNull();
  });

  it("rows are links or buttons: sign out is a button, the theme row holds the toggle, language shows its value", async () => {
    const onSignOut = vi.fn();
    zh(<MePanel {...base({ accountRows: accountRows(onSignOut) })} />);
    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    const theme = document.querySelector('[data-id="theme"]') as HTMLElement;
    expect(within(theme).getByRole("radiogroup", { name: "主题" })).toBeTruthy();
    const language = screen.getByRole("button", { name: /语言/ });
    expect(language.textContent).toContain("简体中文");
    expect(screen.getByRole("link", { name: "个人设置" }).getAttribute("href")).toBe("/account");
  });

  it("the zh and English group labels", () => {
    render(
      <DesignProvider locale="en">
        <MePanel {...base({ manage: [link("channels", "Channels")] })} />
      </DesignProvider>,
    );
    expect(labels()).toEqual(["Workspace", "Manage", "Account"]);
  });

  it("the org switcher and the language row open bottom sheets, not popover menus; a choice runs and closes", async () => {
    const pick = vi.fn();
    zh(
      <MePanel
        {...base({
          org: { ...org, menu: [{ label: "另一个组织", checked: false, onSelect: pick }] },
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "当前组织：示例组织，切换组织" }));
    const sheet = await screen.findByRole("dialog");
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(within(sheet).getByRole("radio", { name: "另一个组织" }));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /语言/ }));
    expect(await screen.findByRole("dialog", { name: "语言" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
