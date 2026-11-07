import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import { useOrgSettingsNav } from "../src/components/settings-nav";
import {
  activeNavOf,
  type NavLevel,
  statusPrompt,
  useAdminItems,
  useNav,
} from "../src/components/shell/nav";
import { SessionContext } from "../src/components/shell/session";
import { json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME } from "./support/render";
import { renderFrame as renderShell, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

beforeEach(() => {
  resetNavigation("/");
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Opens the sidebar's 更多 flyout (a menu to the right of the sidebar). */
async function openMore() {
  const nav = screen.getByRole("navigation", { name: "主导航" });
  await userEvent.setup().click(within(nav).getByRole("button", { name: "更多" }));
  return screen.findByRole("menu", { name: "更多" });
}

function Probe({ level, superAdmin }: { level: NavLevel; superAdmin: boolean }) {
  const { primary, more, adminHref } = useNav(0, level, false, superAdmin);
  return (
    <pre data-testid="ids">
      {JSON.stringify({
        primary: primary.map((n) => n.id),
        more: more.map((n) => n.id),
        adminHref: adminHref ?? null,
      })}
    </pre>
  );
}

function ids(level: NavLevel, superAdmin: boolean) {
  render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <Probe level={level} superAdmin={superAdmin} />
    </NextIntlClientProvider>,
  );
  return JSON.parse(screen.getByTestId("ids").textContent ?? "{}") as {
    primary: string[];
    more: string[];
    adminHref: string | null;
  };
}

describe("nav by level (role hiding is cosmetic; the kernel decides)", () => {
  // The inbox is the brand row's button (acceptance round 2, B2). No home item: 新会话 is the home;
  // 技能 and 连接器 sit under 智能体 (acceptance 2026-11-07). 技能 is for members up.
  const primaryGuest = ["agents", "connectors", "environments"];
  const primary = ["agents", "skills", "connectors", "environments"];
  // 组织设置 is shown to members too (read-only for them; user decision, role pass item 8)
  // 插件 and 扩展 for members up (read-only for members; the kernel's org.extensions.read)
  // 智能体模板 is no item: it is the 模板 tab of 智能体 (ruling P4-14)
  const member = ["plugins", "extensions", "settings"];
  const admin = ["plugins", "extensions", "channels", "evals", "settings"];
  const cases: [NavLevel, boolean, string[], string[]][] = [
    ["guest", false, primaryGuest, []],
    ["member", false, primary, member],
    ["admin", false, primary, admin],
    ["guest", true, primaryGuest, []],
    ["admin", true, primary, admin],
  ];
  for (const [level, superAdmin, top, more] of cases) {
    it(`${level}${superAdmin ? " + super admin" : ""}`, () => {
      expect(ids(level, superAdmin)).toEqual({
        primary: top,
        more,
        adminHref: superAdmin ? "/admin" : null,
      });
    });
  }

  it("no item is the home page; 技能 and 连接器 are never in the 更多 flyout", () => {
    for (const level of ["guest", "member", "admin"] as const) {
      const { primary: top, more } = ids(level, true);
      cleanup();
      expect(top).not.toContain("overview");
      expect(more).not.toContain("overview");
      expect(more).not.toContain("skills");
      expect(more).not.toContain("connectors");
    }
  });

  it("the nav reads 智能体 技能 连接器 环境 after 新会话; members see 插件 扩展 组织设置 under 更多; org admins also 渠道 评测与运行", () => {
    function Labels({ level }: { level: NavLevel }) {
      const { primary, more } = useNav(0, level, false, false);
      return (
        <pre data-testid={level}>
          {JSON.stringify({
            primary: primary.map((n) => [n.label, n.icon, n.href]),
            more: more.map((n) => [n.label, n.icon, n.href]),
          })}
        </pre>
      );
    }
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <Labels level="member" />
        <Labels level="admin" />
      </NextIntlClientProvider>,
    );
    const read = (id: string) => JSON.parse(screen.getByTestId(id).textContent ?? "{}");
    // 技能 and 连接器 keep the icons they had in the flyout
    expect(read("member")).toEqual({
      primary: [
        ["智能体", "agent", "/agents"],
        ["技能", "skills", "/skills"],
        ["连接器", "connector", "/connectors"],
        ["环境", "cpu", "/environments"],
      ],
      more: [
        ["插件", "catalog", "/plugins"],
        ["扩展", "extension", "/extensions"],
        ["组织设置", "settings", "/settings/organization"],
      ],
    });
    expect(read("admin").primary).toEqual(read("member").primary);
    expect(read("admin").more).toEqual([
      ["插件", "catalog", "/plugins"],
      ["扩展", "extension", "/extensions"],
      ["渠道", "channel", "/channels"],
      ["评测与运行", "evals", "/evals"],
      ["组织设置", "settings", "/settings/organization"],
    ]);
  });

  it("⌘K actions follow the role: 新建 Agent from member, 添加连接器 for org admins only", () => {
    function Actions({ level }: { level: NavLevel }) {
      const { commands } = useNav(0, level, false, false);
      const actions = commands.find((g) => g.label === zh.nav.actions)?.items ?? [];
      return <pre data-testid={level}>{JSON.stringify(actions.map((i) => i.id))}</pre>;
    }
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <Actions level="guest" />
        <Actions level="member" />
        <Actions level="admin" />
      </NextIntlClientProvider>,
    );
    const read = (id: string) => JSON.parse(screen.getByTestId(id).textContent ?? "[]");
    expect(read("guest")).toEqual([]);
    expect(read("member")).toEqual(["new-agent"]);
    expect(read("admin")).toEqual(["new-agent", "new-app"]);
  });

  it("the admin context lists 概览 收件箱 账号 组织 插件 扩展 技能 连接器模板 智能体模板 模型 部署设置 (no 平台目录 or 市场)", () => {
    function Admin() {
      const items = useAdminItems();
      return <pre data-testid="admin">{JSON.stringify(items.map((i) => [i.label, i.href]))}</pre>;
    }
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <Admin />
      </NextIntlClientProvider>,
    );
    expect(JSON.parse(screen.getByTestId("admin").textContent ?? "[]")).toEqual([
      ["概览", "/admin"],
      ["收件箱", "/admin/inbox"],
      ["账号", "/admin/accounts"],
      ["组织", "/admin/orgs"],
      ["插件", "/admin/plugins"],
      ["扩展", "/admin/extensions"],
      ["技能", "/admin/skills"],
      ["连接器模板", "/admin/connector-templates"],
      ["智能体模板", "/admin/agent-templates"],
      ["模型", "/admin/models"],
      ["部署设置", "/admin/settings"],
    ]);
  });
});

describe("admin context counts", () => {
  it("收件箱 and 插件 carry their counts; a zero or unknown count shows none", () => {
    function Admin() {
      const items = useAdminItems({ inbox: 3, plugins: 0 });
      return (
        <pre data-testid="admin">
          {JSON.stringify(items.filter((i) => i.count !== undefined).map((i) => [i.id, i.count]))}
        </pre>
      );
    }
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <Admin />
      </NextIntlClientProvider>,
    );
    expect(JSON.parse(screen.getByTestId("admin").textContent ?? "[]")).toEqual([["inbox", 3]]);
  });
});

describe("org settings nav", () => {
  it("has neither 扩展 nor 已安装的插件 (they moved to the workspace 插件 and 扩展 pages)", () => {
    function Groups() {
      const groups = useOrgSettingsNav();
      return <pre data-testid="groups">{JSON.stringify(groups.flatMap((g) => g.items))}</pre>;
    }
    render(
      <SessionContext.Provider value={{ me: ME } as never}>
        <NextIntlClientProvider locale="zh" messages={zh}>
          <Groups />
        </NextIntlClientProvider>
      </SessionContext.Provider>,
    );
    const items = JSON.parse(screen.getByTestId("groups").textContent ?? "[]") as {
      id: string;
      href: string;
    }[];
    expect(items.map((i) => i.id)).toEqual([
      "organization",
      "members",
      "models",
      "tokens",
      "sandbox",
    ]);
    expect(items.some((i) => i.href === "/settings/extensions")).toBe(false);
    expect(items.some((i) => i.href === "/settings/plugins")).toBe(false);
  });
});

describe("activeNavOf", () => {
  it.each([
    ["/settings/members", "settings"],
    ["/settings/organization", "settings"],
    ["/chat/abc", ""],
    ["/agents/a1", "agents"],
    // the template page sits under 智能体 (its 模板 tab; ruling P4-14)
    ["/agents/templates/t1", "agents"],
    ["/connectors/c1", "connectors"],
    ["/environments", "environments"],
    ["/environments/e1", "environments"],
    ["/plugins", "plugins"],
    ["/plugins/i1/enable", "plugins"],
    ["/extensions", "extensions"],
    ["/trajectories/x", "evals"],
    ["/account/connections", ""],
    // the new conversation is the home: 新会话 is current; `/` redirects there before rendering
    ["/chat", "new"],
    ["/", ""],
    // an extension page is its sidebar item (m1), decoded like the item ids
    ["/p/example-board/board", "ext:example-board/board"],
    ["/p/%40acme%2Fboard/main%20view", "ext:@acme/board/main view"],
  ])("%s → %s", (path, id) => {
    expect(activeNavOf(path)).toBe(id);
  });
});

describe("statusPrompt", () => {
  it.each([
    ["/", "grant@acme:~"],
    ["/agents/new", "grant@acme:~/agents/new"],
    ["/chat/9f60c1e6", "grant@acme:~/chat/9f60c1e6"],
    ["/admin", "grant@acme:/admin"],
    ["/admin/accounts", "grant@acme:/admin/accounts"],
  ])("%s → %s", (path, prompt) => {
    expect(statusPrompt("Grant", "acme", path)).toBe(prompt);
  });

  it("without a current org there is no @<slug>", () => {
    expect(statusPrompt("Grant", null, "/admin")).toBe("grant:/admin");
  });

  it("the login is lowercase, its spaces joined by hyphens", () => {
    expect(statusPrompt(" Grant  Wu ", "acme", "/")).toBe("grant-wu@acme:~");
  });
});

describe("AppFrame contexts", () => {
  const renderFrame = () => renderShell(shellOf(ME));

  it("/admin/* renders the admin context: its items, the way back, no conversations", async () => {
    resetNavigation("/admin/plugins/market");
    renderFrame();
    expect(screen.getByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const plugins = within(nav).getByRole("link", { name: /^插件/ });
    expect(plugins.getAttribute("href")).toBe("/admin/plugins");
    expect(plugins.getAttribute("aria-current")).toBe("page");
    expect(within(nav).queryByRole("link", { name: /平台目录|^市场/ })).toBeNull();
    expect(screen.getByRole("link", { name: /~\/acme/ }).getAttribute("href")).toBe("/chat");
    expect(screen.queryByRole("region", { name: "会话" })).toBeNull();
    expect(within(screen.getByRole("contentinfo")).getByText("grant@acme:/admin/plugins/market"));
  });

  it("/admin/*: the 插件 item counts what waits in 待确认 (pending plugins + requests)", async () => {
    stubApi({
      "GET /api/v1/admin/catalog/items?pending=true": () =>
        json(200, { items: [{ id: "i1" }], nextOffset: null }),
      "GET /api/v1/admin/catalog/requests": () =>
        json(200, { requests: [{ id: "r1" }, { id: "r2" }] }),
    });
    resetNavigation("/admin");
    renderFrame();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const plugins = await within(nav).findByRole("link", { name: /^插件.*3/ });
    expect(plugins.getAttribute("href")).toBe("/admin/plugins");
  });

  it("the new conversation is the home: on /chat 新会话 is the current nav item", () => {
    resetNavigation("/chat");
    renderFrame();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const current = within(nav)
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") === "page");
    expect(current.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["新会话", "/chat"],
    ]);
    expect(within(nav).queryByRole("link", { name: "首页" })).toBeNull();
  });

  it("the workspace status bar prompt is <login>@<slug>:~<path>", async () => {
    resetNavigation("/agents/new");
    renderFrame();
    expect(screen.getByText("page body")).toBeTruthy();
    expect(within(screen.getByRole("contentinfo")).getByText("grant@acme:~/agents/new"));
    // the old footer item 设置 is gone; 组织设置 is in the 更多 flyout
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).queryByRole("link", { name: "设置" })).toBeNull();
    await openMore();
    expect(screen.getByRole("menuitem", { name: "组织设置" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "设置" })).toBeNull();
  });

  it("account menu has 切换组织 ▸, 语言 ▸, 个人设置 → /account/connections, 退出登录", async () => {
    resetNavigation("/");
    renderFrame();
    screen.getByText("page body");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^账户: Grant/ }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      zh.shell.orgMenu,
      zh.common.language,
      zh.shell.accountSettings,
      zh.common.logout,
    ]);
    const item = screen.getByRole("menuitem", { name: zh.shell.accountSettings });
    expect(item.getAttribute("href")).toBe("/account/connections");
  });
});
