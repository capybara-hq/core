import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
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
const COMMAND = "capybara-device mode auto|sandbox";

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
  pendingNextUse: false,
  recent: [],
  ...over,
});
const localMode = (over: Record<string, unknown> = {}) => ({
  mode: "auto",
  allowedMode: "auto",
  allowedBy: "org",
  network: { kind: "allowlist", hosts: [], source: "platform" },
  local: { reported: "auto", allowedDomains: [] },
  pendingNextUse: false,
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
    // a local machine's last seen
    expect(plate.textContent).toContain("2026");
    expect(plate.textContent).toContain(E.mark.auto);
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

describe("the mode scale", () => {
  it("a local auto device: 自动 is effective, the command is keycaps and copies", async () => {
    stubApi(detail(local()));
    await renderDetail({ locale: "zh" });
    const group = await screen.findByRole("radiogroup", { name: "运行模式" });
    const auto = within(group).getByRole("radio", { name: /^自动/ });
    const sandbox = within(group).getByRole("radio", { name: /^沙箱/ });
    expect(auto.getAttribute("aria-checked")).toBe("true");
    expect(sandbox.getAttribute("aria-checked")).toBe("false");
    // the CLI line is the only place the command appears
    const caps = document.querySelector('[data-part="keycap-command-caps"]') as HTMLElement;
    expect(
      [...caps.querySelectorAll('[data-part="keycap-command-cap"]')].map((c) => c.textContent),
    ).toEqual(["capybara-device", "mode", "auto|sandbox"]);
    const copy = screen.getByRole("button", { name: `复制 ${COMMAND}` });
    await userEvent.setup().click(copy);
    expect(await navigator.clipboard.readText()).toBe(COMMAND);
  });

  it("choosing 沙箱 sends the narrowing policy op; 自动 is never sent", async () => {
    const calls = stubApi({
      ...detail(local()),
      [`POST ${BASE}/e1/policy`]: () =>
        json(200, { policy: { mode: "sandbox", allowedDomains: [] } }),
    });
    await renderDetail();
    const group = await screen.findByRole("radiogroup", { name: "Run mode" });
    await userEvent.setup().click(within(group).getByRole("radio", { name: /^Sandbox/ }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ mode: "sandbox" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    // nothing ever asks for auto mode
    expect(calls.some((c) => String(c.body ?? "").includes('"auto"'))).toBe(false);
  });

  it("a local sandbox device: choosing 自动 sends nothing (the machine decides)", async () => {
    const calls = stubApi(
      detail(local({}, { mode: "sandbox", local: { reported: "sandbox", allowedDomains: [] } })),
    );
    await renderDetail();
    const group = await screen.findByRole("radiogroup", { name: "Run mode" });
    // the machine's switch is a command, shown and copyable
    expect(screen.getByRole("button", { name: `Copy ${COMMAND}` })).toBeTruthy();
    await userEvent.setup().click(within(group).getByRole("radio", { name: /^Auto/ }));
    await settle();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("a cloud device has no choice: the scale is locked at the mode and says why", async () => {
    stubApi(detail(cloud()));
    const { container } = await renderDetail();
    const scale = container.querySelector('[data-part="mode-scale"]') as HTMLElement;
    expect(scale.getAttribute("data-locked")).toBe("true");
    expect(scale.textContent).toContain(E.mode.lockedCloud);
    const group = screen.getByRole("radiogroup", { name: "Run mode" });
    const stations = within(group).getAllByRole("radio");
    expect(stations.every((s) => (s as HTMLButtonElement).disabled)).toBe(true);
  });

  it("a cloud device the organization keeps in sandbox says so", async () => {
    stubApi(
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
    expect(await screen.findByText(E.mode.lockedSandbox)).toBeTruthy();
  });

  it("a local device whose organization forbids auto marks 自动 unavailable", async () => {
    stubApi(detail(local({}, { allowedMode: "sandbox", allowedBy: null, mode: "sandbox" })));
    await renderDetail();
    const group = await screen.findByRole("radiogroup", { name: "Run mode" });
    const auto = within(group).getByRole("radio", { name: /^Auto/ }) as HTMLButtonElement;
    expect(auto.disabled).toBe(true);
    expect(screen.getByText(E.mode.unavailable)).toBeTruthy();
  });

  it("a local device offline cannot be changed from here", async () => {
    stubApi(detail(local({ online: false })));
    const { container } = await renderDetail();
    const scale = container.querySelector('[data-part="mode-scale"]') as HTMLElement;
    expect(scale.getAttribute("data-disabled")).toBe("true");
    expect(screen.getByText(E.mode.offline)).toBeTruthy();
    // the command stays: it works on the machine
    expect(screen.getByRole("button", { name: `Copy ${COMMAND}` })).toBeTruthy();
  });

  it("a pending mode change is one status line", async () => {
    stubApi(detail(cloud({ mode: cloudMode({ pendingNextUse: true }) })));
    await renderDetail();
    expect(await screen.findByText(E.mode.pendingNextUse)).toBeTruthy();
  });
});

describe("the network section exists in sandbox mode only", () => {
  it("a local auto device has none", async () => {
    stubApi(detail(local()));
    await renderDetail();
    await screen.findByRole("radiogroup", { name: "Run mode" });
    expect(screen.queryByRole("heading", { name: E.network.title })).toBeNull();
  });

  it("a cloud auto device has none; its network is a fact row", async () => {
    stubApi(detail(cloud()));
    await renderDetail();
    await screen.findByRole("radiogroup", { name: "Run mode" });
    expect(screen.queryByRole("heading", { name: E.network.cloudTitle })).toBeNull();
    expect(screen.getByText(E.detail.network)).toBeTruthy();
    expect(screen.getAllByText(E.networkKind["open-public"]).length).toBeGreaterThan(0);
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
    expect(await screen.findByRole("heading", { name: E.network.cloudTitle })).toBeTruthy();
    expect(screen.getByText("files.example.com · *.slack.com")).toBeTruthy();
    expect(screen.getByText(E.network.cloudHint)).toBeTruthy();
    // read only: no add field
    expect(screen.queryByRole("textbox", { name: E.network.add })).toBeNull();
  });
});

describe("the facts", () => {
  it("splits the limits into 资源 and 网络 (a cloud device)", async () => {
    stubApi(detail(cloud()));
    await renderDetail();
    expect(await screen.findByText(E.detail.resources)).toBeTruthy();
    expect(screen.getByText("2 CPU · 2 GB memory · 10 GB disk")).toBeTruthy();
    expect(screen.getByText(E.detail.network)).toBeTruthy();
  });

  it("has no limits rows for a local device", async () => {
    stubApi(detail(local()));
    await renderDetail();
    await screen.findByText(E.detail.source);
    expect(screen.queryByText(E.detail.resources)).toBeNull();
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
    expect((await screen.findAllByText(E.state.notStarted)).length).toBeGreaterThan(0);
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
    await act(async () => release());
    expect((await screen.findAllByText("Build box")).length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });
});
