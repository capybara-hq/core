import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { CEILING_COMMAND } from "../src/components/DeviceModeSection";
import { RESET_POLL_DEADLINE_MS, RESET_POLL_MS, resetPollInterval } from "../src/lib/devices";
import { keys } from "../src/lib/query/keys";
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
/** The device page also reads the device's projects (project root §4.1): none here. */
const NO_PROJECTS = {
  [`GET ${BASE}/e1/projects`]: () =>
    json(200, { projects: [], hidden: 0, mode: "auto", base: "/workspace", supported: true }),
};
const T = "2026-11-07T08:00:00.000Z";
const E = en.devices;
const COMMAND = CEILING_COMMAND;
const C = E.ceiling;
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
  fullNetwork: { kind: "open-public", hosts: [] },
  outerNetwork: { kind: "open-public", hosts: [] },
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
  fullNetwork: null,
  outerNetwork: null,
  pendingNextUse: false,
  pendingFilesReset: false,
  recent: [],
  ...over,
});

/** A local machine's authenticated owner report (B2): Full allowed, the OS user's reach. */
const report = (over: Record<string, unknown> = {}) => ({
  state: "report",
  revision: "r1",
  sequence: 3,
  fullAccess: true,
  effectiveFullAccess: true,
  restrictedProjectReach: "os-user",
  restrictedAllowedDomains: [],
  observedAt: T,
  stale: false,
  ...over,
});
/** A migrated cloud device's explicit Full ceiling. */
const cloudCeiling = (fullAccess = true, effectiveFullAccess = fullAccess) => ({
  state: "cloud",
  revision: null,
  sequence: null,
  fullAccess,
  effectiveFullAccess,
  restrictedProjectReach: "workspace",
  restrictedAllowedDomains: [],
  observedAt: null,
  stale: false,
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
  ownerCeiling: cloudCeiling(),
  reconcileRequired: false,
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
  ownerCeiling: report(),
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
/** The access ceiling section of 设置 (or 概览). */
const ceilingSection = () =>
  screen.findByRole("heading", { name: C.title }).then((h) => {
    const section = h.closest("section") ?? h.parentElement?.parentElement;
    return section as HTMLElement;
  });
const failWith = (status: number, code: string) => () =>
  json(status, { error: { code, message: `kernel says ${code}` } });

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
    // the ceiling mark, never a daily mode
    expect(plate.textContent).toContain(C.mark.full);
    expect(plate.textContent).not.toContain("Auto");
    // the design's own label for the third figure
    expect(plate.textContent).toContain("Created");
  });

  it("a cloud device without an instance has no version and never connected", async () => {
    stubApi(detail(cloud({ ownerCeiling: cloudCeiling(false) })));
    const { container } = await renderDetail();
    const plate = container.querySelector('[data-part="device-nameplate"]') as HTMLElement;
    expect(plate.textContent).toContain("—");
    expect(plate.textContent).toContain("Never connected");
    expect(plate.textContent).toContain(C.mark.restricted);
    expect(plate.querySelector(".cb-badge")?.getAttribute("data-tone")).toBe("default");
  });
});

describe("no daily mode", () => {
  it("neither tab draws the auto / sandbox choice or the old mode command", async () => {
    stubApi(detail(local()));
    await renderDetail();
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    await openSettings();
    await ceilingSection();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(document.body.textContent).not.toContain("capybara-device mode");
    expect(screen.queryByText(/^(Auto|Sandbox)$/)).toBeNull();
  });
});

describe("a local device's owner ceiling", () => {
  it("概览 shows it read only: Full access, project reach and when it was reported", async () => {
    const calls = stubApi(detail(local()));
    await renderDetail();
    const section = await ceilingSection();
    expect(within(section).getByText(C.fullAccess)).toBeTruthy();
    expect(factRow(C.fullAccess)?.textContent).toContain(C.full.available);
    expect(factRow(C.reach)?.textContent).toContain(C.reachValue["os-user"]);
    expect(factRow(C.reported)).toBeTruthy();
    // values only on 概览: no control
    expect(within(section).queryByRole("button")).toBeNull();
    await settle();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("设置 says only the owner widens it, on the computer, as copyable keycaps", async () => {
    stubApi(detail(local()));
    await renderDetail({ locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "设置" }));
    expect(await screen.findByText("只有电脑的所有者能在电脑上放宽：")).toBeTruthy();
    const caps = document.querySelector('[data-part="keycap-command-caps"]') as HTMLElement;
    expect(
      [...caps.querySelectorAll('[data-part="keycap-command-cap"]')].map((c) => c.textContent),
    ).toEqual(COMMAND.split(" "));
    expect(COMMAND.startsWith("capybara-device ceiling set")).toBe(true);
    await user.click(screen.getByRole("button", { name: `复制 ${COMMAND}` }));
    expect(await navigator.clipboard.readText()).toBe(COMMAND);
    // the web never offers to widen a machine
    expect(screen.queryByRole("button", { name: "允许完全访问" })).toBeNull();
  });

  it("narrows Full access and the project reach through the policy op, never wider", async () => {
    const calls = stubApi({
      ...detail(local()),
      [`POST ${BASE}/e1/policy`]: () =>
        json(200, { policy: { mode: "sandbox", allowedDomains: [] } }),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: C.turnOffFull }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      ownerCeiling: { fullAccess: false },
    });
    await user.click(screen.getByRole("button", { name: C.limitReach }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(bodyOf(calls.filter((c) => c.method === "POST")[1])).toEqual({
      ownerCeiling: { restrictedProjectReach: "workspace" },
    });
    // nothing ever widens: no true, no os-user, no auto, no PATCH
    for (const c of calls.filter((x) => x.method !== "GET")) {
      expect(String(c.body)).not.toMatch(/true|os-user|"auto"/);
    }
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("a narrowed machine offers nothing to narrow, only the owner's command", async () => {
    stubApi(
      detail(
        local({ ownerCeiling: report({ fullAccess: false, restrictedProjectReach: "workspace" }) }),
      ),
    );
    await renderDetail();
    await openSettings();
    await ceilingSection();
    expect(factRow(C.fullAccess)?.textContent).toContain(C.full.owner);
    expect(factRow(C.reach)?.textContent).toContain(C.reachValue.workspace);
    expect(screen.queryByRole("button", { name: C.turnOffFull })).toBeNull();
    expect(screen.queryByRole("button", { name: C.limitReach })).toBeNull();
    expect(screen.getByRole("button", { name: `Copy ${COMMAND}` })).toBeTruthy();
  });

  it("zh says Full access is off on this device, never that the device is off", async () => {
    stubApi(detail(local({ ownerCeiling: report({ fullAccess: false }) })));
    await renderDetail({ locale: "zh" });
    await screen.findByRole("heading", { name: zh.devices.ceiling.title });
    expect(factRow("完全访问")?.textContent).toContain("已在此设备上关闭");
  });

  it("an older program narrows both at once with its sandbox switch, and says so", async () => {
    const calls = stubApi({
      ...detail(
        local({ ownerCeiling: report({ state: "legacy", revision: null, sequence: null }) }),
      ),
      [`POST ${BASE}/e1/policy`]: () =>
        json(200, { policy: { mode: "sandbox", allowedDomains: [] } }),
    });
    await renderDetail();
    const user = await openSettings();
    expect(await screen.findByText(C.notice.legacy)).toBeTruthy();
    expect(screen.getByText(C.legacyNarrowNote)).toBeTruthy();
    expect(screen.queryByRole("button", { name: C.limitReach })).toBeNull();
    await user.click(screen.getByRole("button", { name: C.turnOffFull }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ mode: "sandbox" });
  });

  it("an offline machine shows no refused control: it says to narrow on the computer", async () => {
    stubApi(detail(local({ online: false, ownerCeiling: report({ stale: true }) })));
    await renderDetail();
    await openSettings();
    expect(await screen.findByText(C.cannotNarrow.offline)).toBeTruthy();
    expect(screen.getByText(C.notice.stale)).toBeTruthy();
    expect(screen.queryByRole("button", { name: C.turnOffFull })).toBeNull();
  });

  it("a program that cannot take changes says to update it", async () => {
    stubApi(detail(local({ network: { features: ["networkReport"], policy: null } })));
    await renderDetail();
    await openSettings();
    expect(await screen.findByText(C.cannotNarrow.upgrade)).toBeTruthy();
    expect(screen.queryByRole("button", { name: C.turnOffFull })).toBeNull();
  });

  it("a blocked report fails closed: Full access unconfirmed, with the re-login step", async () => {
    stubApi(
      detail(
        local({
          ownerCeiling: report({
            state: "blocked",
            fullAccess: false,
            restrictedProjectReach: "workspace",
          }),
        }),
      ),
    );
    await renderDetail();
    await ceilingSection();
    expect(factRow(C.fullAccess)?.textContent).toContain(C.full.unconfirmed);
    expect(screen.getByText(C.notice.blocked)).toBeTruthy();
    await openSettings();
    await ceilingSection();
    expect(screen.queryByRole("button", { name: C.turnOffFull })).toBeNull();
  });

  it("a platform or org that forbids Full access says so, the owner's ceiling notwithstanding", async () => {
    stubApi(detail(local({}, { allowedMode: "sandbox", allowedBy: null, mode: "sandbox" })));
    await renderDetail();
    await ceilingSection();
    expect(factRow(C.fullAccess)?.textContent).toContain(C.full.platform);
  });

  it("without a connected machine it says how to connect one", async () => {
    stubApi(detail(local({ machine: null, network: null, online: false, ownerCeiling: null })));
    await renderDetail();
    await ceilingSection();
    expect(screen.getByText(C.notice.noMachine)).toBeTruthy();
    expect(factRow(C.fullAccess)?.textContent).toContain(C.full.unconfirmed);
    // 设置 names the login step only: the ceiling command needs a connected computer
    await openSettings();
    await ceilingSection();
    expect(screen.queryByRole("button", { name: `Copy ${COMMAND}` })).toBeNull();
    expect(document.querySelector('[data-part="keycap-command-caps"]')).toBeNull();
  });

  it("a refused narrowing shows its actionable copy: an outdated owner report", async () => {
    stubApi({
      ...detail(local()),
      [`POST ${BASE}/e1/policy`]: failWith(409, "device.owner_report_stale"),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: C.turnOffFull }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.errors.device.owner_report_stale);
  });

  it("a computer that must restart says so", async () => {
    stubApi({
      ...detail(local()),
      [`POST ${BASE}/e1/policy`]: failWith(503, "device.restart_required"),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: C.turnOffFull }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      (en.errors.device as Record<string, string>).restart_required,
    );
  });
});

describe("a cloud device's owner ceiling", () => {
  it("turns Full access off only after a confirmation naming the effect", async () => {
    const calls = stubApi({
      ...detail(cloud()),
      [`PATCH ${BASE}/e1`]: () =>
        json(200, { device: cloud({ ownerCeiling: cloudCeiling(false) }) }),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: C.turnOffFull }));
    const dialog = await screen.findByRole("dialog", { name: C.confirm.title.narrow });
    expect(within(dialog).getByText(C.confirm.effect.narrow)).toBeTruthy();
    expect(within(dialog).getByText(C.confirm.network.open)).toBeTruthy();
    expect(within(dialog).getByText(C.confirm.nextUse)).toBeTruthy();
    // Full work stops now: nothing in the dialog defers that to the next use
    expect(dialog.textContent).toMatch(/stops now/);
    expect(dialog.textContent).not.toMatch(/takes effect at the next use/i);
    expect(dialog.textContent).not.toMatch(/network does not change/i);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: C.confirm.submit.narrow }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      ownerCeiling: { fullAccess: false },
    });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("widens Full access only through the explicit confirmation, with confirmWidening", async () => {
    const calls = stubApi({
      ...detail(cloud({ ownerCeiling: cloudCeiling(false) })),
      [`PATCH ${BASE}/e1`]: () => json(200, { device: cloud() }),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: C.allowFull }));
    const dialog = await screen.findByRole("dialog", { name: C.confirm.title.widen });
    expect(within(dialog).getByText(C.confirm.effect.widen)).toBeTruthy();
    expect(within(dialog).getByText(C.confirm.network.open)).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/network does not change/i);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: C.confirm.submit.widen }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      ownerCeiling: { fullAccess: true },
      confirmWidening: true,
    });
  });

  it("cancelling the confirmation sends nothing", async () => {
    const calls = stubApi(detail(cloud({ ownerCeiling: cloudCeiling(false) })));
    await renderDetail();
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: C.allowFull }));
    const dialog = await screen.findByRole("dialog", { name: C.confirm.title.widen });
    await user.click(within(dialog).getByRole("button", { name: C.confirm.cancel }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settle();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("turning Full access off names exactly the hosts the device then reaches", async () => {
    const hosts = ["files.example.com", "*.slack.com"];
    stubApi(detail(cloud({ mode: cloudMode({ sandboxNetwork: { kind: "allowlist", hosts } }) })));
    await renderDetail({ locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "设置" }));
    await user.click(await screen.findByRole("button", { name: "关闭完全访问" }));
    const dialog = await screen.findByRole("dialog", {
      name: zh.devices.ceiling.confirm.title.narrow,
    });
    expect(
      within(dialog).getByText(
        zh.devices.ceiling.confirm.network.allowlist.replace("{hosts}", hosts.join(", ")),
      ),
    ).toBeTruthy();
    expect(dialog.textContent).not.toContain("网络不变");
    expect(dialog.textContent).not.toContain("公网");
  });

  it("an empty organization allowlist says the device then reaches no host", async () => {
    stubApi(
      detail(cloud({ mode: cloudMode({ sandboxNetwork: { kind: "allowlist", hosts: [] } }) })),
    );
    await renderDetail();
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: C.turnOffFull }));
    const dialog = await screen.findByRole("dialog", { name: C.confirm.title.narrow });
    expect(within(dialog).getByText(C.confirm.network.none)).toBeTruthy();
  });

  it("allowing Full access names the network it then reaches within the device's outer network", async () => {
    stubApi(
      detail(
        cloud({
          ownerCeiling: cloudCeiling(false),
          mode: cloudMode({
            mode: "sandbox",
            network: { kind: "allowlist", hosts: ["files.example.com"], source: "org" },
            sandboxNetwork: { kind: "allowlist", hosts: ["files.example.com"] },
            fullNetwork: { kind: "allowlist", hosts: ["files.example.com", "a.test"] },
            outerNetwork: { kind: "allowlist", hosts: ["files.example.com", "a.test"] },
          }),
        }),
      ),
    );
    await renderDetail();
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: C.allowFull }));
    const dialog = await screen.findByRole("dialog", { name: C.confirm.title.widen });
    expect(
      within(dialog).getByText(
        C.confirm.network.allowlist.replace("{hosts}", "files.example.com, a.test"),
      ),
    ).toBeTruthy();
    // the exact network, not the conservative wording
    expect(dialog.textContent).not.toMatch(/provisioned|never beyond/);
  });

  it("the effective owner Full access decides: an old switch is off on the device, not the platform's", async () => {
    stubApi(
      detail(
        cloud({
          ownerCeiling: cloudCeiling(true, false),
          mode: cloudMode({ mode: "sandbox", allowedMode: "sandbox", allowedBy: null }),
        }),
      ),
    );
    await renderDetail();
    await openSettings();
    await ceilingSection();
    expect(factRow(C.fullAccess)?.textContent).toContain(C.full.owner);
    expect(screen.queryByRole("button", { name: C.turnOffFull })).toBeNull();
    expect(screen.queryByRole("button", { name: C.allowFull })).toBeNull();
  });

  it("a device whose limits must be established again says so up front and offers 重建文件", async () => {
    stubApi(detail(cloud({ reconcileRequired: true })));
    await renderDetail();
    expect(await screen.findByText(E.detail.reconcileNote)).toBeTruthy();
    expect(screen.getByRole("button", { name: E.detail.resetFiles })).toBeTruthy();
  });

  it("offers no narrowing while the platform or the org already keeps Full access off", async () => {
    stubApi(
      detail(
        cloud({
          ownerCeiling: cloudCeiling(true),
          mode: cloudMode({ mode: "sandbox", allowedMode: "sandbox", allowedBy: null }),
        }),
      ),
    );
    await renderDetail();
    await openSettings();
    await ceilingSection();
    expect(factRow(C.fullAccess)?.textContent).toContain(C.full.platform);
    expect(screen.queryByRole("button", { name: C.turnOffFull })).toBeNull();
    expect(screen.queryByRole("button", { name: C.allowFull })).toBeNull();
    expect(screen.getByText(C.cloudForbidden)).toBeTruthy();
  });

  it("offers no narrowing while its old sandbox switch already keeps Full access off", async () => {
    stubApi(
      // the kernel reports the switch in the effective owner allowance
      detail(
        cloud({ ownerCeiling: cloudCeiling(true, false), mode: cloudMode({ mode: "sandbox" }) }),
      ),
    );
    await renderDetail();
    await openSettings();
    await ceilingSection();
    expect(factRow(C.fullAccess)?.textContent).toContain(C.full.owner);
    expect(screen.queryByRole("button", { name: C.turnOffFull })).toBeNull();
  });

  it("offers no widening while the platform or the org forbids Full access", async () => {
    stubApi(
      detail(
        cloud({
          ownerCeiling: cloudCeiling(false),
          mode: cloudMode({ mode: "sandbox", allowedMode: "sandbox", allowedBy: null }),
        }),
      ),
    );
    await renderDetail();
    await openSettings();
    await ceilingSection();
    expect(factRow(C.fullAccess)?.textContent).toContain(C.full.owner);
    expect(screen.queryByRole("button", { name: C.allowFull })).toBeNull();
    expect(screen.queryByRole("button", { name: C.turnOffFull })).toBeNull();
  });

  it("before its permissions are migrated it narrows with the old switch and never widens", async () => {
    const calls = stubApi({
      ...detail(cloud({ ownerCeiling: null })),
      [`PATCH ${BASE}/e1`]: () => json(200, { device: cloud({ ownerCeiling: null }) }),
    });
    await renderDetail();
    const user = await openSettings();
    expect(await screen.findByText(C.notice.migrating)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: C.turnOffFull }));
    const dialog = await screen.findByRole("dialog", { name: C.confirm.title.narrow });
    await user.click(within(dialog).getByRole("button", { name: C.confirm.submit.narrow }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ mode: "sandbox" });
  });

  it("a device not migrated yet and narrowed by its old switch offers no widening", async () => {
    stubApi(detail(cloud({ ownerCeiling: null, mode: cloudMode({ mode: "sandbox" }) })));
    await renderDetail();
    await openSettings();
    await ceilingSection();
    expect(screen.queryByRole("button", { name: C.allowFull })).toBeNull();
  });

  it("a refused widening shows why", async () => {
    stubApi({
      ...detail(cloud({ ownerCeiling: cloudCeiling(false) })),
      [`PATCH ${BASE}/e1`]: failWith(409, "device.full_access_not_allowed"),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: C.allowFull }));
    const dialog = await screen.findByRole("dialog", { name: C.confirm.title.widen });
    await user.click(within(dialog).getByRole("button", { name: C.confirm.submit.widen }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.errors.device.full_access_not_allowed);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a refusal because the device is not migrated yet explains that, offering no file rebuild", async () => {
    stubApi({
      ...detail(cloud()),
      [`PATCH ${BASE}/e1`]: failWith(409, "device.permission_not_migrated"),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: C.turnOffFull }));
    const dialog = await screen.findByRole("dialog", { name: C.confirm.title.narrow });
    await user.click(within(dialog).getByRole("button", { name: C.confirm.submit.narrow }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.errors.device.permission_not_migrated);
    // a file reset does not migrate a device: the page neither offers it nor says to do it
    expect(screen.queryByText(en.errors.device.permission_reconcile_required)).toBeNull();
    expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull();
  });

  it("a pending ceiling change is one status line", async () => {
    stubApi(detail(cloud({ mode: cloudMode({ pendingNextUse: true }) })));
    await renderDetail();
    await openSettings();
    expect(await screen.findByText(C.pendingNextUse)).toBeTruthy();
  });

  it("a change that only a file reset applies has its own status line and offers 重建文件", async () => {
    stubApi(detail(cloud({ mode: cloudMode({ pendingFilesReset: true }) })));
    await renderDetail();
    await openSettings();
    expect(await screen.findByText(C.pendingFilesReset)).toBeTruthy();
    expect(screen.getByRole("button", { name: E.detail.resetFiles })).toBeTruthy();
  });

  it("the ceiling change invalidates the device, so its permission previews are read again", async () => {
    let fullAccess = true;
    const calls = stubApi({
      ...detail(cloud()),
      [`GET ${BASE}/e1`]: () =>
        json(200, { device: cloud({ ownerCeiling: cloudCeiling(fullAccess) }) }),
      [`PATCH ${BASE}/e1`]: () => {
        fullAccess = false;
        return json(200, { device: cloud({ ownerCeiling: cloudCeiling(false) }) });
      },
    });
    const { client } = await renderDetail();
    const k = keys.org("o1");
    // the composer's previews of this device (with and without a project), and another device's
    const previews = [k.permissionPreview("e1"), k.permissionPreview("e1", "api")];
    const other = k.permissionPreview("e2");
    for (const key of [...previews, other]) client.setQueryData(key, { cached: true });
    const user = await openSettings();
    const gets = () => calls.filter((c) => c.method === "GET" && c.url.endsWith("/e1")).length;
    const before = gets();
    await user.click(await screen.findByRole("button", { name: C.turnOffFull }));
    const dialog = await screen.findByRole("dialog", { name: C.confirm.title.narrow });
    await user.click(within(dialog).getByRole("button", { name: C.confirm.submit.narrow }));
    await vi.waitFor(() => expect(factRow(C.fullAccess)?.textContent).toContain(C.full.owner));
    expect(gets()).toBeGreaterThan(before);
    await vi.waitFor(() =>
      expect(previews.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([true, true]),
    );
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
  });
});

describe("the network", () => {
  it("a local machine lists its allowlist on 概览, read only, and points at 设置", async () => {
    stubApi(
      detail(local({}, { local: { reported: "auto", allowedDomains: ["files.example.com"] } })),
    );
    await renderDetail();
    expect(await screen.findByRole("heading", { name: E.network.title })).toBeTruthy();
    const list = screen.getByRole("list", { name: E.network.domains });
    expect(within(list).getByText("files.example.com")).toBeTruthy();
    // no editing here: one link to the settings tab
    const open = screen.getByRole("button", { name: E.overview.editNetwork });
    await userEvent.setup().click(open);
    expect(await screen.findByRole("heading", { name: C.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: E.network.add })).toBeTruthy();
  });

  it("a cloud device on the open network has no network section", async () => {
    stubApi(detail(cloud()));
    await renderDetail();
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(screen.queryByRole("heading", { name: E.network.cloudTitle })).toBeNull();
  });

  it("a cloud device shows the organization's allowlist read only", async () => {
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

describe("the recent changes", () => {
  const change = (over: Record<string, unknown> = {}) => ({
    at: T,
    kind: "policy",
    add: [],
    remove: [],
    mode: null,
    ceiling: null,
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

  it("lists host and ceiling changes with who, where and what became of them", async () => {
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
                mode: { from: "sandbox", to: "auto" },
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
    // an old mode change reads as the ceiling it set, never as a mode
    expect(within(list).getByText(E.recent.fullOff)).toBeTruthy();
    expect(within(list).getByText(E.recent.fullAllowed)).toBeTruthy();
    expect(list.textContent).not.toMatch(/Mode|Auto|Sandbox/);
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
      .find((r) => r.textContent?.includes(E.recent.fullAllowed)) as HTMLElement;
    const meta = deviceRow.querySelector(".cb-item-list-meta")?.textContent ?? "";
    expect(meta).toContain(E.recent.via.device);
    expect(meta).not.toContain(E.recent.unknownBy);
    expect(meta).not.toContain("Ada");
  });
});

describe("polling after a file reset", () => {
  const at = 1_000_000;
  const state = (over: Record<string, unknown> = {}) => ({
    filesLost: false,
    reconcileRequired: false,
    mode: { pendingFilesReset: false },
    ...over,
  });

  it("polls while a reset is pending and stops once nothing waits for it", () => {
    expect(resetPollInterval(state({ filesLost: true }), at, at + 1)).toBe(RESET_POLL_MS);
    expect(resetPollInterval(state({ reconcileRequired: true }), at, at + 1)).toBe(RESET_POLL_MS);
    expect(resetPollInterval(state({ mode: { pendingFilesReset: true } }), at, at + 1)).toBe(
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

describe("ceiling changes in the recent changes", () => {
  const ceiling = (from: Record<string, unknown>, to: Record<string, unknown>, via = "web") => ({
    at: T,
    kind: "ceiling",
    add: [],
    remove: [],
    mode: null,
    ceiling: { from, to },
    by: via === "device" ? null : "Ada",
    via,
    outcome: "applied",
  });

  it("a cloud Full change and a machine's reach change each read as what changed", async () => {
    stubApi(
      detail(
        cloud({
          mode: cloudMode({
            recent: [
              ceiling({ fullAccess: true }, { fullAccess: false }),
              ceiling(
                { fullAccess: false, restrictedProjectReach: "os-user" },
                { fullAccess: false, restrictedProjectReach: "workspace" },
                "device",
              ),
            ],
          }),
        }),
      ),
    );
    await renderDetail();
    const list = await screen.findByRole("list", { name: E.recent.title });
    expect(within(list).getByText(E.recent.fullOff)).toBeTruthy();
    expect(within(list).getByText(E.recent.reach.workspace)).toBeTruthy();
    expect(within(list).queryByText(E.recent.none)).toBeNull();
  });

  it("zh labels a widened reach and allowed Full access", async () => {
    stubApi(
      detail(
        cloud({
          mode: cloudMode({
            recent: [
              ceiling(
                { fullAccess: false, restrictedProjectReach: "workspace" },
                { fullAccess: true, restrictedProjectReach: "os-user" },
                "device",
              ),
            ],
          }),
        }),
      ),
    );
    await renderDetail({ locale: "zh" });
    const list = await screen.findByRole("list", { name: zh.devices.recent.title });
    expect(list.textContent).toContain(zh.devices.recent.fullAllowed);
    expect(list.textContent).toContain(zh.devices.recent.reach["os-user"]);
  });
});

describe("the ceiling marks", () => {
  it("the list says whether Full access is available, neutral, never a mode", async () => {
    stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list([
            local(),
            local({ id: "e2", name: "Server", ownerCeiling: report({ fullAccess: false }) }),
            cloud({ id: "e3", name: "Box", ownerCeiling: cloudCeiling(false) }),
          ]),
        ),
    });
    await renderList({ locale: "zh" });
    await screen.findByText("Server");
    const cards = await screen.findAllByRole("listitem");
    const meta = (c: HTMLElement) => c.querySelector(".cb-object-card-meta")?.textContent;
    expect(meta(cards[0] as HTMLElement)).toBe("在线 · 可完全访问");
    expect(meta(cards[1] as HTMLElement)).toBe("在线 · 受限");
    expect(meta(cards[2] as HTMLElement)).toBe("未启动 · 受限");
    for (const c of cards) expect(c.querySelector(".cb-object-card-meta-part")).toBeNull();
    expect(document.body.textContent).not.toMatch(/自动|沙箱|白名单|开放/);
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
