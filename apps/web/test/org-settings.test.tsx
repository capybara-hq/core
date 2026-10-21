import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import OrganizationSettingsPage from "../src/app/[locale]/(app)/settings/organization/page";
import type { Me } from "../src/lib/session";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const MEMBER: Me = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};
const SETTINGS = "/api/v1/orgs/o1/settings";

const actionRow = (locale: "zh" | "en") =>
  screen.queryByRole("region", { name: locale === "zh" ? "待提交改动" : "Pending changes" });

beforeEach(() => resetNavigation("/settings/organization"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("组织设置（SettingsPage）", () => {
  it.each(LOCALES)(
    "管理员：关闭工具搜索 → 出现 ActionRow → 保存 PATCH settings（%s）",
    async (locale) => {
      const m = msgs[locale];
      const o = m.orgSettings;
      const calls = stubApi({
        [`GET ${SETTINGS}`]: () => json(200, { settings: { toolSearch: "on" } }),
        [`PATCH ${SETTINGS}`]: (c) => json(200, { settings: bodyOf(c) }),
      });
      const { container } = renderPage(<OrganizationSettingsPage />, { locale });
      expect(container.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
      // 二级导航与个人设置页一致，当前项为组织设置
      const current = container.querySelector('[aria-current="page"]');
      expect(current?.textContent).toBe(m.connections.nav.organization);
      expect(current?.getAttribute("href")).toBe("/settings/organization");
      const on = await screen.findByRole("radio", { name: new RegExp(`^${o.toolSearch.on}`) });
      expect(on).toHaveProperty("checked", true);
      expect(actionRow(locale)).toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: new RegExp(`^${o.toolSearch.off}`) }));
      const row = actionRow(locale);
      expect(row).not.toBeNull();
      await user.click(within(row as HTMLElement).getByRole("button", { name: o.save }));
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ toolSearch: "off" });
      expect(await screen.findByText(o.saved)).toBeTruthy();
      await vi.waitFor(() => expect(actionRow(locale)).toBeNull());
      expect(
        screen.getByRole("radio", { name: new RegExp(`^${o.toolSearch.off}`) }),
      ).toHaveProperty("checked", true);
    },
  );

  it.each(LOCALES)(
    "管理员：沙箱工具改为「需要审批」→ 保存 PATCH sandboxToolPolicy（%s）",
    async (locale) => {
      const o = msgs[locale].orgSettings;
      const calls = stubApi({
        [`GET ${SETTINGS}`]: () =>
          json(200, { settings: { toolSearch: "on", locale: "en", sandboxToolPolicy: "allow" } }),
        [`PATCH ${SETTINGS}`]: (c) =>
          json(200, {
            settings: { toolSearch: "on", locale: "en", ...(bodyOf(c) as object) },
          }),
      });
      renderPage(<OrganizationSettingsPage />, { locale });
      const allow = await screen.findByRole("radio", { name: new RegExp(`^${o.sandbox.allow}`) });
      expect(allow).toHaveProperty("checked", true);
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: new RegExp(`^${o.sandbox.ask}`) }));
      const row = actionRow(locale);
      expect(row).not.toBeNull();
      await user.click(within(row as HTMLElement).getByRole("button", { name: o.save }));
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ sandboxToolPolicy: "ask" });
      await vi.waitFor(() => expect(actionRow(locale)).toBeNull());
      expect(screen.getByRole("radio", { name: new RegExp(`^${o.sandbox.ask}`) })).toHaveProperty(
        "checked",
        true,
      );
    },
  );

  it("沙箱工具策略缺省（旧内核没有这个字段）按 allow 显示", async () => {
    stubApi({ [`GET ${SETTINGS}`]: () => json(200, { settings: { toolSearch: "on" } }) });
    renderPage(<OrganizationSettingsPage />);
    const allow = await screen.findByRole("radio", {
      name: new RegExp(`^${en.orgSettings.sandbox.allow}`),
    });
    expect(allow).toHaveProperty("checked", true);
    expect(actionRow("en")).toBeNull();
  });

  const DEPLOYMENT = {
    sandboxEgress: { mode: "allowlist", allowHosts: ["registry.npmjs.org", "pypi.org"] },
  };

  it.each(LOCALES)(
    "管理员：沙箱网络改为自定义白名单（初始为部署清单）→ PATCH sandboxEgress；再改回跟随部署发 null（%s）",
    async (locale) => {
      const o = msgs[locale].orgSettings;
      let current: Record<string, unknown> = { toolSearch: "on", locale: "en" };
      const calls = stubApi({
        [`GET ${SETTINGS}`]: () => json(200, { settings: current, deployment: DEPLOYMENT }),
        [`PATCH ${SETTINGS}`]: (c) => {
          const body = bodyOf(c) as { sandboxEgress?: unknown };
          const { sandboxEgress: _e, ...rest } = current;
          current = body.sandboxEgress === null ? rest : { ...current, ...body };
          return json(200, { settings: current, deployment: DEPLOYMENT });
        },
      });
      renderPage(<OrganizationSettingsPage />, { locale });
      const def = await screen.findByRole("radio", { name: new RegExp(`^${o.egress.default}`) });
      expect(def).toHaveProperty("checked", true);
      expect(screen.getByText(o.egress.newOnly)).toBeTruthy();
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: new RegExp(`^${o.egress.allowlist}`) }));
      const hosts = screen.getByRole("textbox", { name: o.egress.hosts }) as HTMLTextAreaElement;
      expect(hosts.value).toBe("registry.npmjs.org\npypi.org");
      await user.clear(hosts);
      await user.type(hosts, "registry.npmjs.org{enter}*.corp.example.org{enter}{enter}");
      const row = actionRow(locale);
      await user.click(within(row as HTMLElement).getByRole("button", { name: o.save }));
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
        sandboxEgress: {
          mode: "allowlist",
          allowHosts: ["registry.npmjs.org", "*.corp.example.org"],
        },
      });
      await vi.waitFor(() => expect(actionRow(locale)).toBeNull());

      await user.click(screen.getByRole("radio", { name: new RegExp(`^${o.egress.default}`) }));
      await user.click(
        within(actionRow(locale) as HTMLElement).getByRole("button", { name: o.save }),
      );
      expect(bodyOf(calls.filter((c) => c.method === "PATCH")[1])).toEqual({ sandboxEgress: null });
      await vi.waitFor(() => expect(actionRow(locale)).toBeNull());
    },
  );

  it("部署不联网时不提供自定义白名单；选不联网 → PATCH { mode: none }", async () => {
    const calls = stubApi({
      [`GET ${SETTINGS}`]: () =>
        json(200, {
          settings: { toolSearch: "on" },
          deployment: { sandboxEgress: { mode: "none", allowHosts: [] } },
        }),
      [`PATCH ${SETTINGS}`]: (c) =>
        json(200, { settings: { toolSearch: "on", ...(bodyOf(c) as object) } }),
    });
    const o = en.orgSettings;
    renderPage(<OrganizationSettingsPage />);
    expect(await screen.findByText(o.egress.defaultHint.none)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: new RegExp(`^${o.egress.allowlist}`) })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: new RegExp(`^${o.egress.none}`) }));
    await user.click(within(actionRow("en") as HTMLElement).getByRole("button", { name: o.save }));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      sandboxEgress: { mode: "none" },
    });
    // 响应不带 deployment（旧内核）时保留之前的，页面不丢沙箱网络一节
    await vi.waitFor(() => expect(actionRow("en")).toBeNull());
    expect(screen.getByRole("radio", { name: new RegExp(`^${o.egress.none}`) })).toHaveProperty(
      "checked",
      true,
    );
  });

  it("存量为自定义白名单、部署已改成不联网：显示为「不联网」，没有待提交改动", async () => {
    stubApi({
      [`GET ${SETTINGS}`]: () =>
        json(200, {
          settings: {
            toolSearch: "on",
            sandboxEgress: { mode: "allowlist", allowHosts: ["a.example.com"] },
          },
          deployment: { sandboxEgress: { mode: "none", allowHosts: [] } },
        }),
    });
    const o = en.orgSettings;
    renderPage(<OrganizationSettingsPage />);
    const none = await screen.findByRole("radio", { name: new RegExp(`^${o.egress.none}`) });
    expect(none).toHaveProperty("checked", true);
    expect(screen.queryByRole("textbox", { name: o.egress.hosts })).toBeNull();
    expect(actionRow("en")).toBeNull();
  });

  it("旧内核不返回 deployment：不显示沙箱网络一节", async () => {
    stubApi({ [`GET ${SETTINGS}`]: () => json(200, { settings: { toolSearch: "on" } }) });
    renderPage(<OrganizationSettingsPage />);
    await screen.findByRole("radio", { name: new RegExp(`^${en.orgSettings.toolSearch.on}`) });
    expect(screen.queryByText(en.orgSettings.egress.title)).toBeNull();
  });

  it("普通成员：只读（单选不可用、说明只有管理员能改），没有 ActionRow", async () => {
    stubApi({ [`GET ${SETTINGS}`]: () => json(200, { settings: { toolSearch: "off" } }) });
    renderPage(<OrganizationSettingsPage />, { me: MEMBER });
    const off = await screen.findByRole("radio", {
      name: new RegExp(`^${en.orgSettings.toolSearch.off}`),
    });
    expect(off).toHaveProperty("checked", true);
    expect(off).toHaveProperty("disabled", true);
    expect(screen.getByText(en.orgSettings.readonly)).toBeTruthy();
    expect(actionRow("en")).toBeNull();
  });
});
