import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import SandboxSettingsPage from "../src/app/(app)/settings/sandbox/page";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRoute } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const SETTINGS = "/api/v1/orgs/o1/settings";

const actionRow = (locale: "zh" | "en") =>
  screen.queryByRole("region", { name: locale === "zh" ? "待提交改动" : "Pending changes" });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => resetNavigation("/settings/sandbox"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("沙箱设置（SettingsPage）", () => {
  it.each(LOCALES)(
    "sandbox settings save on their own page (nav current: sandbox) (%s)",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        [`GET ${SETTINGS}`]: () =>
          json(200, { settings: { toolSearch: "on", sandboxToolPolicy: "allow" } }),
        [`PATCH ${SETTINGS}`]: (c) =>
          json(200, { settings: { toolSearch: "on", ...(bodyOf(c) as object) } }),
      });
      const { container } = await renderRoute(SandboxSettingsPage, lastStubRoutes(), { locale });
      await screen.findByRole("radio", { name: new RegExp(`^${m.orgSettings.sandbox.allow}`) });
      const current = container.querySelector('.cb-settings-nav [aria-current="page"]');
      expect(current?.textContent).toBe(m.connections.nav.sandbox);
      expect(current?.getAttribute("href")).toBe("/settings/sandbox");
      // The general page's fields are not on this page
      expect(screen.queryByText(m.orgSettings.toolSearch.title)).toBeNull();
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("radio", { name: new RegExp(`^${m.orgSettings.sandbox.ask}`) }),
      );
      await user.click(
        within(actionRow(locale) as HTMLElement).getByRole("button", { name: m.orgSettings.save }),
      );
      // Only this page's field goes in the shared PATCH
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ sandboxToolPolicy: "ask" });
      expect(await screen.findByText(m.sandboxSettings.saved)).toBeTruthy();
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
      await renderRoute(SandboxSettingsPage, lastStubRoutes(), { locale });
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
    await renderRoute(SandboxSettingsPage, lastStubRoutes());
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
      await renderRoute(SandboxSettingsPage, lastStubRoutes(), { locale });
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
    await renderRoute(SandboxSettingsPage, lastStubRoutes());
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
    await renderRoute(SandboxSettingsPage, lastStubRoutes());
    const none = await screen.findByRole("radio", { name: new RegExp(`^${o.egress.none}`) });
    expect(none).toHaveProperty("checked", true);
    expect(screen.queryByRole("textbox", { name: o.egress.hosts })).toBeNull();
    expect(actionRow("en")).toBeNull();
  });

  it("旧内核不返回 deployment：不显示沙箱网络一节", async () => {
    stubApi({ [`GET ${SETTINGS}`]: () => json(200, { settings: { toolSearch: "on" } }) });
    await renderRoute(SandboxSettingsPage, lastStubRoutes());
    await screen.findByRole("radio", { name: new RegExp(`^${en.orgSettings.sandbox.allow}`) });
    expect(screen.queryByText(en.orgSettings.egress.title)).toBeNull();
  });

  it.each(LOCALES)(
    "沙箱资源：只读显示实际生效的 cpu / 内存与来源，写明只对新建的沙箱生效（%s）",
    async (locale) => {
      const o = msgs[locale].orgSettings.limits;
      stubApi({
        [`GET ${SETTINGS}`]: () =>
          json(200, {
            settings: { toolSearch: "on" },
            deployment: DEPLOYMENT,
            sandboxLimits: { cpu: 2.5, memoryMb: 4096, source: "override" },
          }),
      });
      await renderRoute(SandboxSettingsPage, lastStubRoutes(), { locale });
      expect(await screen.findByText(o.title)).toBeTruthy();
      expect(screen.getByText(o.cpuValue.replace("{cpu}", "2.5"))).toBeTruthy();
      expect(screen.getByText(o.memoryValue.replace("{mb}", "4096"))).toBeTruthy();
      expect(screen.getByText(o.source.override)).toBeTruthy();
      expect(screen.getByText(o.newOnly)).toBeTruthy();
      // 组织管理员只读：这一节没有可编辑的控件
      expect(screen.queryByRole("spinbutton")).toBeNull();
      expect(actionRow(locale)).toBeNull();
    },
  );

  it("沙箱资源：没有覆盖时来源为部署默认；旧内核不返回 sandboxLimits 时不显示这一节", async () => {
    const o = en.orgSettings.limits;
    stubApi({
      [`GET ${SETTINGS}`]: () =>
        json(200, {
          settings: { toolSearch: "on" },
          sandboxLimits: { cpu: 1, memoryMb: 2048, source: "deployment" },
        }),
    });
    await renderRoute(SandboxSettingsPage, lastStubRoutes());
    expect(await screen.findByText(o.source.deployment)).toBeTruthy();
    cleanup();
    stubApi({ [`GET ${SETTINGS}`]: () => json(200, { settings: { toolSearch: "on" } }) });
    await renderRoute(SandboxSettingsPage, lastStubRoutes());
    await screen.findByRole("radio", { name: new RegExp(`^${en.orgSettings.sandbox.allow}`) });
    expect(screen.queryByText(o.title)).toBeNull();
  });
});
