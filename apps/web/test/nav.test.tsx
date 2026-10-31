import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import { AppFrame } from "../src/components/shell/AppFrame";
import {
  activeNavOf,
  type NavLevel,
  statusPrompt,
  useAdminItems,
  useNav,
} from "../src/components/shell/nav";
import { RequireSession } from "../src/components/shell/session";
import { json, stubApi } from "./support/api";
import { Link, resetNavigation } from "./support/navigation";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

beforeEach(() => {
  resetNavigation("/");
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe({ level, enterprise }: { level: NavLevel; enterprise: boolean }) {
  const { primary, more, adminHref } = useNav(0, level, false, enterprise);
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

function ids(level: NavLevel, enterprise: boolean) {
  render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <Probe level={level} enterprise={enterprise} />
    </NextIntlClientProvider>,
  );
  return JSON.parse(screen.getByTestId("ids").textContent ?? "{}") as {
    primary: string[];
    more: string[];
    adminHref: string | null;
  };
}

describe("nav by level (role hiding is cosmetic; the kernel decides)", () => {
  const primary = ["overview", "inbox", "agents"];
  const guest = ["connectors"];
  const member = ["skills", "connectors", "catalog"];
  const admin = [...member, "channels", "evals", "settings"];
  const cases: [NavLevel, boolean, string[]][] = [
    ["guest", false, guest],
    ["member", false, member],
    ["admin", false, admin],
    ["guest", true, guest],
    ["admin", true, admin],
  ];
  for (const [level, enterprise, more] of cases) {
    it(`${level}${enterprise ? " + enterprise admin" : ""}`, () => {
      expect(ids(level, enterprise)).toEqual({
        primary,
        more,
        adminHref: enterprise ? "/admin" : null,
      });
    });
  }

  it("members see 技能 连接器 插件 under 更多; org admins also 渠道 评测与运行 组织设置", () => {
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
    expect(read("member")).toEqual({
      primary: [
        ["首页", "home", "/"],
        ["收件箱", "inbox", "/inbox"],
        ["Agents", "agent", "/agents"],
      ],
      more: [
        ["技能", "skills", "/skills"],
        ["连接器", "connector", "/connectors"],
        ["插件", "catalog", "/catalog"],
      ],
    });
    expect(read("admin").more).toEqual([
      ["技能", "skills", "/skills"],
      ["连接器", "connector", "/connectors"],
      ["插件", "catalog", "/catalog"],
      ["渠道", "channel", "/channels"],
      ["评测与运行", "evals", "/evals"],
      ["组织设置", "settings", "/settings/organization"],
    ]);
  });

  it("the admin context lists 概览 账号 组织 扩展 企业目录 市场 模型 部署设置", () => {
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
      ["账号", "/admin/accounts"],
      ["组织", "/admin/orgs"],
      ["扩展", "/admin/extensions"],
      ["企业目录", "/admin/catalog"],
      ["市场", "/admin/marketplaces"],
      ["模型", "/admin/models"],
      ["部署设置", "/admin/settings"],
    ]);
  });
});

describe("activeNavOf", () => {
  it.each([
    ["/settings/members", "settings"],
    ["/settings/organization", "settings"],
    ["/chat/abc", ""],
    ["/agents/a1", "agents"],
    ["/connectors/c1", "connectors"],
    ["/trajectories/x", "evals"],
    ["/account/connections", ""],
    ["/", "overview"],
    // an extension page is its sidebar item (m1), decoded like the item ids
    ["/p/example-board/board", "ext:example-board/board"],
    ["/p/%40acme%2Fboard/main%20view", "ext:@acme/board/main view"],
  ])("%s → %s", (path, id) => {
    expect(activeNavOf(path)).toBe(id);
  });
});

describe("statusPrompt", () => {
  it.each([
    ["/", "Grant@acme:~"],
    ["/agents/new", "Grant@acme:~/agents/new"],
    ["/admin", "Grant@acme:/admin"],
    ["/admin/accounts", "Grant@acme:/admin/accounts"],
  ])("%s → %s", (path, prompt) => {
    expect(statusPrompt("Grant", "acme", path)).toBe(prompt);
  });

  it("without a current org there is no @<slug>", () => {
    expect(statusPrompt("Grant", null, "/admin")).toBe("Grant:/admin");
  });
});

describe("AppFrame contexts", () => {
  function renderFrame() {
    return render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <DesignProvider locale="zh" link={Link as LinkComponent}>
          <ToastProvider>
            <AppFrame version="v9.9.9">
              <RequireSession>
                <p>page body</p>
              </RequireSession>
            </AppFrame>
          </ToastProvider>
        </DesignProvider>
      </NextIntlClientProvider>,
    );
  }
  const api = () =>
    stubApi({
      "GET /api/v1/me": () => json(200, ME),
      "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [], truncated: false }),
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, { groups: [], next: null, archivedCount: 0 }),
      "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    });

  it("/admin/* renders the admin context: its items, the way back, no conversations", async () => {
    resetNavigation("/admin/marketplaces");
    api();
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const market = within(nav).getByRole("link", { name: "市场" });
    expect(market.getAttribute("href")).toBe("/admin/marketplaces");
    expect(market.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /~\/acme/ }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("region", { name: "会话" })).toBeNull();
    expect(within(screen.getByRole("contentinfo")).getByText("Grant@acme:/admin/marketplaces"));
  });

  it("the workspace status bar prompt is <login>@<slug>:~<path>", async () => {
    resetNavigation("/agents/new");
    api();
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    expect(within(screen.getByRole("contentinfo")).getByText("Grant@acme:~/agents/new"));
    // the old footer item 设置 is gone
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const more = within(nav).getByRole("button", { name: "更多" });
    if (more.getAttribute("aria-expanded") === "false") fireEvent.click(more);
    expect(within(nav).queryByRole("link", { name: "设置" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "组织设置" })).toBeTruthy();
  });

  it("account menu has 切换组织 ▸, 语言 ▸, 个人设置 → /account/connections, 退出登录", async () => {
    resetNavigation("/");
    api();
    renderFrame();
    await screen.findByText("page body");
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
