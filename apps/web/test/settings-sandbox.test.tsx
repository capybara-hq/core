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
 * The deployment defaults the kernel sends beside the org's settings (auto mode spec §4.3, egress
 * ceiling spec §D4): the platform's auto-mode switch and its network (allowlist, ceiling, kill
 * switch).
 */
const DEPLOYMENT = {
  autoMode: { mode: "allowed", source: "default" },
  cloudNetwork: {
    allowHosts: ["registry.npmjs.org", "pypi.org"],
    orgHosts: "extend",
    off: false,
  },
};

type Deployment = {
  autoMode?: unknown;
  cloudNetwork: { allowHosts: string[]; orgHosts: string; off: boolean };
};
type StoredNetwork = {
  mode?: string;
  base?: string;
  extraHosts?: string[];
  excludedHosts?: string[];
};

/**
 * The kernel's `effectiveNetwork` for these tests (spec §D1, §D3): the kill switch empties it,
 * `within` forces the allowlist and drops extras (exact matches stand in for the kernel's matcher).
 */
const effectiveNetwork = (settings: Record<string, unknown>, deployment: Deployment) => {
  const p = deployment.cloudNetwork;
  if (p.off) return { mode: "allowlist", hosts: [] };
  const cn = (settings.cloudNetwork ?? {}) as StoredNetwork;
  const within = p.orgHosts === "within";
  const extra = (cn.extraHosts ?? []).filter((h) => !within || p.allowHosts.includes(h));
  const excluded = cn.excludedHosts ?? [];
  const hosts =
    cn.base === "none"
      ? extra
      : [...new Set([...p.allowHosts.filter((h) => !excluded.includes(h)), ...extra])];
  return { mode: within ? "allowlist" : (cn.mode ?? "open"), hosts };
};

/** The effective network with no org setting under {@link DEPLOYMENT}. */
const OPEN_NETWORK = { mode: "open", hosts: ["registry.npmjs.org", "pypi.org"] };

/** The settings answer: the settings, the deployment defaults and the effective network. */
const answer = (settings: Record<string, unknown>, deployment: Deployment = DEPLOYMENT) => ({
  settings,
  deployment,
  effectiveNetwork: effectiveNetwork(settings, deployment),
});

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
const stub = (settings: Record<string, unknown>, deployment: Deployment = DEPLOYMENT) => {
  let current = settings;
  const calls = stubApi({
    [`GET ${SETTINGS}`]: () => json(200, answer(current, deployment)),
    [`PATCH ${SETTINGS}`]: (c) => {
      const next: Record<string, unknown> = { ...current, ...(bodyOf(c) as object) };
      // null follows the platform: the field is cleared
      for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
      current = next;
      return json(200, answer(current, deployment));
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
            effectiveNetwork: OPEN_NETWORK,
          }),
        [`PATCH ${SETTINGS}`]: (c) =>
          json(200, {
            settings: { toolSearch: "on", ...(bodyOf(c) as object) },
            deployment: DEPLOYMENT,
            effectiveNetwork: OPEN_NETWORK,
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
            effectiveNetwork: OPEN_NETWORK,
          }),
        [`PATCH ${SETTINGS}`]: (c) =>
          json(200, {
            settings: { toolSearch: "on", locale: "en", ...(bodyOf(c) as object) },
            deployment: DEPLOYMENT,
            effectiveNetwork: OPEN_NETWORK,
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
      [`GET ${SETTINGS}`]: () => json(200, answer({ toolSearch: "on" })),
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

  describe("云设备网络 (egress ceiling spec §D4)", () => {
    const hostsBox = (label: string) =>
      screen.getByRole("textbox", { name: label }) as HTMLTextAreaElement;
    const setHosts = async (label: string, text: string) => {
      const user = userEvent.setup();
      const box = hostsBox(label);
      await user.clear(box);
      await user.type(box, text);
    };

    it.each(LOCALES)(
      "the host editor shows in both modes from the effective hosts; a mode change sends only the mode (%s)",
      async (locale) => {
        const o = msgs[locale].orgSettings;
        const calls = stub({ toolSearch: "on" });
        await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { locale });
        const open = await screen.findByRole("radio", { name: prefix(o.cloudNetwork.open) });
        expect(open).toHaveProperty("checked", true);
        expect(screen.getByText(o.cloudNetwork.publicOnly)).toBeTruthy();
        // open mode: the editor is there (the local sandbox ceiling), from the effective hosts
        expect(hostsBox(o.cloudNetwork.hosts).value).toBe("registry.npmjs.org\npypi.org");
        expect(screen.getByText(o.cloudNetwork.hostsHelp)).toBeTruthy();
        const user = userEvent.setup();
        await user.click(screen.getByRole("radio", { name: prefix(o.cloudNetwork.allowlist) }));
        expect(hostsBox(o.cloudNetwork.hosts).value).toBe("registry.npmjs.org\npypi.org");
        await save(locale);
        // the stored value (absent) with the mode changed: no host lists
        expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
          cloudNetwork: { mode: "allowlist" },
        });
        await vi.waitFor(() => expect(actionRow(locale)).toBeNull());
        await user.click(screen.getByRole("radio", { name: prefix(o.cloudNetwork.open) }));
        await save(locale);
        expect(bodyOf(calls.filter((c) => c.method === "PATCH")[1])).toEqual({
          cloudNetwork: { mode: "open" },
        });
      },
    );

    it("base platform: the edited list becomes extras and exclusions; a stale exclusion is kept; an absent mode stays absent", async () => {
      const o = en.orgSettings;
      const calls = stub({
        toolSearch: "on",
        cloudNetwork: { extraHosts: ["a.example.com"], excludedHosts: ["gone.example.com"] },
      });
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
      await screen.findByRole("radio", { name: prefix(o.cloudNetwork.open) });
      expect(hostsBox(o.cloudNetwork.hosts).value).toBe(
        "registry.npmjs.org\npypi.org\na.example.com",
      );
      await setHosts(o.cloudNetwork.hosts, "registry.npmjs.org\nb.example.com");
      await save("en");
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
        cloudNetwork: {
          extraHosts: ["b.example.com"],
          excludedHosts: ["pypi.org", "gone.example.com"],
        },
      });
    });

    it("a stored mode is sent back as it is when only the hosts change; empty lists are left out", async () => {
      const o = en.orgSettings;
      const calls = stub({
        toolSearch: "on",
        cloudNetwork: { mode: "open", base: "platform", extraHosts: ["a.example.com"] },
      });
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
      await screen.findByRole("radio", { name: prefix(o.cloudNetwork.open) });
      await setHosts(o.cloudNetwork.hosts, "registry.npmjs.org\npypi.org");
      await save("en");
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
        cloudNetwork: { mode: "open", base: "platform" },
      });
    });

    it("base none keeps none: the edited list is the extras", async () => {
      const o = en.orgSettings;
      const calls = stub({
        toolSearch: "on",
        cloudNetwork: { mode: "allowlist", base: "none", extraHosts: ["a.example.com"] },
      });
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
      const allowlist = await screen.findByRole("radio", {
        name: prefix(o.cloudNetwork.allowlist),
      });
      expect(allowlist).toHaveProperty("checked", true);
      expect(hostsBox(o.cloudNetwork.hosts).value).toBe("a.example.com");
      await setHosts(o.cloudNetwork.hosts, "a.example.com\npypi.org");
      await save("en");
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
        cloudNetwork: {
          mode: "allowlist",
          base: "none",
          extraHosts: ["a.example.com", "pypi.org"],
        },
      });
    });

    it("a host that is not a valid allowlist name blocks the save, in open mode too", async () => {
      const o = en.orgSettings;
      stub({ toolSearch: "on" });
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
      const open = await screen.findByRole("radio", { name: prefix(o.cloudNetwork.open) });
      expect(open).toHaveProperty("checked", true);
      await setHosts(o.cloudNetwork.hosts, "Bad_Host");
      expect(
        screen.getByText(o.cloudNetwork.invalidHost.replace("{host}", "bad_host")),
      ).toBeTruthy();
      const row = actionRow("en") as HTMLElement;
      expect(within(row).getByRole("button", { name: o.save })).toHaveProperty("disabled", true);
      await setHosts(o.cloudNetwork.hosts, "good.example.org");
      expect(
        screen.queryByText(o.cloudNetwork.invalidHost.replace("{host}", "bad_host")),
      ).toBeNull();
      expect(within(row).getByRole("button", { name: o.save })).toHaveProperty("disabled", false);
    });

    it("the platform's kill switch: both choices and the editor read-only, and no save sends the network", async () => {
      const calls = stub(
        { toolSearch: "on", cloudNetwork: { mode: "open", extraHosts: ["a.example.com"] } },
        { ...DEPLOYMENT, cloudNetwork: { ...DEPLOYMENT.cloudNetwork, off: true } },
      );
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { locale: "zh" });
      const o = zh.orgSettings;
      const open = await screen.findByRole("radio", { name: prefix(o.cloudNetwork.open) });
      expect((open as HTMLInputElement).disabled).toBe(true);
      expect(
        (screen.getByRole("radio", { name: prefix(o.cloudNetwork.allowlist) }) as HTMLInputElement)
          .checked,
      ).toBe(true);
      expect(screen.getByText(o.cloudNetwork.platformClosed)).toBeTruthy();
      expect(hostsBox(o.cloudNetwork.hosts).disabled).toBe(true);
      expect(actionRow("zh")).toBeNull();
      await userEvent.setup().click(screen.getByRole("radio", { name: prefix(o.autoMode.off) }));
      await save("zh");
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ autoMode: "off" });
    });

    it.each(LOCALES)(
      "the platform ceiling (within): open is disabled with the reason; the stored mode is sent back (%s)",
      async (locale) => {
        const o = msgs[locale].orgSettings;
        const calls = stub(
          { toolSearch: "on", cloudNetwork: { mode: "open", extraHosts: ["x.example.com"] } },
          { ...DEPLOYMENT, cloudNetwork: { ...DEPLOYMENT.cloudNetwork, orgHosts: "within" } },
        );
        await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { locale });
        const open = await screen.findByRole("radio", { name: prefix(o.cloudNetwork.open) });
        expect((open as HTMLInputElement).disabled).toBe(true);
        expect(
          (
            screen.getByRole("radio", {
              name: prefix(o.cloudNetwork.allowlist),
            }) as HTMLInputElement
          ).checked,
        ).toBe(true);
        expect(screen.getByText(o.cloudNetwork.withinClosed)).toBeTruthy();
        // the stored extra outside the ceiling had no effect: the editor shows only effective hosts
        expect(hostsBox(o.cloudNetwork.hosts).value).toBe("registry.npmjs.org\npypi.org");
        await setHosts(o.cloudNetwork.hosts, "registry.npmjs.org");
        await save(locale);
        expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
          cloudNetwork: { mode: "open", excludedHosts: ["pypi.org"] },
        });
      },
    );

    it.each([
      [
        "names the hosts in its details",
        [{ reason: "outside_ceiling", hosts: ["evil.example.com"] }],
        en.orgSettings.cloudNetwork.outsideCeiling.replace("{hosts}", "evil.example.com"),
      ],
      [
        "gives only the reason",
        [{ reason: "outside_ceiling" }],
        en.errors.org.sandbox_egress_not_allowed.outside_ceiling,
      ],
      ["has no details", [], en.errors.org.sandbox_egress_not_allowed.default],
    ])("a host outside the ceiling: the kernel's refusal %s", async (_, details, shown) => {
      const o = en.orgSettings;
      stubApi({
        [`GET ${SETTINGS}`]: () =>
          json(200, {
            settings: { toolSearch: "on" },
            deployment: {
              ...DEPLOYMENT,
              cloudNetwork: { ...DEPLOYMENT.cloudNetwork, orgHosts: "within" },
            },
            effectiveNetwork: { mode: "allowlist", hosts: ["registry.npmjs.org", "pypi.org"] },
          }),
        [`PATCH ${SETTINGS}`]: () =>
          json(400, {
            error: {
              code: "org.sandbox_egress_not_allowed",
              message: "outside the platform allowlist",
              details,
            },
          }),
      });
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
      await screen.findByRole("radio", { name: prefix(o.cloudNetwork.open) });
      await setHosts(o.cloudNetwork.hosts, "registry.npmjs.org\nevil.example.com");
      await save("en");
      expect(await screen.findByText(shown)).toBeTruthy();
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
            effectiveNetwork: OPEN_NETWORK,
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
          effectiveNetwork: OPEN_NETWORK,
          sandboxLimits: { cpu: 1, memoryMb: 2048, source: "deployment" },
        }),
    });
    await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
    expect(await screen.findByText(o.source.deployment)).toBeTruthy();
    cleanup();
    stubApi({
      [`GET ${SETTINGS}`]: () => json(200, answer({ toolSearch: "on" })),
    });
    await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
    await within(await sectionOf(en.orgSettings.sandbox.title)).findByRole("radio", {
      name: prefix(en.orgSettings.sandbox.allow),
    });
    expect(screen.queryByText(o.title)).toBeNull();
  });

  describe("follow the platform (egress ceiling spec §D4, §D5)", () => {
    it.each(LOCALES)(
      "an org with its own network goes back to the platform's list after a confirmation (%s)",
      async (locale) => {
        const o = msgs[locale].orgSettings.cloudNetwork;
        const calls = stub({
          toolSearch: "on",
          cloudNetwork: { mode: "allowlist", base: "none", extraHosts: ["a.example.com"] },
        });
        await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { locale });
        const section = await sectionOf(o.title);
        expect(within(section).getByText(o.ownNetwork)).toBeTruthy();
        const user = userEvent.setup();
        await user.click(within(section).getByRole("button", { name: o.followPlatform }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText(o.followPlatformBody)).toBeTruthy();
        expect(calls.some((c) => c.method === "PATCH")).toBe(false);
        await user.click(within(dialog).getByRole("button", { name: o.followPlatform }));
        await vi.waitFor(() =>
          expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ cloudNetwork: null }),
        );
        expect(await screen.findByText(o.followPlatformDone)).toBeTruthy();
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        // now following: the action is gone and the editor shows the platform's list
        await vi.waitFor(() =>
          expect(within(section).queryByRole("button", { name: o.followPlatform })).toBeNull(),
        );
        expect(
          (within(section).getByRole("textbox", { name: o.hosts }) as HTMLTextAreaElement).value,
        ).toBe("registry.npmjs.org\npypi.org");
      },
    );

    it("hidden while the org follows the platform", async () => {
      stub({ toolSearch: "on" });
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
      const section = await sectionOf(en.orgSettings.cloudNetwork.title);
      await within(section).findByRole("textbox", { name: en.orgSettings.cloudNetwork.hosts });
      expect(
        within(section).queryByRole("button", { name: en.orgSettings.cloudNetwork.followPlatform }),
      ).toBeNull();
    });

    it("hidden under the kill switch", async () => {
      stub(
        { toolSearch: "on", cloudNetwork: { extraHosts: ["a.example.com"] } },
        { ...DEPLOYMENT, cloudNetwork: { ...DEPLOYMENT.cloudNetwork, off: true } },
      );
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes());
      const section = await sectionOf(en.orgSettings.cloudNetwork.title);
      await within(section).findByRole("textbox", { name: en.orgSettings.cloudNetwork.hosts });
      expect(
        within(section).queryByRole("button", { name: en.orgSettings.cloudNetwork.followPlatform }),
      ).toBeNull();
    });

    it("hidden from a member", async () => {
      stub({ toolSearch: "on", cloudNetwork: { extraHosts: ["a.example.com"] } });
      await renderRouteWithCache("/settings/sandbox", lastStubRoutes(), { me: MEMBER });
      const section = await sectionOf(en.orgSettings.cloudNetwork.title);
      await within(section).findByRole("textbox", { name: en.orgSettings.cloudNetwork.hosts });
      expect(
        within(section).queryByRole("button", { name: en.orgSettings.cloudNetwork.followPlatform }),
      ).toBeNull();
    });
  });

  describe("?allowHost= (network ask spec §5.3)", () => {
    const DEPLOYMENT_ALLOW = {
      ...DEPLOYMENT,
      cloudNetwork: { ...DEPLOYMENT.cloudNetwork, allowHosts: ["registry.npmjs.org"] },
    };

    it("appends the host to the editor without changing the mode; saving sends it as an extra", async () => {
      const o = en.orgSettings;
      const calls = stub({ toolSearch: "on" }, DEPLOYMENT_ALLOW);
      await renderRouteWithCache(
        "/settings/sandbox?allowHost=Files.Slack.com,bad_host",
        lastStubRoutes(),
      );
      const open = await screen.findByRole("radio", { name: prefix(o.cloudNetwork.open) });
      const hosts = screen.getByRole("textbox", {
        name: o.cloudNetwork.hosts,
      }) as HTMLTextAreaElement;
      await vi.waitFor(() => expect(hosts.value).toBe("registry.npmjs.org\nfiles.slack.com"));
      expect(open).toHaveProperty("checked", true);
      expect(
        screen.getByText(o.cloudNetwork.prefilled.replace("{hosts}", "files.slack.com")),
      ).toBeTruthy();
      await save("en");
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
        cloudNetwork: { extraHosts: ["files.slack.com"] },
      });
    });

    it("a host already allowed changes nothing", async () => {
      stub({ toolSearch: "on" }, DEPLOYMENT_ALLOW);
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
      stub({ toolSearch: "on" }, DEPLOYMENT_ALLOW);
      await renderRouteWithCache("/settings/sandbox?allowHost=files.slack.com", lastStubRoutes(), {
        me: MEMBER,
      });
      const open = await screen.findByRole("radio", {
        name: prefix(en.orgSettings.cloudNetwork.open),
      });
      expect(open).toHaveProperty("checked", true);
      expect(actionRow("en")).toBeNull();
    });

    it("under the kill switch nothing is prefilled", async () => {
      stub(
        { toolSearch: "on" },
        { ...DEPLOYMENT_ALLOW, cloudNetwork: { ...DEPLOYMENT_ALLOW.cloudNetwork, off: true } },
      );
      await renderRouteWithCache("/settings/sandbox?allowHost=files.slack.com", lastStubRoutes());
      const hosts = (await screen.findByRole("textbox", {
        name: en.orgSettings.cloudNetwork.hosts,
      })) as HTMLTextAreaElement;
      expect(hosts.value).toBe("");
      expect(actionRow("en")).toBeNull();
    });
  });
});
