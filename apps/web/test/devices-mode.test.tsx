import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { MODE_COMMAND } from "../src/components/DeviceModeSection";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
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
const T = "2026-11-07T08:00:00.000Z";
const E = en.devices;
const COMMAND = MODE_COMMAND;
/** The KeyValue row whose key is `key` (the page's facts or the machine block). */
const factRow = (key: string) =>
  [...document.querySelectorAll('[data-part="key-value-row"]')].find(
    (r) => r.querySelector("dt")?.textContent === key,
  ) as HTMLElement | undefined;

const LIMITS = {
  cpu: 2,
  memoryMb: 2048,
  diskMb: 10240,
  mode: "auto",
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

const cloudMode = (over: Record<string, unknown> = {}) => ({
  mode: "auto",
  allowedMode: "auto",
  allowedBy: "org",
  network: { kind: "open-public", hosts: [], source: "org" },
  local: null,
  sandboxNetwork: { kind: "open-public", hosts: [] },
  pendingNextUse: false,
  pendingFilesReset: false,
  recent: [],
  ...over,
});
const localMode = (over: Record<string, unknown> = {}) => ({
  mode: "auto",
  allowedMode: "auto",
  allowedBy: "org",
  network: { kind: "allowlist", hosts: [], source: "platform" },
  local: { reported: "auto", allowedDomains: [] },
  sandboxNetwork: null,
  pendingNextUse: false,
  pendingFilesReset: false,
  recent: [],
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
  mode: cloudMode(),
  createdAt: T,
  ...over,
});
const local = (over: Record<string, unknown> = {}, modeOver: Record<string, unknown> = {}) => ({
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
  limits: { ...LIMITS, mode: "sandbox", network: { kind: "allowlist", hosts: [] } },
  mode: localMode(modeOver),
  createdAt: T,
  ...over,
});
const list = (items: unknown[]) => ({
  items,
  defaultId: "e1",
  lastUsedId: null,
  cloudAvailable: true,
});

const detail = (device: unknown) => ({ [`GET ${BASE}/e1`]: () => json(200, { device }) });
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
/** The mode's radio group in 设置. */
const modeGroup = () => screen.findByRole("radiogroup", { name: E.mode.title });

beforeEach(() => resetNavigation("/devices/e1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the device nameplate head", () => {
  it("is the page's head: name, origin, status, version and last seen, drawn once", async () => {
    stubApi(detail(local()));
    const { container } = await renderDetail();
    const plate = container.querySelector('[data-part="device-nameplate"]') as HTMLElement;
    expect(plate).not.toBeNull();
    expect(plate.textContent).toContain("Laptop");
    expect(plate.textContent).toContain(E.source.local);
    expect(plate.textContent).toContain(E.state.online);
    expect(plate.textContent).toContain("v0.4.0");
    // a local machine's last seen, and the device's creation time as a third figure
    expect(plate.textContent).toContain("2026");
    expect(plate.textContent).toContain(E.mark.auto);
    // the design's own label for the third figure
    expect(plate.textContent).toContain("Created");
  });

  it("a cloud device without an instance has no version and never connected", async () => {
    stubApi(detail(cloud()));
    const { container } = await renderDetail();
    const plate = container.querySelector('[data-part="device-nameplate"]') as HTMLElement;
    expect(plate.textContent).toContain("—");
    expect(plate.textContent).toContain("Never connected");
    expect(plate.textContent).toContain(E.mark.open);
  });
});

describe("the settings tab's run mode", () => {
  it("a local auto device: 自动 is checked, the command is keycaps and copies", async () => {
    stubApi(detail(local()));
    await renderDetail({ locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "设置" }));
    const group = await screen.findByRole("radiogroup", { name: "运行模式" });
    const auto = within(group).getByRole("radio", { name: /^自动/ }) as HTMLInputElement;
    const sandbox = within(group).getByRole("radio", { name: /^沙箱/ }) as HTMLInputElement;
    expect(auto.checked).toBe(true);
    expect(sandbox.checked).toBe(false);
    // the CLI line is the only place the command appears
    const caps = document.querySelector('[data-part="keycap-command-caps"]') as HTMLElement;
    expect(
      [...caps.querySelectorAll('[data-part="keycap-command-cap"]')].map((c) => c.textContent),
    ).toEqual(["capybara-device", "mode", "auto|sandbox"]);
    const copy = screen.getByRole("button", { name: `复制 ${COMMAND}` });
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toBe(COMMAND);
  });

  it("choosing 沙箱 sends the narrowing policy op; 自动 is never sent", async () => {
    const calls = stubApi({
      ...detail(local()),
      [`POST ${BASE}/e1/policy`]: () =>
        json(200, { policy: { mode: "sandbox", allowedDomains: [] } }),
    });
    await renderDetail();
    const user = await openSettings();
    const group = await modeGroup();
    await user.click(within(group).getByRole("radio", { name: /^Sandbox/ }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ mode: "sandbox" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    // nothing ever asks for auto mode
    expect(calls.some((c) => String(c.body ?? "").includes('"auto"'))).toBe(false);
  });

  it("a local sandbox device: 自动 cannot be chosen and says the machine switches it", async () => {
    const calls = stubApi(
      detail(local({}, { mode: "sandbox", local: { reported: "sandbox", allowedDomains: [] } })),
    );
    await renderDetail();
    await openSettings();
    const group = await modeGroup();
    const auto = within(group).getByRole("radio", { name: /^Auto/ }) as HTMLInputElement;
    // not a silently inert control: the card itself says why
    expect(auto.disabled).toBe(true);
    expect(within(group).getByText(E.mode.autoOnMachine)).toBeTruthy();
    // the machine's switch is a command, shown and copyable
    expect(screen.getByRole("button", { name: `Copy ${COMMAND}` })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: `Copy ${COMMAND}` }));
    await settle();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("a cloud auto device narrows to 沙箱 only after a confirmation naming the effect", async () => {
    const calls = stubApi({
      ...detail(
        cloud({
          mode: cloudMode({ sandboxNetwork: { kind: "allowlist", hosts: ["a.com", "b.com"] } }),
        }),
      ),
      [`PATCH ${BASE}/e1`]: () => json(200, { device: cloud() }),
    });
    await renderDetail();
    const user = await openSettings();
    const group = await modeGroup();
    expect((within(group).getByRole("radio", { name: /^Auto/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    await user.click(within(group).getByRole("radio", { name: /^Sandbox/ }));
    const dialog = await screen.findByRole("dialog", { name: E.mode.confirm.title.sandbox });
    // the effect: the network it will reach, the processes that may end, the way back
    expect(
      within(dialog).getByText(/reaches only the organization's allowlist: 2 hosts/),
    ).toBeTruthy();
    expect(within(dialog).getByText(E.mode.confirm.processes)).toBeTruthy();
    expect(within(dialog).getByText(E.mode.confirm.back.sandbox)).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    // the card stays on auto until the switch is made (the page behind the dialog is inert)
    expect(
      (within(group).getByRole("radio", { name: /^Auto/, hidden: true }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: E.mode.confirm.submit.sandbox }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ mode: "sandbox" });
    expect(calls.some((c) => String(c.body ?? "").includes('"auto"'))).toBe(false);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancelling the confirmation sends nothing and keeps the mode", async () => {
    const calls = stubApi(detail(cloud()));
    await renderDetail();
    const user = await openSettings();
    const group = await modeGroup();
    await user.click(within(group).getByRole("radio", { name: /^Sandbox/ }));
    const dialog = await screen.findByRole("dialog", { name: E.mode.confirm.title.sandbox });
    await user.click(within(dialog).getByRole("button", { name: E.mode.confirm.cancel }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settle();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect((within(group).getByRole("radio", { name: /^Auto/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("on the org's open cloud network the 沙箱 card and the dialog say it stays open (D3)", async () => {
    stubApi(detail(cloud()));
    await renderDetail();
    const user = await openSettings();
    const group = await modeGroup();
    const sandbox = within(group).getByRole("radio", { name: /^Sandbox/ });
    expect(sandbox.closest("label")?.textContent).toContain(E.mode.cloudSandboxNetwork.open);
    await user.click(sandbox);
    const dialog = await screen.findByRole("dialog", { name: E.mode.confirm.title.sandbox });
    expect(within(dialog).getByText(E.mode.confirm.network.open)).toBeTruthy();
  });

  it("the 沙箱 card of an allowlist org counts its hosts, in Chinese too", async () => {
    stubApi(
      detail(
        cloud({ mode: cloudMode({ sandboxNetwork: { kind: "allowlist", hosts: ["a.com"] } }) }),
      ),
    );
    await renderDetail({ locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "设置" }));
    const group = await screen.findByRole("radiogroup", { name: "运行模式" });
    const sandbox = within(group).getByRole("radio", { name: /^沙箱/ });
    expect(sandbox.closest("label")?.textContent).toContain("只能访问组织白名单里的 1 个域名");
  });

  it("a mode change in flight disables the cards: a second confirm sends no second PATCH", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const calls = stubApi({
      ...detail(cloud()),
      [`PATCH ${BASE}/e1`]: async () => {
        await held;
        return json(200, { device: cloud() });
      },
    });
    await renderDetail();
    const user = await openSettings();
    let group = await modeGroup();
    await user.click(within(group).getByRole("radio", { name: /^Sandbox/ }));
    const dialog = await screen.findByRole("dialog", { name: E.mode.confirm.title.sandbox });
    const submit = within(dialog).getByRole("button", { name: E.mode.confirm.submit.sandbox });
    await user.click(submit);
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.click(submit);
    group = screen.getByRole("radiogroup", { name: E.mode.title, hidden: true });
    const sandbox = within(group).getByRole("radio", { name: /^Sandbox/, hidden: true });
    expect((sandbox as HTMLInputElement).disabled).toBe(true);
    await settle();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    await act(async () => release());
  });

  it("a policy change in flight disables the cards: a second click sends no second POST", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const calls = stubApi({
      ...detail(local()),
      [`POST ${BASE}/e1/policy`]: async () => {
        await held;
        return json(200, { policy: { mode: "sandbox", allowedDomains: [] } });
      },
    });
    await renderDetail();
    const user = await openSettings();
    let group = await modeGroup();
    await user.click(within(group).getByRole("radio", { name: /^Sandbox/ }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    group = screen.getByRole("radiogroup", { name: E.mode.title });
    const sandbox = within(group).getByRole("radio", { name: /^Sandbox/ }) as HTMLInputElement;
    expect(sandbox.disabled).toBe(true);
    await user.click(sandbox);
    await settle();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    await act(async () => release());
  });

  it("a cloud sandbox device's owner switches back to auto after a confirmation (D2)", async () => {
    const calls = stubApi({
      ...detail(
        cloud({
          mode: cloudMode({
            mode: "sandbox",
            network: { kind: "allowlist", hosts: [], source: "org" },
            sandboxNetwork: { kind: "allowlist", hosts: [] },
          }),
        }),
      ),
      [`PATCH ${BASE}/e1`]: () => json(200, { device: cloud() }),
    });
    await renderDetail();
    const user = await openSettings();
    const group = await modeGroup();
    const auto = within(group).getByRole("radio", { name: /^Auto/ }) as HTMLInputElement;
    expect(auto.disabled).toBe(false);
    await user.click(auto);
    const dialog = await screen.findByRole("dialog", { name: E.mode.confirm.title.auto });
    expect(within(dialog).getByText(E.mode.confirm.network.auto)).toBeTruthy();
    expect(within(dialog).getByText(E.mode.confirm.processes)).toBeTruthy();
    expect(within(dialog).getByText(E.mode.confirm.back.auto)).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: E.mode.confirm.submit.auto }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    // widening clears the device's choice: it follows the org and the platform again
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ mode: null });
    expect(await screen.findByText(E.mode.changedAuto)).toBeTruthy();
  });

  it("a refused switch closes the dialog and shows the error", async () => {
    stubApi({
      ...detail(cloud()),
      [`PATCH ${BASE}/e1`]: () =>
        json(403, { error: { code: "device.mode_requires_session", message: "no" } }),
    });
    await renderDetail();
    const user = await openSettings();
    const group = await modeGroup();
    await user.click(within(group).getByRole("radio", { name: /^Sandbox/ }));
    const dialog = await screen.findByRole("dialog", { name: E.mode.confirm.title.sandbox });
    await user.click(within(dialog).getByRole("button", { name: E.mode.confirm.submit.sandbox }));
    expect(await screen.findByText(en.errors.device.mode_requires_session)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a cloud device the organization keeps in sandbox: the auto card is disabled with the reason", async () => {
    const calls = stubApi(
      detail(
        cloud({
          mode: cloudMode({
            mode: "sandbox",
            allowedMode: "sandbox",
            allowedBy: null,
            network: { kind: "allowlist", hosts: [], source: "platform" },
          }),
        }),
      ),
    );
    await renderDetail();
    const user = await openSettings();
    const group = await modeGroup();
    const auto = within(group).getByRole("radio", { name: /^Auto/ }) as HTMLInputElement;
    expect(auto.disabled).toBe(true);
    // the reason is on the card itself, not the section's description
    expect(auto.closest("label")?.textContent).toContain(E.mode.lockedSandbox);
    await user.click(auto);
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("the section description does not repeat the cards", async () => {
    stubApi(detail(cloud()));
    await renderDetail();
    await openSettings();
    const heading = await screen.findByRole("heading", { name: E.mode.title });
    const section = heading.closest("section") as HTMLElement;
    expect(within(section).getByText(E.mode.section.cloud)).toBeTruthy();
    // each card's text appears once, on its card
    expect(within(section).getAllByText(E.mode.cloudDescription.auto)).toHaveLength(1);
    expect(within(section).getAllByText(E.mode.cloudSandboxNetwork.open)).toHaveLength(1);
  });

  it("a local device whose organization forbids auto disables that card with the reason", async () => {
    stubApi(detail(local({}, { allowedMode: "sandbox", allowedBy: null, mode: "sandbox" })));
    await renderDetail();
    await openSettings();
    const group = await modeGroup();
    const auto = within(group).getByRole("radio", { name: /^Auto/ }) as HTMLInputElement;
    expect(auto.disabled).toBe(true);
    expect(within(group).getByText(E.mode.unavailable)).toBeTruthy();
  });

  it("a local device offline cannot be narrowed from here: the 沙箱 card says why", async () => {
    const calls = stubApi(detail(local({ online: false })));
    await renderDetail();
    const user = await openSettings();
    const group = await modeGroup();
    const sandbox = within(group).getByRole("radio", { name: /^Sandbox/ }) as HTMLInputElement;
    expect(sandbox.disabled).toBe(true);
    expect(sandbox.closest("label")?.textContent).toContain(E.mode.offline);
    await user.click(sandbox);
    await settle();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    // the command stays: it works on the machine
    expect(screen.getByRole("button", { name: `Copy ${COMMAND}` })).toBeTruthy();
  });

  it("a pending mode change is one status line", async () => {
    stubApi(detail(cloud({ mode: cloudMode({ pendingNextUse: true }) })));
    await renderDetail();
    await openSettings();
    expect(await screen.findByText(E.mode.pendingNextUse)).toBeTruthy();
  });

  it("a change that only a file reset applies has its own status line and offers 重建文件", async () => {
    stubApi(detail(cloud({ mode: cloudMode({ pendingFilesReset: true }) })));
    await renderDetail();
    await openSettings();
    expect(await screen.findByText(E.mode.pendingFilesReset)).toBeTruthy();
    expect(screen.getByRole("button", { name: E.detail.resetFiles })).toBeTruthy();
  });
});

describe("the network", () => {
  it("a local auto device has no network section, in either tab", async () => {
    stubApi(detail(local()));
    await renderDetail();
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(screen.queryByRole("heading", { name: E.network.title })).toBeNull();
    await openSettings();
    expect(screen.queryByRole("heading", { name: E.network.title })).toBeNull();
  });

  it("a cloud auto device has none: its network is the nameplate's mark", async () => {
    stubApi(detail(cloud()));
    const { container } = await renderDetail();
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(screen.queryByRole("heading", { name: E.network.cloudTitle })).toBeNull();
    const plate = container.querySelector('[data-part="device-nameplate"]') as HTMLElement;
    expect(plate.textContent).toContain(E.mark.open);
  });

  it("a local sandbox device lists its hosts on 概览, read only, and points at 设置", async () => {
    stubApi(
      detail(
        local(
          {},
          {
            mode: "sandbox",
            local: { reported: "sandbox", allowedDomains: ["files.example.com"] },
          },
        ),
      ),
    );
    await renderDetail();
    expect(await screen.findByRole("heading", { name: E.network.title })).toBeTruthy();
    const list = screen.getByRole("list", { name: E.network.domains });
    expect(within(list).getByText("files.example.com")).toBeTruthy();
    // no editing here: one link to the settings tab
    const open = screen.getByRole("button", { name: E.overview.editNetwork });
    await userEvent.setup().click(open);
    expect(await screen.findByRole("heading", { name: E.mode.title })).toBeTruthy();
  });

  it("a cloud sandbox device shows the organization's allowlist read only", async () => {
    stubApi(
      detail(
        cloud({
          mode: cloudMode({
            mode: "sandbox",
            network: {
              kind: "allowlist",
              hosts: ["files.example.com", "*.slack.com"],
              source: "org",
            },
          }),
        }),
      ),
    );
    await renderDetail();
    expect(await screen.findByRole("heading", { name: E.network.title })).toBeTruthy();
    const list = screen.getByRole("list", { name: E.network.domains });
    expect(within(list).getByText("files.example.com")).toBeTruthy();
    expect(within(list).getByText("*.slack.com")).toBeTruthy();
    expect(screen.getByText(E.network.cloudHint.org)).toBeTruthy();
    // read only: no add control anywhere on the page
    expect(screen.queryByRole("button", { name: E.network.add })).toBeNull();
  });

  it("a cloud sandbox device on the open network has no list to show", async () => {
    stubApi(
      detail(
        cloud({
          mode: cloudMode({
            mode: "sandbox",
            network: { kind: "open-public", hosts: [], source: "platform" },
          }),
        }),
      ),
    );
    await renderDetail();
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(screen.queryByRole("heading", { name: E.network.title })).toBeNull();
    expect(screen.queryByText(/only the domains/)).toBeNull();
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
    expect(screen.queryByText(E.detail.network)).toBeNull();
  });
});

describe("the recent changes", () => {
  const change = (over: Record<string, unknown> = {}) => ({
    at: T,
    kind: "policy",
    add: [],
    remove: [],
    mode: null,
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

  it("lists host and mode changes with who, where and what became of them", async () => {
    stubApi(
      detail(
        cloud({
          mode: cloudMode({
            recent: [
              change({ add: ["files.example.com"] }),
              change({ remove: ["*.slack.com"] }),
              change({ kind: "mode", mode: { to: "sandbox" } }),
              change({
                kind: "mode",
                mode: { from: "auto", to: "sandbox" },
                by: null,
                via: "device",
              }),
              change({ add: ["x.example.com"], outcome: "failed" }),
            ],
          }),
        }),
      ),
    );
    await renderDetail();
    const list = await screen.findByRole("list", { name: E.recent.title });
    expect(within(list).getByText("Added files.example.com")).toBeTruthy();
    expect(within(list).getByText("Removed *.slack.com")).toBeTruthy();
    expect(within(list).getByText("Mode set to Sandbox")).toBeTruthy();
    expect(within(list).getByText("Mode changed from Auto to Sandbox")).toBeTruthy();
    // a change that did not take effect says so
    expect(within(list).getByText(E.recent.outcome.failed)).toBeTruthy();
    // a web change names its account and where it was made
    const webRow = within(list)
      .getAllByRole("listitem")
      .find((r) => r.textContent?.includes("Added files.example.com")) as HTMLElement;
    expect(webRow.querySelector(".cb-item-list-meta")?.textContent).toContain("Ada");
    expect(webRow.querySelector(".cb-item-list-meta")?.textContent).toContain(E.recent.via.web);
    // a change made on the machine names nobody (not even an unknown account)
    const deviceRow = within(list)
      .getAllByRole("listitem")
      .find((r) => r.textContent?.includes("Mode changed from Auto to Sandbox")) as HTMLElement;
    const meta = deviceRow.querySelector(".cb-item-list-meta")?.textContent ?? "";
    expect(meta).toContain(E.recent.via.device);
    expect(meta).not.toContain(E.recent.unknownBy);
    expect(meta).not.toContain("Ada");
    // no old tier vocabulary in the list (Open stays: it is a valid network mark)
    for (const tier of ["Strict", "Development"]) {
      expect(within(list).queryByText(tier)).toBeNull();
    }
  });
});

describe("the mode marks", () => {
  it("a local device marks 自动 (warn) or 沙箱 (quiet)", async () => {
    stubApi({
      [`GET ${BASE}`]: () =>
        json(200, list([local(), local({ id: "e2", name: "Server" }, { mode: "sandbox" })])),
    });
    await renderList({ locale: "zh" });
    await screen.findByText("Server");
    const cards = await screen.findAllByRole("listitem");
    const meta = (c: HTMLElement) => c.querySelector(".cb-object-card-meta")?.textContent;
    expect(meta(cards[0] as HTMLElement)).toBe("在线 · 自动");
    expect(
      (cards[0] as HTMLElement)
        .querySelector(".cb-object-card-meta-part")
        ?.getAttribute("data-tone"),
    ).toBe("warn");
    expect(meta(cards[1] as HTMLElement)).toBe("在线 · 沙箱");
    expect((cards[1] as HTMLElement).querySelector(".cb-object-card-meta-part")).toBeNull();
  });

  it("a cloud device marks 开放（挡内网） (warn) or 白名单 (quiet)", async () => {
    stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list([
            cloud(),
            cloud({
              id: "e2",
              name: "Quiet box",
              mode: cloudMode({
                mode: "sandbox",
                network: { kind: "allowlist", hosts: [], source: "org" },
              }),
            }),
          ]),
        ),
    });
    await renderList({ locale: "zh" });
    await screen.findByText("Quiet box");
    const cards = await screen.findAllByRole("listitem");
    const meta = (c: HTMLElement) => c.querySelector(".cb-object-card-meta")?.textContent;
    expect(meta(cards[0] as HTMLElement)).toBe("未启动 · 开放（挡内网）");
    expect(
      (cards[0] as HTMLElement)
        .querySelector(".cb-object-card-meta-part")
        ?.getAttribute("data-tone"),
    ).toBe("warn");
    expect(meta(cards[1] as HTMLElement)).toBe("未启动 · 白名单");
    expect((cards[1] as HTMLElement).querySelector(".cb-object-card-meta-part")).toBeNull();
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
