import { act, cleanup, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { useDeviceChoice } from "../src/components/conversation/useSelection";
import { useConnectThisMachine } from "../src/lib/use-this-machine";
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
  layer: { network: "device", outsideSandbox: "device" },
  pendingNextUse: false,
  pendingFilesReset: false,
  recent: [],
};
const local = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Laptop ${id}`,
  isDefault: false,
  ownerKind: "personal",
  dialIn: true,
  provider: "@local",
  available: true,
  report: null,
  online: true,
  machine: {
    id: "m1",
    name: "grant-mbp",
    os: "darwin",
    programVersion: "0.4.0",
    lastSeenAt: T,
  },
  filesLost: false,
  instance: null,
  limits: {
    cpu: 2,
    memoryMb: 2048,
    diskMb: 10240,
    network: { kind: "allowlist", hosts: [] },
  },
  sandbox: SANDBOX,
  reconcileRequired: false,
  createdAt: T,
  ...over,
});

/** One of this machine's connections (`device@2` `ThisMachineConnection`). */
const conn = (deviceId: string, over: Record<string, unknown> = {}) => ({
  deviceId,
  orgId: "o1",
  mode: "os",
  connection: "online",
  serviceInstalled: true,
  keepAwake: { mode: "while-busy", held: false },
  ...over,
});
const CONNECTED = conn("e1");
/** What runs on each device: `running({ deviceId })` answers per connection. */
const runningOf = (deviceId: string) => [
  {
    tag: `build-${deviceId}`,
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
/** A fake `device@2` whose connections the test can change and push. */
function fakeDevice(connections: unknown[] = [CONNECTED], over: Record<string, unknown> = {}) {
  let current = connections;
  const listeners = new Set<() => void>();
  const device = {
    status: vi.fn(async () => ({ connections: current })),
    onStatus: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    running: vi.fn(async ({ deviceId }: { deviceId: string }) => runningOf(deviceId)),
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
    set(next: unknown[]) {
      current = next;
      act(() => {
        for (const l of listeners) l();
      });
    },
  };
}

const renderDetail = (id = "e1") => renderRouteWithCache(`/devices/${id}`, lastStubRoutes(), {});
const detailRoutes = (device: { id: string }) => ({
  ...NO_PROJECTS,
  [`GET ${BASE}/${device.id}/projects`]: () =>
    json(200, { projects: [], hidden: 0, mode: "auto", base: "/workspace", supported: true }),
  [`GET ${BASE}/${device.id}`]: () => json(200, { device }),
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
  it("本机 on each of this machine's devices, with that device's running list and actions", async () => {
    const fake = fakeDevice([conn("e1"), conn("e2")]);
    installShell({ "device@2": fake.device });
    resetNavigation("/devices/e2");
    stubApi(detailRoutes(local("e2")));
    await renderDetail("e2");
    expect(await screen.findByRole("heading", { name: M.title })).toBeTruthy();
    expect(await screen.findByText("build-e2")).toBeTruthy();
    expect(screen.queryByText("build-e1")).toBeNull();
    expect(fake.device.running).toHaveBeenCalledWith({ deviceId: "e2" });
    expect(fake.device.running).not.toHaveBeenCalledWith({ deviceId: "e1" });
    await userEvent.setup().click(screen.getByRole("button", { name: M.pause }));
    expect(fake.device.pause).toHaveBeenCalledWith({ deviceId: "e2" });
  });

  it("shows the running list, 暂停 / 断开 and the keep-awake choice with what it cannot prevent", async () => {
    installShell({ "device@2": fakeDevice().device });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    expect(await screen.findByRole("heading", { name: M.title })).toBeTruthy();
    expect(await screen.findByText("build-e1")).toBeTruthy();
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
    installShell({ "device@2": fakeDevice([conn("e1", { connection: "stopped" })]).device });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    expect(await screen.findByRole("button", { name: M.resume })).toBeTruthy();
    expect(screen.queryByRole("button", { name: M.pause })).toBeNull();
    expect(screen.queryByRole("button", { name: M.disconnect })).toBeNull();
  });

  it("pause calls the shell and reads the status again; a cancelled resume shows nothing", async () => {
    const fake = fakeDevice([conn("e1", { connection: "stopped" })], {
      resume: vi.fn(async () => "cancelled"),
    });
    installShell({ "device@2": fake.device });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: M.resume }));
    await waitFor(() => expect(fake.device.resume).toHaveBeenCalledWith({ deviceId: "e1" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(M.failed)).toBeNull();
    // the status is read again after the call
    await waitFor(() => expect(fake.device.status.mock.calls.length).toBeGreaterThan(1));
    fake.set([CONNECTED]);
    await user.click(await screen.findByRole("button", { name: M.pause }));
    expect(fake.device.pause).toHaveBeenCalledWith({ deviceId: "e1" });
  });

  it("a keep-awake choice calls setKeepAwake({ deviceId, mode })", async () => {
    const fake = fakeDevice();
    installShell({ "device@2": fake.device });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: M.keepAwake.connected }));
    expect(fake.device.setKeepAwake).toHaveBeenCalledWith({ deviceId: "e1", mode: "connected" });
  });

  it("says the computer was asleep when it woke after the last view", async () => {
    window.localStorage.setItem("capybara.device.lastView.e1", "2026-11-07T07:00:00.000Z");
    installShell({
      "device@2": fakeDevice([conn("e1", { lastWakeAt: "2026-11-07T07:30:00.000Z" })]).device,
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
      "device@2": fakeDevice([conn("e1", { lastWakeAt: "2026-11-07T07:30:00.000Z" })]).device,
    });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    await screen.findByRole("heading", { name: M.title });
    expect(screen.queryByText(M.wakeNote)).toBeNull();
  });

  it("an unavailable keep-awake says why", async () => {
    installShell({
      "device@2": fakeDevice([
        conn("e1", {
          keepAwake: { mode: "connected", held: false, unavailable: "systemd-inhibit missing" },
        }),
      ]).device,
    });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    expect(
      await screen.findByText(
        M.keepAwake.unavailable.replace("{reason}", "systemd-inhibit missing"),
      ),
    ).toBeTruthy();
  });

  it("another device, another org, or a browser: no 本机", async () => {
    installShell({
      "device@2": fakeDevice([conn("other"), conn("e1", { orgId: "o2" })]).device,
    });
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    await screen.findByRole("tab", { name: D.detail.tabSettings });
    expect(screen.queryByRole("heading", { name: M.title })).toBeNull();
    await userEvent.setup().click(screen.getByRole("tab", { name: D.detail.tabSettings }));
    expect(await screen.findByRole("button", { name: D.machine.revoke })).toBeTruthy();
    expect(screen.queryByRole("button", { name: D.sandbox.widen.outside })).toBeNull();
    cleanup();
    Reflect.deleteProperty(window, "capybaraShell");
    stubApi(detailRoutes(local("e1")));
    await renderDetail();
    await screen.findByRole("tab", { name: D.detail.tabSettings });
    expect(screen.queryByRole("heading", { name: M.title })).toBeNull();
  });
});

describe("marks", () => {
  it("the device list marks both of this machine's devices 本机", async () => {
    installShell({
      "device@2": fakeDevice([conn("e1"), conn("e2"), conn("e3", { orgId: "o2" })]).device,
    });
    stubApi({
      [`GET ${BASE}`]: () =>
        json(200, {
          items: [local("e1"), local("e2"), local("e3")],
          defaultId: null,
          lastUsedId: null,
          providers: [{ plugin: "sandbox-docker", displayName: null }],
          defaultProvider: "sandbox-docker",
        }),
    });
    await renderRouteWithCache("/devices", lastStubRoutes(), {});
    await screen.findByText("Laptop e1");
    const cardOf = (name: string) => screen.getByText(name).closest("li") as HTMLElement;
    await waitFor(() => expect(cardOf("Laptop e1").textContent).toContain(M.mark));
    expect(cardOf("Laptop e2").textContent).toContain(M.mark);
    // e3 is this machine's device in another org, not this one
    expect(cardOf("Laptop e3").textContent).not.toContain(M.mark);
  });

  it("the new-conversation picker tags both devices 本机", async () => {
    installShell({
      "device@2": fakeDevice([conn("e1"), conn("e2"), conn("e3", { orgId: "o2" })]).device,
    });
    stubApi({
      [`GET ${BASE}/e1/projects`]: () =>
        json(200, { projects: [], hidden: 0, mode: "auto", base: "/workspace", supported: true }),
    });
    const list = {
      items: [local("e1"), local("e2"), local("e3")],
      defaultId: null,
      lastUsedId: null,
      providers: [],
      defaultProvider: null,
    } as never;
    renderPage(<div />);
    const wrapper = ({ children }: { children: ReactNode }) => pageElement(children);
    const { result } = renderHook(() => useDeviceChoice("o1", list), { wrapper });
    await waitFor(() => {
      const items = result.current.picker?.groups[0]?.items ?? [];
      expect(items.find((i) => i.id === "e1")?.tag).toContain(M.mark);
      expect(items.find((i) => i.id === "e2")?.tag).toContain(M.mark);
    });
    expect(
      result.current.picker?.groups[0]?.items.find((i) => i.id === "e3")?.tag ?? "",
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

describe("useConnectThisMachine", () => {
  function mount() {
    renderPage(<div />);
    const wrapper = ({ children }: { children: ReactNode }) => pageElement(children);
    return renderHook(() => useConnectThisMachine("o1"), { wrapper });
  }

  it("is not offered in a browser", () => {
    const { result } = mount();
    expect(result.current.offered).toBe(false);
  });

  it("connect() calls device@2.connect({ orgId })", async () => {
    const connect = vi.fn().mockResolvedValue("connected");
    installShell({ "device@2": { ...fakeDevice().device, connect } });
    const { result } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
    act(() => result.current.connect());
    await waitFor(() => expect(connect).toHaveBeenCalledWith({ orgId: "o1" }));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.failed).toBe(false);
  });

  it("a cancelled connect (answer or rejection) is not a failure", async () => {
    const connect = vi
      .fn()
      .mockResolvedValueOnce("cancelled")
      .mockRejectedValueOnce({ code: "cancelled" });
    installShell({ "device@2": { ...fakeDevice().device, connect } });
    const { result } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
    for (let n = 1; n <= 2; n++) {
      act(() => result.current.connect());
      await waitFor(() => expect(connect).toHaveBeenCalledTimes(n));
      await waitFor(() => expect(result.current.pending).toBe(false));
      expect(result.current.failed).toBe(false);
    }
  });

  it.each([
    ["an { error } answer", vi.fn().mockResolvedValue({ error: "login failed" })],
    ["a rejection", vi.fn().mockRejectedValue({ code: "failed" })],
  ])("%s sets failed, and a new attempt clears it", async (_name, connect) => {
    installShell({ "device@2": { ...fakeDevice().device, connect } });
    const { result } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
    act(() => result.current.connect());
    await waitFor(() => expect(result.current.failed).toBe(true));
    connect.mockResolvedValueOnce("connected");
    act(() => result.current.connect());
    await waitFor(() => expect(result.current.failed).toBe(false));
  });
});
