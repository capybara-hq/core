import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { keys } from "../src/lib/query/keys";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const SETTINGS = "/api/v1/orgs/o1/settings";

/**
 * The deployment defaults the kernel sends beside the org's settings (auto mode spec §4.3): the
 * platform's auto-mode switch and its default cloud network.
 */
const DEPLOYMENT = {
  autoMode: { mode: "allowed", source: "default" },
  cloudNetwork: { mode: "open", allowHosts: ["registry.npmjs.org", "pypi.org"] },
};

const actionRow = (locale: "zh" | "en") =>
  screen.queryByRole("region", { name: locale === "zh" ? "待提交改动" : "Pending changes" });

/** A label as a radio's accessible name prefix (escaping regex metacharacters such as brackets). */
const prefix = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

const sectionOf = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;

const MEMBER = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

/** A stubbed org settings read and PATCH: the answer carries the merged settings. */
const stub = (
  settings: Record<string, unknown>,
  deployment: Record<string, unknown> = DEPLOYMENT,
) => {
  let current = settings;
  const calls = stubApi({
    [`GET ${SETTINGS}`]: () => json(200, { settings: current, deployment }),
    [`PATCH ${SETTINGS}`]: (c) => {
      current = { ...current, ...(bodyOf(c) as object) };
      return json(200, { settings: current, deployment });
    },
  });
  return calls;
};

const save = async (locale: "zh" | "en" = "en") => {
  const o = msgs[locale].orgSettings;
  await userEvent
    .setup()
    .click(within(actionRow(locale) as HTMLElement).getByRole("button", { name: o.save }));
};

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
          json(200, {
            settings: { toolSearch: "on", sandboxToolPolicy: "allow" },
            deployment: DEPLOYMENT,
          }),
        [`PATCH ${SETTINGS}`]: (c) =>
          json(200, {
            settings: { toolSearch: "on", ...(bodyOf(c) as object) },
            deployment: DEPLOYMENT,
          }),
      });
      const { container } = await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), {
        locale,
      });
      const tools = await sectionOf(m.orgSettings.sandbox.title);
      await within(tools).findByRole("radio", { name: prefix(m.orgSettings.sandbox.allow) });
      const current = container.querySelector('.cb-settings-nav [aria-current="page"]');
      expect(current?.textContent).toBe(m.connections.nav.sandbox);
      expect(current?.getAttribute("href")).toBe("/settings/sandbox");
      // The general page's fields are not on this page
      expect(screen.queryByText(m.orgSettings.toolSearch.title)).toBeNull();
      const user = userEvent.setup();
      await user.click(
        within(tools).getByRole("radio", { name: prefix(m.orgSettings.sandbox.ask) }),
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
          json(200, {
            settings: { toolSearch: "on", locale: "en", sandboxToolPolicy: "allow" },
            deployment: DEPLOYMENT,
          }),
        [`PATCH ${SETTINGS}`]: (c) =>
          json(200, {
            settings: { toolSearch: "on", locale: "en", ...(bodyOf(c) as object) },
            deployment: DEPLOYMENT,
          }),
      });
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { locale });
      const tools = await sectionOf(o.sandbox.title);
      const allow = await within(tools).findByRole("radio", { name: prefix(o.sandbox.allow) });
      expect(allow).toHaveProperty("checked", true);
      const user = userEvent.setup();
      await user.click(within(tools).getByRole("radio", { name: prefix(o.sandbox.ask) }));
      const row = actionRow(locale);
      expect(row).not.toBeNull();
      await user.click(within(row as HTMLElement).getByRole("button", { name: o.save }));
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ sandboxToolPolicy: "ask" });
      await vi.waitFor(() => expect(actionRow(locale)).toBeNull());
      expect(within(tools).getByRole("radio", { name: prefix(o.sandbox.ask) })).toHaveProperty(
        "checked",
        true,
      );
    },
  );

  it("沙箱工具策略缺省（旧内核没有这个字段）按 allow 显示", async () => {
    stubApi({
      [`GET ${SETTINGS}`]: () =>
        json(200, { settings: { toolSearch: "on" }, deployment: DEPLOYMENT }),
    });
    await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
    const tools = await sectionOf(en.orgSettings.sandbox.title);
    const allow = await within(tools).findByRole("radio", {
      name: prefix(en.orgSettings.sandbox.allow),
    });
    expect(allow).toHaveProperty("checked", true);
    expect(actionRow("en")).toBeNull();
  });

  describe("自动模式 (auto mode spec §4.3)", () => {
    it.each(LOCALES)("an org admin narrows to off, then allows it again (%s)", async (locale) => {
      const o = msgs[locale].orgSettings;
      const calls = stub({ toolSearch: "on" }, DEPLOYMENT);
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { locale });
      const allowed = await screen.findByRole("radio", {
        name: prefix(o.autoMode.allowed),
      });
      expect(allowed).toHaveProperty("checked", true);
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: prefix(o.autoMode.off) }));
      await save(locale);
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ autoMode: "off" });
      await vi.waitFor(() => expect(actionRow(locale)).toBeNull());
      await user.click(screen.getByRole("radio", { name: prefix(o.autoMode.allowed) }));
      await save(locale);
      expect(bodyOf(calls.filter((c) => c.method === "PATCH")[1])).toEqual({
        autoMode: "allowed",
      });
    });

    it("the platform turned auto mode off: the control is disabled with 平台未开放", async () => {
      stub({ toolSearch: "on" }, { ...DEPLOYMENT, autoMode: { mode: "off", source: "db" } });
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { locale: "zh" });
      const o = zh.orgSettings.autoMode;
      const allowed = await screen.findByRole("radio", { name: prefix(o.allowed) });
      expect((allowed as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByRole("radio", { name: prefix(o.off) })).toHaveProperty("checked", true);
      expect(screen.getByText(o.platformClosed)).toBeTruthy();
      expect(actionRow("zh")).toBeNull();
    });

    it("saving auto mode invalidates the org's cached device lists and details", async () => {
      const o = en.orgSettings;
      stub({ toolSearch: "on" }, DEPLOYMENT);
      const { client } = await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
      client.setQueryData(keys.org("o1").devices(), { items: [] });
      client.setQueryData(keys.org("o1").device("d1"), { device: {} });
      await screen.findByRole("radio", { name: prefix(o.autoMode.allowed) });
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: prefix(o.autoMode.off) }));
      await save("en");
      await waitFor(() =>
        expect(client.getQueryState(keys.org("o1").devices())?.isInvalidated).toBe(true),
      );
      expect(client.getQueryState(keys.org("o1").device("d1"))?.isInvalidated).toBe(true);
    });

    it.each(LOCALES)("a member reads both sections without changing them (%s)", async (locale) => {
      const o = msgs[locale].orgSettings;
      stub({ toolSearch: "on" }, DEPLOYMENT);
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { locale, me: MEMBER });
      const allowed = await screen.findByRole("radio", {
        name: prefix(o.autoMode.allowed),
      });
      expect((allowed as HTMLInputElement).disabled).toBe(true);
      const open = screen.getByRole("radio", { name: prefix(o.cloudNetwork.open) });
      expect((open as HTMLInputElement).disabled).toBe(true);
      expect(screen.getAllByText(o.readonly).length).toBeGreaterThan(0);
      expect(actionRow(locale)).toBeNull();
    });
  });

  describe("云设备网络 (auto mode spec §4.3)", () => {
    it.each(LOCALES)(
      "open by default; allowlist starts from the platform's hosts, and back to open (%s)",
      async (locale) => {
        const o = msgs[locale].orgSettings;
        const calls = stub({ toolSearch: "on" }, DEPLOYMENT);
        await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { locale });
        const open = await screen.findByRole("radio", {
          name: prefix(o.cloudNetwork.open),
        });
        expect(open).toHaveProperty("checked", true);
        expect(screen.getByText(o.cloudNetwork.publicOnly)).toBeTruthy();
        const user = userEvent.setup();
        await user.click(screen.getByRole("radio", { name: prefix(o.cloudNetwork.allowlist) }));
        const hosts = screen.getByRole("textbox", {
          name: o.cloudNetwork.hosts,
        }) as HTMLTextAreaElement;
        expect(hosts.value).toBe("registry.npmjs.org\npypi.org");
        await save(locale);
        expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
          cloudNetwork: {
            mode: "allowlist",
            allowHosts: ["registry.npmjs.org", "pypi.org"],
          },
        });
        await vi.waitFor(() => expect(actionRow(locale)).toBeNull());
        await user.click(screen.getByRole("radio", { name: prefix(o.cloudNetwork.open) }));
        await save(locale);
        expect(bodyOf(calls.filter((c) => c.method === "PATCH")[1])).toEqual({
          cloudNetwork: { mode: "open" },
        });
      },
    );

    it("a host that is not a valid allowlist name blocks the save", async () => {
      const o = en.orgSettings;
      stub(
        { toolSearch: "on", cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com"] } },
        DEPLOYMENT,
      );
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
      const hosts = (await screen.findByRole("textbox", {
        name: o.cloudNetwork.hosts,
      })) as HTMLTextAreaElement;
      const user = userEvent.setup();
      await user.clear(hosts);
      await user.type(hosts, "Bad_Host");
      expect(
        screen.getByText(o.cloudNetwork.invalidHost.replace("{host}", "bad_host")),
      ).toBeTruthy();
      const row = actionRow("en") as HTMLElement;
      expect(within(row).getByRole("button", { name: o.save })).toHaveProperty("disabled", true);
      await user.clear(hosts);
      await user.type(hosts, "good.example.org");
      expect(
        screen.queryByText(o.cloudNetwork.invalidHost.replace("{host}", "bad_host")),
      ).toBeNull();
      expect(within(row).getByRole("button", { name: o.save })).toHaveProperty("disabled", false);
    });

    it("a stale invalid allowlist draft does not block an unrelated save in open mode", async () => {
      const o = en.orgSettings;
      const calls = stub(
        { toolSearch: "on", cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com"] } },
        DEPLOYMENT,
      );
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
      const hosts = (await screen.findByRole("textbox", {
        name: o.cloudNetwork.hosts,
      })) as HTMLTextAreaElement;
      const user = userEvent.setup();
      await user.clear(hosts);
      await user.type(hosts, "Bad_Host");
      expect(
        within(actionRow("en") as HTMLElement).getByRole("button", { name: o.save }),
      ).toHaveProperty("disabled", true);
      // Open the network: the allowlist is not sent, so its stale text must not block the save
      await user.click(screen.getByRole("radio", { name: prefix(o.cloudNetwork.open) }));
      // An unrelated change is now saveable and goes through without the invalid hosts
      await user.click(screen.getByRole("radio", { name: prefix(o.autoMode.off) }));
      const row = actionRow("en") as HTMLElement;
      expect(within(row).getByRole("button", { name: o.save })).toHaveProperty("disabled", false);
      await user.click(within(row).getByRole("button", { name: o.save }));
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
        autoMode: "off",
        cloudNetwork: { mode: "open" },
      });
    });

    it("switching back to allowlist keeps the invalid text, so the error and disabled save return", async () => {
      const o = en.orgSettings;
      stub(
        { toolSearch: "on", cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com"] } },
        DEPLOYMENT,
      );
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
      const hosts = (await screen.findByRole("textbox", {
        name: o.cloudNetwork.hosts,
      })) as HTMLTextAreaElement;
      const user = userEvent.setup();
      await user.clear(hosts);
      await user.type(hosts, "Bad_Host");
      await user.click(screen.getByRole("radio", { name: prefix(o.cloudNetwork.open) }));
      expect(
        screen.queryByText(o.cloudNetwork.invalidHost.replace("{host}", "bad_host")),
      ).toBeNull();
      await user.click(screen.getByRole("radio", { name: prefix(o.cloudNetwork.allowlist) }));
      expect(
        (screen.getByRole("textbox", { name: o.cloudNetwork.hosts }) as HTMLTextAreaElement).value,
      ).toBe("Bad_Host");
      expect(
        screen.getByText(o.cloudNetwork.invalidHost.replace("{host}", "bad_host")),
      ).toBeTruthy();
      expect(
        within(actionRow("en") as HTMLElement).getByRole("button", { name: o.save }),
      ).toHaveProperty("disabled", true);
    });

    it("the platform's kill switch closes the network: both choices disabled with the reason", async () => {
      stub(
        { toolSearch: "on" },
        { ...DEPLOYMENT, cloudNetwork: { mode: "allowlist", allowHosts: [] } },
      );
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { locale: "zh" });
      const o = zh.orgSettings.cloudNetwork;
      const open = await screen.findByRole("radio", { name: prefix(o.open) });
      expect((open as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByText(o.platformClosed)).toBeTruthy();
      const hosts = screen.getByRole("textbox", { name: o.hosts }) as HTMLTextAreaElement;
      expect(hosts.disabled).toBe(true);
      expect(actionRow("zh")).toBeNull();
    });
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
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { locale });
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
          deployment: DEPLOYMENT,
          sandboxLimits: { cpu: 1, memoryMb: 2048, source: "deployment" },
        }),
    });
    await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
    expect(await screen.findByText(o.source.deployment)).toBeTruthy();
    cleanup();
    stubApi({
      [`GET ${SETTINGS}`]: () =>
        json(200, { settings: { toolSearch: "on" }, deployment: DEPLOYMENT }),
    });
    await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
    await within(await sectionOf(en.orgSettings.sandbox.title)).findByRole("radio", {
      name: prefix(en.orgSettings.sandbox.allow),
    });
    expect(screen.queryByText(o.title)).toBeNull();
  });

  describe("?allowHost= (network ask spec §5.3)", () => {
    const DEPLOYMENT_ALLOW = {
      ...DEPLOYMENT,
      cloudNetwork: { mode: "open", allowHosts: ["registry.npmjs.org"] },
    };

    it("prefills an allowlist with the host appended; saving sends it", async () => {
      const o = en.orgSettings;
      const calls = stubApi({
        [`GET ${SETTINGS}`]: () =>
          json(200, { settings: { toolSearch: "on" }, deployment: DEPLOYMENT_ALLOW }),
        [`PATCH ${SETTINGS}`]: (c) =>
          json(200, {
            settings: { toolSearch: "on", ...(bodyOf(c) as object) },
            deployment: DEPLOYMENT_ALLOW,
          }),
      });
      await renderRouteWithCache(
        "/settings/sandbox?allowHost=Files.Slack.com,bad_host",
        lastStubRoutes(),
      );
      const custom = await screen.findByRole("radio", {
        name: prefix(o.cloudNetwork.allowlist),
      });
      await vi.waitFor(() => expect(custom).toHaveProperty("checked", true));
      const hosts = screen.getByRole("textbox", {
        name: o.cloudNetwork.hosts,
      }) as HTMLTextAreaElement;
      expect(hosts.value).toBe("registry.npmjs.org\nfiles.slack.com");
      expect(
        screen.getByText(o.cloudNetwork.prefilled.replace("{hosts}", "files.slack.com")),
      ).toBeTruthy();
      await save("en");
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
        cloudNetwork: {
          mode: "allowlist",
          allowHosts: ["registry.npmjs.org", "files.slack.com"],
        },
      });
    });

    it("a host already allowed changes nothing", async () => {
      stubApi({
        [`GET ${SETTINGS}`]: () =>
          json(200, { settings: { toolSearch: "on" }, deployment: DEPLOYMENT_ALLOW }),
      });
      await renderRouteWithCache(
        "/settings/sandbox?allowHost=registry.npmjs.org",
        lastStubRoutes(),
      );
      const open = await screen.findByRole("radio", {
        name: prefix(en.orgSettings.cloudNetwork.open),
      });
      expect(open).toHaveProperty("checked", true);
      expect(actionRow("en")).toBeNull();
    });

    it("a member's page is not prefilled", async () => {
      stubApi({
        [`GET ${SETTINGS}`]: () =>
          json(200, { settings: { toolSearch: "on" }, deployment: DEPLOYMENT_ALLOW }),
      });
      await renderRouteWithCache("/settings/sandbox?allowHost=files.slack.com", lastStubRoutes(), {
        me: MEMBER,
      });
      const open = await screen.findByRole("radio", {
        name: prefix(en.orgSettings.cloudNetwork.open),
      });
      expect(open).toHaveProperty("checked", true);
      expect(actionRow("en")).toBeNull();
    });
  });
});
