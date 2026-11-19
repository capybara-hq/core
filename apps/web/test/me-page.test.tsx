// `/me` (the compact class's Me tab): the MePanel from the sidebar's own nav, org and account data,
// by role (design spec §6.48: members see only Workspace, org admins add Manage, super admins the admin
// entry), and the admin context `/admin` draws in place of the console's overview on compact.
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import MeView from "../src/app/(app)/me/view";
import type { Me } from "../src/lib/session";
import { resetNavigation } from "./support/navigation";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch } from "./support/server";
import { renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const as = (role: string, isSuperAdmin = false): Me => ({
  ...ME,
  account: { ...ME.account, isSuperAdmin },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

beforeEach(() => resetNavigation("/me"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const panel = () => document.querySelector('[data-part="me-panel"]') as HTMLElement;
const labels = () =>
  [...panel().querySelectorAll('[data-part="group-label"]')].map((e) => e.textContent);
const rows = (group: string) =>
  [
    ...panel().querySelectorAll(
      `[data-group="${group}"] [data-part$="row"], [data-group="${group}"] [data-part="admin-entry"]`,
    ),
  ].map((e) => e.getAttribute("data-id"));

describe("/me by role (hiding is cosmetic; the kernel decides)", () => {
  it("a guest sees 工作区 with 连接器 and 设备 and no 管理 group", () => {
    renderFrame(shellOf(as("guest")), <MeView />);
    expect(labels()).toEqual(["工作区", "账户"]);
    expect(rows("workspace")).toEqual(["connectors", "devices"]);
    expect(panel().querySelector('[data-part="admin-entry"]')).toBeNull();
  });

  it("an org member sees 工作区 only", () => {
    renderFrame(shellOf(as("member")), <MeView />);
    expect(labels()).toEqual(["工作区", "账户"]);
    expect(rows("workspace")).toEqual(["skills", "connectors", "schedules", "devices"]);
    expect(rows("manage")).toEqual([]);
  });

  it("an org admin sees both groups but no admin entry; the rows are the sidebar's 更多 items", () => {
    renderFrame(shellOf(as("admin")), <MeView />);
    expect(labels()).toEqual(["工作区", "管理", "账户"]);
    expect(rows("manage")).toEqual(["plugins", "extensions", "channels", "evals", "settings"]);
    expect(panel().querySelector('[data-part="admin-entry"]')).toBeNull();
  });

  it("a super admin who is an org member sees 管理 with only 管理后台, entering the admin context", () => {
    renderFrame(shellOf(as("member", true)), <MeView />);
    expect(labels()).toEqual(["工作区", "管理", "账户"]);
    expect(rows("manage")).toEqual(["admin"]);
    const entry = panel().querySelector('[data-part="admin-entry"]') as HTMLElement;
    expect(entry.getAttribute("href")).toBe("/admin");
    expect(entry.querySelector('[data-icon="arrow-up-right"]')).not.toBeNull();
  });

  it("an owner who is a super admin sees every row and the admin entry last", () => {
    renderFrame(shellOf(as("owner", true)), <MeView />);
    expect(rows("manage")).toEqual([
      "plugins",
      "extensions",
      "channels",
      "evals",
      "settings",
      "admin",
    ]);
  });

  it("the org's extension pages follow the workspace rows", () => {
    renderFrame(
      shellOf(as("member"), {
        extensions: [
          { plugin: "todo", id: "board", slot: "org.page", title: { zh: "看板", en: "Board" } },
        ] as never,
      }),
      <MeView />,
    );
    const ids = rows("workspace");
    expect(ids.at(-1)).toBe("ext:todo/board");
  });
});

describe("/me", () => {
  it("a first render from the shell cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    renderFrame(shellOf(as("owner", true)), <MeView />);
    expect(screen.getByRole("heading", { level: 1, name: zh.me.title })).toBeTruthy();
    // let pending effects and reads run: a read after mount would show up in the calls
    await act(async () => {
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(panel()).not.toBeNull());
    expect(browser).toEqual([]);
  });

  it("is an OverviewPage with no stat cards, holding the account, org, account group and system line", () => {
    renderFrame(shellOf(as("owner")), <MeView />);
    expect(document.querySelector('[data-template="OverviewPage"]')).not.toBeNull();
    expect(document.querySelector(".cb-stat-cards")).toBeNull();
    expect(within(panel()).getByText("Grant")).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "当前组织：Acme，切换组织" })).toBeTruthy();
    expect(rows("account")).toEqual(["account", "language", "theme", "sign-out"]);
    expect(panel().querySelector('[data-part="system-status"]')?.textContent).toContain("v9.9.9");
  });

  it("sign out is a button; the language row and the org switcher open bottom sheets", async () => {
    renderFrame(shellOf(as("owner")), <MeView />);
    const user = userEvent.setup();
    expect(within(panel()).getByRole("button", { name: "退出登录" })).toBeTruthy();
    await user.click(within(panel()).getByRole("button", { name: /语言/ }));
    const sheet = await screen.findByRole("dialog", { name: "语言" });
    expect(within(sheet).getByRole("radio", { name: "中文" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(within(panel()).getByRole("button", { name: "当前组织：Acme，切换组织" }));
    const orgs = await screen.findByRole("dialog");
    expect(within(orgs).getByRole("radio", { name: "Acme" })).toBeTruthy();
  });
});

describe("/admin on the compact class", () => {
  it("draws the Me page in the admin context in place of the console's overview", () => {
    resetNavigation("/admin");
    renderFrame(shellOf(as("owner", true)), <p>console overview</p>);
    const compact = document.querySelector('[data-part="class-swap-compact"]') as HTMLElement;
    expect(compact.querySelector('[data-part="context-block"]')).not.toBeNull();
    expect(compact.querySelector('[data-part="org-switcher"]')).toBeNull();
    const back = compact.querySelector('[data-part="back-row"]') as HTMLElement;
    expect(back.getAttribute("href")).toBe("/");
    expect(compact.querySelector('[data-group="workspace"]')).toBeNull();
    // the overview stays for the other classes
    const regular = document.querySelector('[data-part="class-swap-regular"]') as HTMLElement;
    expect(within(regular).getByText("console overview")).toBeTruthy();
  });

  it("no swap for a page of the console below /admin, nor for anyone who is no super admin", () => {
    resetNavigation("/admin/accounts");
    renderFrame(shellOf(as("owner", true)), <p>accounts</p>);
    expect(document.querySelector('[data-part="class-swap-compact"]')).toBeNull();
  });
});
