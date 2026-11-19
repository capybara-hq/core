import { findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { SANDBOX_COMMANDS } from "../src/components/DeviceModeSection";
import { RESET_POLL_DEADLINE_MS, RESET_POLL_MS, resetPollInterval } from "../src/lib/devices";
import { keys } from "../src/lib/query/keys";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { expectNoFirstPaintFetch } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const BASE = "/api/v1/orgs/o1/devices";
/** The device page also reads the device's projects (project root §4.1): none here. */
const NO_PROJECTS = {
  [`GET ${BASE}/e1/projects`]: () =>
    json(200, { projects: [], hidden: 0, mode: "auto", base: "/workspace", supported: true }),
};
const T = "2026-11-07T08:00:00.000Z";
const E = en.devices;
const S = E.sandbox;
/** The KeyValue row whose key is `key` (the page's facts or the machine block). */
const factRow = (key: string) =>
  [...document.querySelectorAll('[data-part="key-value-row"]')].find(
    (r) => r.querySelector("dt")?.textContent === key,
  ) as HTMLElement | undefined;

const LIMITS = {
  cpu: 2,
  memoryMb: 2048,
  diskMb: 10240,
  network: { kind: "open-public", hosts: [] },
};
const MACHINE = {
  id: "m1",
  name: "grant-mbp",
  os: "darwin",
  mode: "os",
  programVersion: "0.4.0",
  lastSeenAt: T,
};

/** A local machine's authenticated owner report: outside allowed, the open network, the OS user's reach. */
const report = (over: Record<string, unknown> = {}) => ({
  state: "report",
  revision: "r1",
  sequence: 3,
  outsideSandbox: true,
  network: "open",
  allowedDomains: [],
  restrictedProjectReach: "os-user",
  observedAt: T,
  stale: false,
  ...over,
});
/** The kernel's effective sandbox view (`DeviceSandboxView`): a local machine's open report. */
const sandbox = (over: Record<string, unknown> = {}) => ({
  network: "open",
  networkCeiling: "open",
  hosts: [],
  ownNetwork: "open",
  allowedDomains: [],
  outsideSandbox: true,
  restrictedProjectReach: "os-user",
  layer: { network: null, outsideSandbox: null },
  pendingNextUse: false,
  pendingFilesReset: false,
  recent: [],
  ...over,
});
/** A cloud device's sandbox: following its org's open network, never outside its instance. */
const cloudSandbox = (over: Record<string, unknown> = {}) =>
  sandbox({
    ownNetwork: null,
    outsideSandbox: false,
    restrictedProjectReach: "workspace",
    layer: { network: null, outsideSandbox: "provider" },
    ...over,
  });

const cloud = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  name: "Build box",
  isDefault: true,
  demotedFrom: null,
  ownerKind: "personal",
  source: "cloud",
  provider: "sandbox-docker",
  available: true,
  online: null,
  machine: null,
  network: null,
  sessionIsolation: false,
  filesLost: false,
  instance: null,
  limits: LIMITS,
  ownerCeiling: null,
  sandbox: cloudSandbox(),
  reconcileRequired: false,
  createdAt: T,
  ...over,
});
const local = (over: Record<string, unknown> = {}, sandboxOver: Record<string, unknown> = {}) => ({
  id: "e1",
  name: "Laptop",
  isDefault: true,
  demotedFrom: null,
  ownerKind: "personal",
  source: "local",
  provider: "@local",
  available: true,
  online: true,
  machine: MACHINE,
  network: {
    features: ["networkReport", "policyOp", "policyOpId"],
    policy: { mode: "auto", allowedDomains: [] },
  },
  sessionIsolation: false,
  filesLost: false,
  instance: null,
  limits: { ...LIMITS, network: { kind: "allowlist", hosts: [] } },
  ownerCeiling: report(),
  sandbox: sandbox(sandboxOver),
  reconcileRequired: false,
  createdAt: T,
  ...over,
});
const list = (items: unknown[]) => ({
  items,
  defaultId: "e1",
  lastUsedId: null,
  cloudAvailable: true,
});

const detail = (device: unknown) => ({
  ...NO_PROJECTS,
  [`GET ${BASE}/e1`]: () => json(200, { device }),
});
const renderDetail = (opts: Parameters<typeof renderRouteWithCache>[2] = {}) =>
  renderRouteWithCache("/devices/e1", lastStubRoutes(), opts);
const renderList = (opts: Parameters<typeof renderRouteWithCache>[2] = {}) =>
  renderRouteWithCache("/devices", lastStubRoutes(), opts);
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
/** The device page's 设置 tab: every control lives there (values are on 概览). */
const openSettings = async () => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: E.detail.tabSettings }));
  return user;
};
/** The sandbox section (Settings) or block (Overview). */
const sandboxSection = () =>
  screen.findByRole("heading", { name: S.title }).then((h) => {
    const section = h.closest("section") ?? h.parentElement?.parentElement;
    return section as HTMLElement;
  });
const radio = (group: string, name: string) =>
  within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  }) as HTMLInputElement;
const failWith = (status: number, code: string) => () =>
  json(status, { error: { code, message: `kernel says ${code}` } });
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

beforeEach(() => resetNavigation("/devices/e1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the device nameplate head", () => {
  it("is the page's head: name, origin, status, version, last seen and the sandbox mark", async () => {
    stubApi(detail(local()));
    const { container } = await renderDetail();
    const plate = container.querySelector('[data-part="device-nameplate"]') as HTMLElement;
    expect(plate).not.toBeNull();
    expect(plate.textContent).toContain("Laptop");
    expect(plate.textContent).toContain(E.source.local);
    expect(plate.textContent).toContain(E.state.online);
    expect(plate.textContent).toContain("v0.4.0");
    expect(plate.textContent).toContain("2026");
    // the neutral sandbox mark, never a daily mode or Full access
    expect(plate.textContent).toContain(S.mark.outside);
    expect(plate.textContent).not.toMatch(/Auto|Full access/);
    expect(plate.textContent).toContain("Created");
  });

  it("a cloud device is sandbox only, with no version and never connected", async () => {
    stubApi(detail(cloud()));
    const { container } = await renderDetail();
    const plate = container.querySelector('[data-part="device-nameplate"]') as HTMLElement;
    expect(plate.textContent).toContain("—");
    expect(plate.textContent).toContain("Never connected");
    expect(plate.textContent).toContain(S.mark.sandbox);
    expect(plate.querySelector(".cb-badge")?.getAttribute("data-tone")).toBe("default");
  });
});

describe("a local device's sandbox", () => {
  it("概览 shows it read only: network, outside the sandbox, project reach, report time", async () => {
    const calls = stubApi(detail(local()));
    await renderDetail();
    const section = await sandboxSection();
    expect(factRow(S.network)?.textContent).toContain(S.networkValue.open);
    expect(factRow(S.outside)?.textContent).toContain(S.outsideValue.allowed);
    expect(factRow(S.reach)?.textContent).toContain(S.reachValue["os-user"]);
    expect(factRow(S.reported)).toBeTruthy();
    expect(within(section).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    await settle();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("设置 is one 沙箱 section with the network and outside-sandbox groups, no box in a box", async () => {
    stubApi(detail(local()));
    const { container } = await renderDetail({ locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "设置" }));
    const section = await screen.findByRole("heading", { name: "沙箱" });
    expect(section).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "网络" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "在沙箱外运行" })).toBeTruthy();
    expect(screen.getByText("开放互联网（内网除外）")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "项目范围" })).toBeTruthy();
    expect(findNestedBoxes(container)).toEqual([]);
    expect(document.body.textContent).not.toMatch(/完全访问|企业/);
  });

  it("shows the machine's widening commands as keycaps and never offers to widen", async () => {
    stubApi(detail(local()));
    await renderDetail();
    await openSettings();
    await sandboxSection();
    const caps = [...document.querySelectorAll('[data-part="keycap-command-caps"]')].map((c) =>
      [...c.querySelectorAll('[data-part="keycap-command-cap"]')]
        .map((x) => x.textContent)
        .join(" "),
    );
    expect(caps).toEqual(
      expect.arrayContaining([
        "capybara-device ceiling set --network open",
        "capybara-device ceiling set --outside-sandbox on",
        "capybara-device policy add allowedDomains <host>",
      ]),
    );
    expect(Object.values(SANDBOX_COMMANDS)).toContain("capybara-device ceiling set --network open");
    // no add-host control: the local host editor only removes
    expect(screen.queryByRole("button", { name: /^add (a )?(host|domain)/i })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("narrows the network, outside the sandbox and the reach through the policy op only", async () => {
    const calls = stubApi({
      ...detail(local()),
      [`POST ${BASE}/e1/policy`]: () =>
        json(200, { policy: { mode: "sandbox", allowedDomains: [] } }),
    });
    await renderDetail();
    const user = await openSettings();
    await sandboxSection();
    await user.click(radio(S.network, S.networkValue.allowlist));
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(bodyOf(posts(calls)[0])).toEqual({ ownerCeiling: { network: "allowlist" } });
    await user.click(radio(S.outside, S.outsideValue.off));
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(bodyOf(posts(calls)[1])).toEqual({ ownerCeiling: { outsideSandbox: false } });
    await user.click(screen.getByRole("button", { name: S.limitReach }));
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(3));
    expect(bodyOf(posts(calls)[2])).toEqual({
      ownerCeiling: { restrictedProjectReach: "workspace" },
    });
    for (const c of calls.filter((x) => x.method !== "GET")) {
      expect(String(c.body)).not.toMatch(/true|os-user|"open"|"add"/);
    }
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("a narrowed machine names who widens: the owner on the computer", async () => {
    stubApi(
      detail(
        local({
          ownerCeiling: report({ outsideSandbox: false, network: "allowlist" }),
          sandbox: sandbox({
            network: "allowlist",
            outsideSandbox: false,
            layer: { network: "device", outsideSandbox: "device" },
          }),
        }),
      ),
    );
    await renderDetail();
    await openSettings();
    await sandboxSection();
    expect(radio(S.network, S.networkValue.open).disabled).toBe(true);
    expect(radio(S.outside, S.outsideValue.allowed).disabled).toBe(true);
    expect(screen.getByText(S.limited.network.device)).toBeTruthy();
    expect(screen.getByText(S.limited.outside.device)).toBeTruthy();
  });

  it("a disabled option names its layer: 平台 / 超级管理员", async () => {
    stubApi(
      detail(
        local({
          sandbox: sandbox({
            network: "allowlist",
            outsideSandbox: false,
            layer: { network: "platform", outsideSandbox: "org" },
          }),
        }),
      ),
    );
    await renderDetail({ locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "设置" }));
    expect(await screen.findByText("平台已限定为白名单（超级管理员设置）")).toBeTruthy();
    expect(screen.getByText(zh.devices.sandbox.limited.outside.org)).toBeTruthy();
  });

  it("removes a host from the machine's allowlist, and adds none", async () => {
    const calls = stubApi({
      ...detail(local({ ownerCeiling: report({ allowedDomains: ["files.example.com"] }) })),
      [`POST ${BASE}/e1/policy`]: () =>
        json(200, { policy: { mode: "sandbox", allowedDomains: [] } }),
    });
    await renderDetail();
    const user = await openSettings();
    const hosts = await screen.findByRole("list", { name: S.hosts });
    expect(within(hosts).getByText("files.example.com")).toBeTruthy();
    expect(screen.getByText(S.localHostsHelp)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove files.example.com" }));
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(bodyOf(posts(calls)[0])).toEqual({
      remove: ["files.example.com"],
    });
  });

  it("project reach keeps today's control: limited to the workspace, nothing else", async () => {
    stubApi(detail(local({ ownerCeiling: report({ restrictedProjectReach: "workspace" }) })));
    await renderDetail();
    await openSettings();
    await sandboxSection();
    expect(screen.getByText(S.reachValue.workspace)).toBeTruthy();
    expect(screen.queryByRole("button", { name: S.limitReach })).toBeNull();
  });

  it("an offline machine shows no refused control: it says to narrow on the computer", async () => {
    stubApi(detail(local({ online: false, ownerCeiling: report({ stale: true }) })));
    await renderDetail();
    await openSettings();
    expect(await screen.findByText(S.cannotNarrow.offline)).toBeTruthy();
    expect(screen.getAllByText(S.notice.stale).length).toBeGreaterThan(0);
    expect(radio(S.network, S.networkValue.allowlist).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: S.limitReach })).toBeNull();
  });

  it("a program that cannot take changes says to update it", async () => {
    stubApi(detail(local({ network: { features: ["networkReport"], policy: null } })));
    await renderDetail();
    await openSettings();
    expect(await screen.findByText(S.cannotNarrow.upgrade)).toBeTruthy();
    expect(radio(S.outside, S.outsideValue.off).disabled).toBe(true);
  });

  it("a blocked report fails closed: unknown settings, the re-login step, no control", async () => {
    stubApi(
      detail(
        local({
          ownerCeiling: report({ state: "blocked" }),
        }),
      ),
    );
    await renderDetail();
    await sandboxSection();
    expect(factRow(S.network)?.textContent).toContain(S.unknown);
    expect(screen.getByText(S.notice.blocked)).toBeTruthy();
    await openSettings();
    await sandboxSection();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("without a connected machine it says how to connect one and shows no command", async () => {
    stubApi(
      detail(
        local({
          machine: null,
          network: null,
          online: false,
          ownerCeiling: null,
        }),
      ),
    );
    await renderDetail();
    await sandboxSection();
    expect(screen.getByText(S.notice.noMachine)).toBeTruthy();
    await openSettings();
    await sandboxSection();
    expect(document.querySelector('[data-part="keycap-command-caps"]')).toBeNull();
  });

  it("a refused narrowing shows its actionable copy: an outdated owner report", async () => {
    stubApi({
      ...detail(local()),
      [`POST ${BASE}/e1/policy`]: failWith(409, "device.owner_report_stale"),
    });
    await renderDetail();
    const user = await openSettings();
    await sandboxSection();
    await user.click(radio(S.outside, S.outsideValue.off));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.errors.device.owner_report_stale);
  });
});

describe("a cloud device's network", () => {
  it("has no outside-sandbox control and changes its network with { network: { mode, hosts } }", async () => {
    const calls = stubApi({
      ...detail(cloud()),
      [`PATCH ${BASE}/e1`]: () =>
        json(200, { device: cloud({ sandbox: cloudSandbox({ ownNetwork: "allowlist" }) }) }),
    });
    await renderDetail();
    const user = await openSettings();
    await sandboxSection();
    expect(screen.queryByRole("radiogroup", { name: S.outside })).toBeNull();
    // it follows the organization until it chooses its own network
    expect(radio(S.network, S.followOrg).checked).toBe(true);
    await user.click(radio(S.network, S.networkValue.allowlist));
    await user.type(screen.getByRole("textbox", { name: S.cloudHosts }), "files.example.com");
    await user.click(screen.getByRole("button", { name: S.save }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      network: { mode: "allowlist", hosts: ["files.example.com"] },
    });
  });

  it("prefills its own hosts, and goes back to following the organization with mode null", async () => {
    const calls = stubApi({
      ...detail(
        cloud({
          sandbox: cloudSandbox({
            network: "allowlist",
            ownNetwork: "allowlist",
            hosts: ["a.test"],
            allowedDomains: ["a.test"],
          }),
        }),
      ),
      [`PATCH ${BASE}/e1`]: () => json(200, { device: cloud() }),
    });
    await renderDetail();
    const user = await openSettings();
    await sandboxSection();
    expect(radio(S.network, S.networkValue.allowlist).checked).toBe(true);
    expect((screen.getByRole("textbox", { name: S.cloudHosts }) as HTMLTextAreaElement).value).toBe(
      "a.test",
    );
    await user.click(radio(S.network, S.followOrg));
    await user.click(screen.getByRole("button", { name: S.save }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ network: { mode: null } });
  });

  it("opens to the internet or closes the network without hosts", async () => {
    const calls = stubApi({
      ...detail(cloud()),
      [`PATCH ${BASE}/e1`]: () => json(200, { device: cloud() }),
    });
    await renderDetail();
    const user = await openSettings();
    await sandboxSection();
    await user.click(radio(S.network, S.networkValue.none));
    await user.click(screen.getByRole("button", { name: S.save }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      network: { mode: "none" },
    });
  });

  it("a network above the org ceiling is disabled and names the layer", async () => {
    stubApi(
      detail(
        cloud({
          sandbox: cloudSandbox({
            network: "allowlist",
            networkCeiling: "allowlist",
            layer: { network: "org", outsideSandbox: "provider" },
          }),
        }),
      ),
    );
    await renderDetail();
    await openSettings();
    await sandboxSection();
    expect(radio(S.network, S.networkValue.open).disabled).toBe(true);
    expect(radio(S.network, S.networkValue.allowlist).disabled).toBe(false);
    expect(screen.getByText(S.limited.network.org)).toBeTruthy();
  });

  it("a network the provider closed names the provider", async () => {
    stubApi(
      detail(
        cloud({
          sandbox: cloudSandbox({
            network: "none",
            networkCeiling: "none",
            layer: { network: "provider", outsideSandbox: "provider" },
          }),
        }),
      ),
    );
    await renderDetail();
    await openSettings();
    await sandboxSection();
    expect(radio(S.network, S.networkValue.open).disabled).toBe(true);
    expect(radio(S.network, S.networkValue.allowlist).disabled).toBe(true);
    expect(screen.getAllByText(S.limited.closed.provider).length).toBe(2);
  });

  it("a refusal above the ceiling shows its copy", async () => {
    stubApi({
      ...detail(cloud()),
      [`PATCH ${BASE}/e1`]: failWith(400, "device.network_not_allowed"),
    });
    await renderDetail();
    const user = await openSettings();
    await sandboxSection();
    await user.click(radio(S.network, S.networkValue.open));
    await user.click(screen.getByRole("button", { name: S.save }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.errors.device.network_not_allowed);
  });

  it("a device whose limits must be established again says so up front and offers 重建文件", async () => {
    stubApi(detail(cloud({ reconcileRequired: true })));
    await renderDetail();
    expect(await screen.findByText(E.detail.reconcileNote)).toBeTruthy();
    expect(screen.getByRole("button", { name: E.detail.resetFiles })).toBeTruthy();
  });

  it("a pending change is one status line", async () => {
    stubApi(detail(cloud({ sandbox: cloudSandbox({ pendingNextUse: true }) })));
    await renderDetail();
    await openSettings();
    expect(await screen.findByText(S.pendingNextUse)).toBeTruthy();
  });

  it("a change only a file reset applies has its own status line and offers 重建文件", async () => {
    stubApi(detail(cloud({ sandbox: cloudSandbox({ pendingFilesReset: true }) })));
    await renderDetail();
    await openSettings();
    expect(await screen.findByText(S.pendingFilesReset)).toBeTruthy();
    expect(screen.getByRole("button", { name: E.detail.resetFiles })).toBeTruthy();
  });

  it("a network change invalidates the device, so its permission previews are read again", async () => {
    let mode: string | null = null;
    const calls = stubApi({
      ...detail(cloud()),
      [`GET ${BASE}/e1`]: () =>
        json(200, { device: cloud({ sandbox: cloudSandbox({ ownNetwork: mode }) }) }),
      [`PATCH ${BASE}/e1`]: () => {
        mode = "allowlist";
        return json(200, { device: cloud({ sandbox: cloudSandbox({ ownNetwork: "allowlist" }) }) });
      },
    });
    const { client } = await renderDetail();
    const k = keys.org("o1");
    const previews = [k.permissionPreview("e1"), k.permissionPreview("e1", "api")];
    const other = k.permissionPreview("e2");
    for (const key of [...previews, other]) client.setQueryData(key, { cached: true });
    const user = await openSettings();
    await sandboxSection();
    const gets = () => calls.filter((c) => c.method === "GET" && c.url.endsWith("/e1")).length;
    const before = gets();
    await user.click(radio(S.network, S.networkValue.allowlist));
    await user.click(screen.getByRole("button", { name: S.save }));
    await vi.waitFor(() => expect(gets()).toBeGreaterThan(before));
    await vi.waitFor(() =>
      expect(previews.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([true, true]),
    );
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
  });
});

describe("the network on 概览", () => {
  it("a local machine lists its allowlist read only and points at 设置", async () => {
    stubApi(
      detail(
        local({
          sandbox: sandbox({
            network: "allowlist",
            hosts: ["files.example.com"],
            allowedDomains: ["files.example.com"],
          }),
        }),
      ),
    );
    await renderDetail();
    expect(await screen.findByRole("heading", { name: E.network.title })).toBeTruthy();
    const list = screen.getByRole("list", { name: E.network.domains });
    expect(within(list).getByText("files.example.com")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: E.overview.editNetwork }));
    expect(await screen.findByRole("radiogroup", { name: S.network })).toBeTruthy();
  });

  it("a cloud device on the open network has no network block", async () => {
    stubApi(detail(cloud()));
    await renderDetail();
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(screen.queryByRole("list", { name: E.network.domains })).toBeNull();
  });

  it("a cloud device on an allowlist shows its hosts with where they come from", async () => {
    stubApi(
      detail(
        cloud({
          sandbox: cloudSandbox({
            network: "allowlist",
            hosts: ["files.example.com", "*.slack.com"],
          }),
        }),
      ),
    );
    await renderDetail();
    const list = await screen.findByRole("list", { name: E.network.domains });
    expect(within(list).getByText("files.example.com")).toBeTruthy();
    expect(within(list).getByText("*.slack.com")).toBeTruthy();
    expect(screen.getByText(E.network.cloudHint.org)).toBeTruthy();
  });
});

describe("the recent changes", () => {
  const change = (over: Record<string, unknown> = {}) => ({
    at: T,
    kind: "policy",
    add: [],
    remove: [],
    ceiling: null,
    network: null,
    by: "Ada",
    via: "web",
    outcome: "applied",
    ...over,
  });

  it("says nothing when there is no change", async () => {
    stubApi(detail(cloud()));
    await renderDetail();
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(screen.queryByRole("list", { name: E.recent.title })).toBeNull();
  });

  it("lists host changes with who, where and what became of them", async () => {
    stubApi(
      detail(
        local(
          {},
          {
            recent: [
              change({ add: ["files.example.com"] }),
              change({ remove: ["*.slack.com"] }),
              change({ add: ["x.example.com"], outcome: "failed" }),
            ],
          },
        ),
      ),
    );
    await renderDetail();
    const list = await screen.findByRole("list", { name: E.recent.title });
    expect(within(list).getByText("Added files.example.com")).toBeTruthy();
    expect(within(list).getByText("Removed *.slack.com")).toBeTruthy();
    expect(within(list).getByText(E.recent.outcome.failed)).toBeTruthy();
    const webRow = within(list)
      .getAllByRole("listitem")
      .find((r) => r.textContent?.includes("Added files.example.com")) as HTMLElement;
    expect(webRow.querySelector(".cb-item-list-meta")?.textContent).toContain("Ada");
    expect(webRow.querySelector(".cb-item-list-meta")?.textContent).toContain(E.recent.via.web);
  });

  it("each setting change shows its from and to values", async () => {
    const ceiling = (from: unknown, to: unknown, via = "web") =>
      change({ kind: "ceiling", ceiling: { from, to }, via, by: via === "device" ? null : "Ada" });
    stubApi(
      detail(
        local(
          {},
          {
            recent: [
              ceiling(
                { outsideSandbox: true, network: "open" },
                { outsideSandbox: true, network: "allowlist" },
              ),
              ceiling({ outsideSandbox: false }, { outsideSandbox: true }, "device"),
              ceiling(
                { outsideSandbox: true, restrictedProjectReach: "os-user" },
                { outsideSandbox: true, restrictedProjectReach: "workspace" },
              ),
            ],
          },
        ),
      ),
    );
    await renderDetail();
    const list = await screen.findByRole("list", { name: E.recent.title });
    expect(
      within(list).getByText(`${S.network}: ${S.networkValue.open} → ${S.networkValue.allowlist}`),
    ).toBeTruthy();
    expect(
      within(list).getByText(`${S.outside}: ${S.outsideValue.off} → ${S.outsideValue.allowed}`),
    ).toBeTruthy();
    expect(
      within(list).getByText(`${S.reach}: ${S.reachValue["os-user"]} → ${S.reachValue.workspace}`),
    ).toBeTruthy();
    // a report of the machine names nobody
    const deviceRow = within(list)
      .getAllByRole("listitem")
      .find((r) => r.textContent?.includes(S.outsideValue.allowed)) as HTMLElement;
    const meta = deviceRow.querySelector(".cb-item-list-meta")?.textContent ?? "";
    expect(meta).toContain(E.recent.via.device);
    expect(meta).not.toContain(E.recent.unknownBy);
  });
});

describe("a cloud device's network changes in the recent changes", () => {
  it("reads following the organization and the own network with its hosts, from and to", async () => {
    const row = (from: unknown, to: unknown, via = "web") => ({
      at: T,
      kind: "network",
      add: [],
      remove: [],
      ceiling: null,
      network: { from, to },
      by: "Ada",
      via,
      outcome: "applied",
    });
    stubApi(
      detail(
        cloud({
          sandbox: cloudSandbox({
            recent: [
              row({ mode: null, hosts: [] }, { mode: "allowlist", hosts: ["a.test", "b.test"] }),
              row({ mode: "open", hosts: [] }, { mode: "none", hosts: [] }, "agent"),
              row({ mode: "none", hosts: [] }, { mode: null, hosts: [] }, "token"),
            ],
          }),
        }),
      ),
    );
    await renderDetail();
    const list = await screen.findByRole("list", { name: E.recent.title });
    expect(
      within(list).getByText(
        `${S.network}: ${S.followOrg} → ${S.networkValue.allowlist} (a.test, b.test)`,
      ),
    ).toBeTruthy();
    expect(
      within(list).getByText(`${S.network}: ${S.networkValue.open} → ${S.networkValue.none}`),
    ).toBeTruthy();
    expect(list.textContent).toContain(E.recent.via.agent);
    expect(list.textContent).toContain(E.recent.via.token);
  });
});

describe("the sandbox marks", () => {
  it("the list says whether a call may run outside the sandbox, neutral, never a mode", async () => {
    stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list([
            local(),
            local({
              id: "e2",
              name: "Server",
              sandbox: sandbox({ outsideSandbox: false }),
            }),
            cloud({ id: "e3", name: "Box" }),
          ]),
        ),
    });
    await renderList({ locale: "zh" });
    await screen.findByText("Server");
    const cards = await screen.findAllByRole("listitem");
    const meta = (c: HTMLElement) => c.querySelector(".cb-object-card-meta")?.textContent;
    expect(meta(cards[0] as HTMLElement)).toBe("在线 · 可在沙箱外运行");
    expect(meta(cards[1] as HTMLElement)).toBe("在线 · 仅沙箱");
    expect(meta(cards[2] as HTMLElement)).toBe("未启动 · 仅沙箱");
    expect(document.body.textContent).not.toMatch(/自动|完全访问|白名单|开放/);
  });
});

describe("the facts", () => {
  it("a cloud device shows 提供方 and 资源 in its overview", async () => {
    stubApi(detail(cloud()));
    await renderDetail();
    expect(await screen.findByRole("heading", { name: E.detail.resources })).toBeTruthy();
    expect(screen.getByText("2 CPU · 2 GB memory · 10 GB disk")).toBeTruthy();
    expect(screen.getByText(E.detail.provider)).toBeTruthy();
  });

  it("has no limits rows for a local device", async () => {
    stubApi(detail(local()));
    await renderDetail();
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(screen.queryByText(E.detail.resources)).toBeNull();
    expect(screen.queryByText(E.detail.provider)).toBeNull();
  });
});

describe("polling after a file reset", () => {
  const at = 1_000_000;
  const state = (over: Record<string, unknown> = {}) => ({
    filesLost: false,
    reconcileRequired: false,
    sandbox: { pendingFilesReset: false },
    ...over,
  });

  it("polls while a reset is pending and stops once nothing waits for it", () => {
    expect(resetPollInterval(state({ filesLost: true }), at, at + 1)).toBe(RESET_POLL_MS);
    expect(resetPollInterval(state({ reconcileRequired: true }), at, at + 1)).toBe(RESET_POLL_MS);
    expect(resetPollInterval(state({ sandbox: { pendingFilesReset: true } }), at, at + 1)).toBe(
      RESET_POLL_MS,
    );
    expect(resetPollInterval(state(), at, at + 1)).toBe(false);
    // no reset requested: never polls
    expect(resetPollInterval(state({ filesLost: true }), null, at)).toBe(false);
    expect(resetPollInterval(undefined, at, at)).toBe(false);
  });

  it("never polls forever: a marker that stays set stops polling at the deadline", () => {
    const marked = state({ reconcileRequired: true });
    expect(resetPollInterval(marked, at, at + RESET_POLL_DEADLINE_MS - 1)).toBe(RESET_POLL_MS);
    expect(resetPollInterval(marked, at, at + RESET_POLL_DEADLINE_MS)).toBe(false);
  });
});

describe("the query cache", () => {
  it("first render from the hydrated cache makes no browser read (the prefetch is the device)", async () => {
    const browser = expectNoFirstPaintFetch();
    stubApi(detail(cloud()));
    await renderRouteWithCache("/devices/e1", lastStubRoutes());
    expect(await screen.findByText(E.state.notStarted)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("empty cache shows the template loading, then the nameplate", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/devices/e1", {
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: async () => {
        await held;
        return json(200, { device: cloud() });
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-template="DetailPage"]')).not.toBeNull(),
    );
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Build box")).toBeNull();
    // the loading frame reserves the nameplate's facts band
    expect(document.querySelector('[data-part="loading-key-value"]')).not.toBeNull();
    await act(async () => release());
    expect(await screen.findByRole("heading", { level: 1, name: "Build box" })).toBeTruthy();
    const plate = document.querySelector('[data-part="device-nameplate"]') as HTMLElement;
    expect(plate.textContent).toContain("Build box");
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });
});
