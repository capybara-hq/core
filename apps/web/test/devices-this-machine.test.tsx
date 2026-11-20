import { act, cleanup, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { useDeviceChoice } from "../src/components/conversation/useSelection";
import { SANDBOX_COMMANDS } from "../src/components/DeviceModeSection";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { pageElement, renderPage } from "./support/render";

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
const D = en.devices;
const M = D.thisMachine;
const NO_PROJECTS = {
  [`GET ${BASE}/e1/projects`]: () =>
    json(200, { projects: [], hidden: 0, mode: "auto", base: "/workspace", supported: true }),
};
/** A local machine's sandbox (kernel `DeviceSandboxView`): an allowlist, inside the sandbox. */
const SANDBOX = {
  network: "allowlist",
  networkCeiling: "open",
  hosts: [],
  ownNetwork: null,
  allowedDomains: [],
  outsideSandbox: false,
  restrictedProjectReach: "os-user",
  layer: { network: "device", outsideSandbox: "device" },
  pendingNextUse: false,
  pendingFilesReset: false,
  recent: [],
};
const report = (over: Record<string, unknown> = {}) => ({
  state: "report",
  revision: "r1",
  sequence: 3,
  outsideSandbox: false,
  network: "allowlist",
  allowedDomains: [],
  restrictedProjectReach: "os-user",
  observedAt: T,
  stale: false,
  ...over,
});
const local = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Laptop ${id}`,
  isDefault: false,
  demotedFrom: null,
  ownerKind: "personal",
  source: "local",
  provider: "@local",
  available: true,
  online: true,
  machine: {
    id: "m1",
    name: "grant-mbp",
    os: "darwin",
    mode: "os",
    programVersion: "0.4.0",
    lastSeenAt: T,
  },
  network: { features: ["networkReport", "policyOp", "policyOpId"], policy: null },
  sessionIsolation: false,
  filesLost: false,
  instance: null,
  limits: {
    cpu: 2,
    memoryMb: 2048,
    diskMb: 10240,
    network: { kind: "allowlist", hosts: [] },
  },
  sandbox: SANDBOX,
  ownerCeiling: report(),
  reconcileRequired: false,
  createdAt: T,
  ...over,
});

const CONNECTED = {
  state: "connected",
  deviceId: "e1",
  orgId: "o1",
  mode: "os",
  connection: "online",
  serviceInstalled: true,
  keepAwake: { mode: "while-busy", held: false },
};
const RUNNING = [
  {
    tag: "build-7",
    conversationId: "c1",
    accountId: "a1",
    isolation: "restricted",
    startedAt: T,
  },
];

function installShell(caps: Record<string, unknown>) {
  const listeners = new Set<() => void>();
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = {
    version: 1,
    capabilities: caps,
    on: (_e: "change", l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
/** A fake `device@1` whose status the test can change and push. */
function fakeDevice(status: unknown = CONNECTED, over: Record<string, unknown> = {}) {
  let current = status;
  const listeners = new Set<(s: unknown) => void>();
  const device = {
    status: vi.fn(async () => current),
    onStatus: (l: (s: unknown) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    running: vi.fn(async () => RUNNING),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => "resumed"),
    disconnect: vi.fn(async () => {}),
    requestCeiling: vi.fn(async () => "applied"),
    setKeepAwake: vi.fn(async () => "applied"),
    connect: vi.fn(),
    ...over,
  };
  return {
    device,
    set(next: unknown) {
      current = next;
      act(() => {
        for (const l of listeners) l(next);
      });
    },
  };
}

const renderDetail = () => renderRouteWithCache("/devices/e1", lastStubRoutes(), {});
const detailRoutes = (device: unknown) => ({
  ...NO_PROJECTS,
  [`GET ${BASE}/e1`]: () => json(200, { device }),
});

beforeEach(() => {
  resetNavigation("/devices/e1");
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "capybaraShell");
});

describe("本机 on the device page", () => {
  it("shows the running list, 暂停 / 断开 and the keep-awake choice with what it cannot prevent", async () => {
    installShell({ "device@1": fakeDevice().device });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    expect(await screen.findByRole("heading", { name: M.title })).toBeTruthy();
    expect(await screen.findByText("build-7")).toBeTruthy();
    expect(screen.getByRole("button", { name: M.pause })).toBeTruthy();
    expect(screen.getByRole("button", { name: M.disconnect })).toBeTruthy();
    expect(screen.queryByRole("button", { name: M.resume })).toBeNull();
    const group = screen.getByRole("radiogroup", { name: M.keepAwake.title });
    for (const label of [M.keepAwake.off, M.keepAwake.whileBusy, M.keepAwake.connected]) {
      expect(within(group).getByRole("radio", { name: label })).toBeTruthy();
    }
    expect(
      (within(group).getByRole("radio", { name: M.keepAwake.whileBusy }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.getByText(M.keepAwake.cannot)).toBeTruthy();
  });

  it("a stopped machine offers 恢复 only", async () => {
    installShell({ "device@1": fakeDevice({ ...CONNECTED, connection: "stopped" }).device });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    expect(await screen.findByRole("button", { name: M.resume })).toBeTruthy();
    expect(screen.queryByRole("button", { name: M.pause })).toBeNull();
    expect(screen.queryByRole("button", { name: M.disconnect })).toBeNull();
  });

  it("pause calls the shell and reads the status again; a cancelled resume shows nothing", async () => {
    const fake = fakeDevice(
      { ...CONNECTED, connection: "stopped" },
      {
        resume: vi.fn(async () => "cancelled"),
      },
    );
    installShell({ "device@1": fake.device });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: M.resume }));
    await waitFor(() => expect(fake.device.resume).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(M.failed)).toBeNull();
    // the status is read again after the call
    await waitFor(() => expect(fake.device.status.mock.calls.length).toBeGreaterThan(1));
    fake.set(CONNECTED);
    await user.click(await screen.findByRole("button", { name: M.pause }));
    expect(fake.device.pause).toHaveBeenCalled();
  });

  it("a keep-awake choice calls setKeepAwake", async () => {
    const fake = fakeDevice();
    installShell({ "device@1": fake.device });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: M.keepAwake.connected }));
    expect(fake.device.setKeepAwake).toHaveBeenCalledWith("connected");
  });

  it("says the computer was asleep when it woke after the last view", async () => {
    window.localStorage.setItem("capybara.device.lastView.e1", "2026-11-07T07:00:00.000Z");
    installShell({
      "device@1": fakeDevice({ ...CONNECTED, lastWakeAt: "2026-11-07T07:30:00.000Z" }).device,
    });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    expect(await screen.findByText(M.wakeNote)).toBeTruthy();
    // the view is recorded: the next visit does not repeat it
    expect(window.localStorage.getItem("capybara.device.lastView.e1")).not.toBe(
      "2026-11-07T07:00:00.000Z",
    );
  });

  it("no wake note when the wake is older than the last view, or without one", async () => {
    window.localStorage.setItem("capybara.device.lastView.e1", "2026-11-07T09:00:00.000Z");
    installShell({
      "device@1": fakeDevice({ ...CONNECTED, lastWakeAt: "2026-11-07T07:30:00.000Z" }).device,
    });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    await screen.findByRole("heading", { name: M.title });
    expect(screen.queryByText(M.wakeNote)).toBeNull();
  });

  it("an unavailable keep-awake says why", async () => {
    installShell({
      "device@1": fakeDevice({
        ...CONNECTED,
        keepAwake: { mode: "connected", held: false, unavailable: "systemd-inhibit missing" },
      }).device,
    });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    expect(
      await screen.findByText(
        M.keepAwake.unavailable.replace("{reason}", "systemd-inhibit missing"),
      ),
    ).toBeTruthy();
  });

  it("another device, or a browser: no 本机 and the CLI lines stay", async () => {
    installShell({ "device@1": fakeDevice({ ...CONNECTED, deviceId: "other" }).device });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    await screen.findByRole("tab", { name: D.detail.tabSettings });
    expect(screen.queryByRole("heading", { name: M.title })).toBeNull();
    await userEvent.setup().click(screen.getByRole("tab", { name: D.detail.tabSettings }));
    expect(await screen.findByText(SANDBOX_COMMANDS.outside)).toBeTruthy();
    expect(screen.queryByRole("button", { name: D.sandbox.widen.outside })).toBeNull();
    cleanup();
    Reflect.deleteProperty(window, "capybaraShell");
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    await screen.findByRole("tab", { name: D.detail.tabSettings });
    expect(screen.queryByRole("heading", { name: M.title })).toBeNull();
  });
});

describe("widening on this machine", () => {
  const W = D.sandbox.widen;
  /** The machine keeps its sandbox narrow on every field the shell can widen. */
  const narrow = () =>
    local("e1", {
      sandbox: { ...SANDBOX, restrictedProjectReach: "workspace" },
      ownerCeiling: report({ restrictedProjectReach: "workspace" }),
    });
  const settings = async () => {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: D.detail.tabSettings }));
    return user;
  };

  it("each widening asks the shell for that one field only; adding a host stays a CLI line", async () => {
    const fake = fakeDevice();
    installShell({ "device@1": fake.device });
    stubApi(detailRoutes(narrow()));
    await renderDetail();
    const user = await settings();
    await user.click(await screen.findByRole("button", { name: W.network }));
    await waitFor(() =>
      expect(fake.device.requestCeiling).toHaveBeenLastCalledWith({ network: "open" }),
    );
    expect(await screen.findByText(M.widened)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: W.outside }));
    await waitFor(() =>
      expect(fake.device.requestCeiling).toHaveBeenLastCalledWith({ outsideSandbox: true }),
    );
    await user.click(screen.getByRole("button", { name: W.reach }));
    await waitFor(() =>
      expect(fake.device.requestCeiling).toHaveBeenLastCalledWith({ projectReach: "os-user" }),
    );
    expect(fake.device.requestCeiling).toHaveBeenCalledTimes(3);
    // the shell's calls replace their CLI lines; the host has no shell call
    expect(screen.queryByText(SANDBOX_COMMANDS.network)).toBeNull();
    expect(screen.queryByText(SANDBOX_COMMANDS.outside)).toBeNull();
    expect(screen.queryByText(SANDBOX_COMMANDS.reach)).toBeNull();
    expect(screen.getByText(SANDBOX_COMMANDS.host)).toBeTruthy();
  });

  it("offers only what the machine itself still keeps narrow", async () => {
    installShell({ "device@1": fakeDevice().device });
    stubApi(
      detailRoutes(
        local("e1", {
          // the open network is limited by the org, not the machine; the reach is already wide
          sandbox: {
            ...SANDBOX,
            networkCeiling: "allowlist",
            layer: { network: "org", outsideSandbox: "device" },
          },
        }),
      ),
    );
    await renderDetail();
    await settings();
    expect(await screen.findByRole("button", { name: W.outside })).toBeTruthy();
    expect(screen.queryByRole("button", { name: W.network })).toBeNull();
    expect(screen.queryByRole("button", { name: W.reach })).toBeNull();
  });

  it("with nothing the shell can widen, the host line keeps the owner's lead-in", async () => {
    installShell({ "device@1": fakeDevice().device });
    stubApi(
      detailRoutes(
        local("e1", {
          sandbox: {
            ...SANDBOX,
            networkCeiling: "allowlist",
            outsideSandbox: true,
            layer: { network: "org", outsideSandbox: "device" },
          },
        }),
      ),
    );
    await renderDetail();
    await settings();
    expect(await screen.findByText(SANDBOX_COMMANDS.host)).toBeTruthy();
    expect(screen.getByText(D.sandbox.widenLocal)).toBeTruthy();
    expect(screen.queryByText(D.sandbox.widenHere)).toBeNull();
  });

  it("a declined or cancelled widening shows nothing; a failed one says so", async () => {
    const fake = fakeDevice(CONNECTED, {
      requestCeiling: vi
        .fn()
        .mockResolvedValueOnce("cancelled")
        .mockRejectedValueOnce({ code: "cancelled" })
        .mockRejectedValueOnce({ code: "failed" }),
    });
    installShell({ "device@1": fake.device });
    stubApi(detailRoutes(narrow()));
    await renderDetail();
    const user = await settings();
    await user.click(await screen.findByRole("button", { name: W.outside }));
    await waitFor(() => expect(fake.device.requestCeiling).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: W.outside }));
    await waitFor(() => expect(fake.device.requestCeiling).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(M.widened)).toBeNull();
    expect(screen.queryByText(M.failed)).toBeNull();
    await user.click(screen.getByRole("button", { name: W.outside }));
    expect(await screen.findByText(M.failed)).toBeTruthy();
  });

  it("a shell whose device@1 lacks requestCeiling keeps the CLI lines", async () => {
    const { requestCeiling: _, ...device } = fakeDevice().device;
    installShell({ "device@1": device });
    stubApi(detailRoutes(narrow()));
    await renderDetail();
    await screen.findByRole("heading", { name: M.title });
    await settings();
    expect(await screen.findByText(SANDBOX_COMMANDS.outside)).toBeTruthy();
    expect(screen.getByText(SANDBOX_COMMANDS.network)).toBeTruthy();
    expect(screen.getByText(SANDBOX_COMMANDS.reach)).toBeTruthy();
    expect(screen.queryByRole("button", { name: W.outside })).toBeNull();
  });
});

describe("marks", () => {
  it("the device list marks this machine's device 本机", async () => {
    installShell({ "device@1": fakeDevice().device });
    stubApi({
      [`GET ${BASE}`]: () =>
        json(200, {
          items: [local("e1"), local("e2")],
          defaultId: null,
          lastUsedId: null,
          cloudAvailable: true,
        }),
    });
    await renderRouteWithCache("/devices", lastStubRoutes(), {});
    await screen.findByText("Laptop e1");
    const cardOf = (name: string) => screen.getByText(name).closest("li") as HTMLElement;
    await waitFor(() => expect(cardOf("Laptop e1").textContent).toContain(M.mark));
    expect(cardOf("Laptop e2").textContent).not.toContain(M.mark);
  });

  it("the new-conversation picker tags this machine's device 本机", async () => {
    installShell({ "device@1": fakeDevice().device });
    stubApi({
      [`GET ${BASE}/e1/projects`]: () =>
        json(200, { projects: [], hidden: 0, mode: "auto", base: "/workspace", supported: true }),
    });
    const list = {
      items: [local("e1"), local("e2")],
      defaultId: null,
      lastUsedId: null,
      cloudAvailable: false,
    } as never;
    renderPage(<div />);
    const wrapper = ({ children }: { children: ReactNode }) => pageElement(children);
    const { result } = renderHook(() => useDeviceChoice("o1", list), { wrapper });
    await waitFor(() => {
      const items = result.current.picker?.groups[0]?.items ?? [];
      expect(items.find((i) => i.id === "e1")?.tag).toContain(M.mark);
    });
    expect(
      result.current.picker?.groups[0]?.items.find((i) => i.id === "e2")?.tag ?? "",
    ).not.toContain(M.mark);
  });
});

describe("copy", () => {
  it("zh says 本机, 电脑曾休眠 and 暂停 / 恢复 / 断开", () => {
    const z = zh.devices.thisMachine;
    expect(z.title).toBe("本机");
    expect(z.mark).toBe("本机");
    expect(z.wakeNote).toBe("电脑曾休眠");
    expect([z.pause, z.resume, z.disconnect]).toEqual(["暂停", "恢复", "断开"]);
  });
});
