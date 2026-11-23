import { formSectionLayout } from "@capybara-hq/design";
import { findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { RESET_POLL_DEADLINE_MS, RESET_POLL_MS, resetPollInterval } from "../src/lib/devices";
import { keys } from "../src/lib/query/keys";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { personAvatarSrc } from "./support/person";
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
const PROJECTS = `${BASE}/e1/projects`;
const T = "2026-11-07T08:00:00.000Z";
const E = en.devices;
const Z = zh.devices;

const REPORT = {
  revision: "r1",
  description: {
    en: "Runs in a Docker container on the platform",
    zh: "在平台的 Docker 容器里运行",
  },
  home: null,
  limits: [] as { label: { en: string; zh?: string }; value: string }[],
  reset: true,
};
const MACHINE = {
  id: "m1",
  name: "grant-mbp",
  os: "darwin",
  programVersion: "0.4.0",
  lastSeenAt: T,
};

/** The kernel's effective sandbox view (`DeviceSandboxView`): following its org's open network. */
const sandbox = (over: Record<string, unknown> = {}) => ({
  network: "open",
  networkCeiling: "open",
  hosts: [],
  ownNetwork: null,
  allowedDomains: [],
  outsideSandbox: false,
  layer: { network: null, outsideSandbox: "provider" },
  pendingNextUse: false,
  pendingFilesReset: false,
  recent: [],
  ...over,
});

/** A device as the kernel sends it; `provider: "device-local"` makes it a dial-in one. */
const dev = (over: Record<string, unknown> = {}) => {
  const dialIn = over.provider === "device-local";
  return {
    id: "e1",
    name: "Build box",
    isDefault: false,
    ownerKind: "personal",
    provider: "sandbox-docker",
    providerDisplayName: dialIn
      ? { en: "Local machine", zh: "本机" }
      : { en: "Docker devices", zh: "Docker 设备" },
    dialIn,
    available: true,
    report: REPORT,
    online: dialIn ? true : null,
    machine: dialIn ? MACHINE : null,
    sandbox: sandbox(),
    reconcileRequired: false,
    filesLost: false,
    instance: null,
    limits: { cpu: 2, memoryMb: 2048, diskMb: 10240, network: { kind: "open-public", hosts: [] } },
    createdAt: T,
    ...over,
  };
};

const project = (name: string, path: string) => ({ name, path, createdAt: T });
const projectList = (over: Record<string, unknown> = {}) => ({
  projects: [project("api", "/workspace/api")],
  base: "/workspace",
  supported: true,
  ...over,
});

let calls: Call[] = [];
const renderDevice = async (
  device: unknown,
  opts: {
    locale?: "zh" | "en";
    routes?: Record<string, () => Response | Promise<Response>>;
  } = {},
) => {
  calls = stubApi({
    [`GET ${BASE}/e1`]: () => json(200, { device }),
    [`GET ${PROJECTS}`]: () => json(200, projectList()),
    [`PATCH ${BASE}/e1`]: () => json(200, { device }),
    ...opts.routes,
  });
  return renderRouteWithCache("/devices/e1", lastStubRoutes(), {
    ...(opts.locale ? { locale: opts.locale } : {}),
  });
};
const tabs = () => screen.getAllByRole("tab").map((t) => t.textContent);
const openTab = async (name: string) => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name }));
  return user;
};
const lastCall = (key: string) =>
  calls.filter((c) => `${c.method} ${c.url.split("?")[0]}` === key).at(-1);
/** The KeyValue row whose key is `key`. */
const factRow = (key: string) =>
  [...document.querySelectorAll('[data-part="key-value-row"]')].find(
    (r) => r.querySelector("dt")?.textContent === key,
  ) as HTMLElement | undefined;
const plate = () => document.querySelector('[data-part="device-nameplate"]') as HTMLElement;
// Drains the effects and promise callbacks already queued: a fetch a render starts is issued
// synchronously, so "nothing was fetched" needs no timer, only the queue emptied.
const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};
const radio = (name: string) =>
  screen.getByRole("radio", {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  }) as HTMLInputElement;

beforeEach(() => resetNavigation("/devices/e1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("one device page for every provider", () => {
  it("the page has 概览 / 项目 and no per-provider section", async () => {
    await renderDevice(dev({ provider: "device-local", online: true, report: REPORT }));
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(tabs()).toEqual([E.detail.tabOverview, E.detail.tabProjects]);
    expect(screen.queryByText(/capybara-device/)).toBeNull();
    expect(screen.queryByRole("button", { name: /断开|Disconnect this machine/ })).toBeNull();
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it("概览 shows the provider's description and its limits read only", async () => {
    await renderDevice(
      dev({
        report: {
          ...REPORT,
          limits: [{ label: { en: "Network", zh: "网络" }, value: "github.com" }],
        },
      }),
    );
    expect(await screen.findByText(REPORT.description.en)).toBeTruthy();
    expect(factRow("Network")?.textContent).toContain("github.com");
    // the report is read only: the one control group is the network section's own
    const about = document.getElementById("about") as HTMLElement;
    expect(within(about).queryByRole("radiogroup")).toBeNull();
    expect(within(about).queryByRole("button")).toBeNull();
  });

  it("概览 speaks the UI language and has no limits block without limits", async () => {
    await renderDevice(dev(), { locale: "zh" });
    expect(await screen.findByText(REPORT.description.zh)).toBeTruthy();
    expect(document.querySelector('[data-part="key-value-row"]')).toBeNull();
    expect(screen.getByText(Z.detail.filesAndSuspendNote)).toBeTruthy();
  });

  it("a device without a report says its provider did not answer", async () => {
    await renderDevice(dev({ report: null }));
    expect(await screen.findByText(E.overview.noReport)).toBeTruthy();
  });

  it("the nameplate names the provider; a dial-in device shows its machine's version", async () => {
    await renderDevice(dev({ provider: "device-local" }), { locale: "zh" });
    await screen.findByRole("tab", { name: Z.detail.tabOverview });
    expect(plate().textContent).toContain("本机");
    expect(plate().textContent).toContain("v0.4.0");
    expect(plate().textContent).toContain(Z.state.online);
  });

  it("a cloud device's nameplate shows its last use and no version", async () => {
    await renderDevice(dev({ instance: { status: "suspended", lastUsedAt: T } }));
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(plate().textContent).toContain("Docker devices");
    expect(plate().textContent).toContain("—");
    expect(plate().textContent).toContain("2026");
    expect(plate().textContent).toContain(E.sandbox.mark.sandbox);
  });

  it("a provider not on in the org: one callout naming it, files kept", async () => {
    await renderDevice(dev({ available: false, report: null }), { locale: "zh" });
    expect(
      await screen.findByText(
        "这台设备的设备类型（Docker 设备）在这个组织里没有启用，文件保留着。",
      ),
    ).toBeTruthy();
    expect(plate().textContent).toContain(Z.state.unavailable);
  });

  it("概览 is sections in columns: about, network, files, then the danger zone", async () => {
    await renderDevice(dev({ provider: "device-local", online: true, report: REPORT }));
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    const ids = [...document.querySelectorAll('[data-part="form-section"]')].map((s) => s.id);
    expect(ids).toEqual(["about", "network", "files"]);
    const template = document.querySelector('[data-template="DetailPage"]') as HTMLElement;
    // three sections: the template stands them in two columns (spec §5.3 "Columns by count")
    expect(formSectionLayout(template)).toBe("columns");
    // the danger zone is the sections' sibling, so it lines up with their field column
    const zone = document.querySelector('[data-part="danger-zone"]') as HTMLElement;
    expect(zone.parentElement).toBe(document.getElementById("files")?.parentElement);
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it("项目 is one section, so it stands stacked across the width", async () => {
    await renderDevice(dev());
    await openTab(E.detail.tabProjects);
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-part="form-section"]')).toHaveLength(1),
    );
    const template = document.querySelector('[data-template="DetailPage"]') as HTMLElement;
    expect(formSectionLayout(template)).toBe("stacked");
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it("概览 ends with the danger zone: one delete hint for every provider", async () => {
    await renderDevice(dev({ provider: "device-local", name: "Laptop" }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.detail.delete }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(E.detail.deleteHint.replace("{name}", "Laptop"));
  });

  it("the recent changes list network changes from → to, with who and where", async () => {
    const row = (from: unknown, to: unknown, via = "web") => ({
      at: T,
      kind: "network",
      network: { from, to },
      by: { id: "a1", name: "Ada", avatarUrl: "/api/v1/accounts/a1/avatar?v=abc" },
      via,
    });
    await renderDevice(
      dev({
        sandbox: sandbox({
          recent: [
            row({ mode: null, hosts: [] }, { mode: "allowlist", hosts: ["a.test", "b.test"] }),
            row({ mode: "open", hosts: [] }, { mode: "none", hosts: [] }, "agent"),
          ],
        }),
      }),
    );
    const list = await screen.findByRole("list", { name: E.recent.title });
    const N = E.network;
    expect(
      within(list).getByText(`${N.title}: ${N.follow} → ${N.allowlist} (a.test, b.test)`),
    ).toBeTruthy();
    expect(within(list).getByText(`${N.title}: ${N.open} → ${N.none}`)).toBeTruthy();
    const first = within(list).getAllByRole("listitem")[0] as HTMLElement;
    expect(personAvatarSrc(first)).toBe("/api/v1/accounts/a1/avatar?v=abc");
    expect(list.textContent).toContain(E.recent.via.web);
    expect(list.textContent).toContain(E.recent.via.agent);
  });
});

describe("网络", () => {
  it("网络 is the same for a local device: open within the ceiling, saved with PATCH", async () => {
    await renderDevice(
      dev({ provider: "device-local", sandbox: sandbox({ networkCeiling: "open" }) }),
    );
    await openTab(E.detail.tabOverview);
    await userEvent.click(screen.getByRole("radio", { name: E.network.open }));
    await userEvent.click(screen.getByRole("button", { name: E.network.save }));
    await vi.waitFor(() => expect(lastCall(`PATCH ${BASE}/e1`)).toBeDefined());
    expect(bodyOf(lastCall(`PATCH ${BASE}/e1`))).toEqual({ network: { mode: "open" } });
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it("an option above the ceiling is disabled and names its layer", async () => {
    await renderDevice(
      dev({
        sandbox: sandbox({
          network: "allowlist",
          networkCeiling: "allowlist",
          layer: { network: "org", outsideSandbox: "provider" },
        }),
      }),
      { locale: "zh" },
    );
    await openTab(Z.detail.tabOverview);
    expect(radio(Z.network.open).disabled).toBe(true);
    expect(radio(Z.network.allowlist).disabled).toBe(false);
    expect(screen.getByText(Z.network.limited.org)).toBeTruthy();
  });

  it("the own host list: add (validated) and remove, saved as the allowlist", async () => {
    await renderDevice(
      dev({
        sandbox: sandbox({
          network: "allowlist",
          ownNetwork: "allowlist",
          hosts: ["a.test"],
          allowedDomains: ["a.test"],
        }),
      }),
    );
    const user = await openTab(E.detail.tabOverview);
    expect(radio(E.network.allowlist).checked).toBe(true);
    const input = screen.getByRole("textbox", { name: E.network.hostInput });
    await user.type(input, "Bad Host");
    await user.click(screen.getByRole("button", { name: E.network.addHost }));
    expect(
      await screen.findByText(E.network.invalidHost.replace("{host}", "bad host")),
    ).toBeTruthy();
    await user.clear(input);
    await user.type(input, "files.example.com");
    await user.click(screen.getByRole("button", { name: E.network.addHost }));
    await user.click(
      screen.getByRole("button", { name: E.network.removeHost.replace("{host}", "a.test") }),
    );
    await user.click(screen.getByRole("button", { name: E.network.save }));
    await vi.waitFor(() => expect(lastCall(`PATCH ${BASE}/e1`)).toBeDefined());
    expect(bodyOf(lastCall(`PATCH ${BASE}/e1`))).toEqual({
      network: { mode: "allowlist", hosts: ["files.example.com"] },
    });
  });

  it("following the organization again sends mode null", async () => {
    await renderDevice(dev({ sandbox: sandbox({ ownNetwork: "none", network: "none" }) }));
    const user = await openTab(E.detail.tabOverview);
    await user.click(radio(E.network.follow));
    await user.click(screen.getByRole("button", { name: E.network.save }));
    await vi.waitFor(() => expect(lastCall(`PATCH ${BASE}/e1`)).toBeDefined());
    expect(bodyOf(lastCall(`PATCH ${BASE}/e1`))).toEqual({ network: { mode: null } });
  });

  it("the pending notes say when a saved network applies", async () => {
    await renderDevice(
      dev({ sandbox: sandbox({ pendingNextUse: true, pendingFilesReset: true }) }),
    );
    await openTab(E.detail.tabOverview);
    expect(screen.getByText(E.network.pendingNextUse)).toBeTruthy();
    expect(screen.getByText(E.network.pendingFilesReset)).toBeTruthy();
  });

  it("a refusal above the ceiling shows its copy", async () => {
    await renderDevice(dev(), {
      routes: {
        [`PATCH ${BASE}/e1`]: () =>
          json(400, {
            error: { code: "device.network_not_allowed", message: "kernel says no" },
          }),
      },
    });
    const user = await openTab(E.detail.tabOverview);
    await user.click(radio(E.network.open));
    await user.click(screen.getByRole("button", { name: E.network.save }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.errors.device.network_not_allowed.default);
  });

  it("a change invalidates the list, the device and its permission previews", async () => {
    const { client } = await renderDevice(dev());
    const k = keys.org("o1");
    client.setQueryData(k.devices(), { items: [] });
    const previews = [k.permissionPreview("e1"), k.permissionPreview("e1", "api")];
    const other = k.permissionPreview("e2");
    for (const key of [...previews, other]) client.setQueryData(key, { cached: true });
    const user = await openTab(E.detail.tabOverview);
    await user.click(radio(E.network.none));
    await user.click(screen.getByRole("button", { name: E.network.save }));
    await vi.waitFor(() =>
      expect(previews.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([true, true]),
    );
    expect(client.getQueryState(k.devices())?.isInvalidated).toBe(true);
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
  });
});

describe("重建文件", () => {
  it("重建文件 only when the report allows it", async () => {
    await renderDevice(dev({ filesLost: true, report: { ...REPORT, reset: false } }));
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull();
    expect(screen.getByText(E.detail.filesLostNoReset)).toBeTruthy();
  });

  it("offered when the report allows it and something waits for a reset", async () => {
    await renderDevice(dev({ provider: "device-local", reconcileRequired: true }));
    expect(await screen.findByRole("button", { name: E.detail.resetFiles })).toBeTruthy();
    expect(screen.getByText(E.detail.reconcileNote)).toBeTruthy();
  });

  it("never without a report, nor while the provider is off", async () => {
    await renderDevice(dev({ filesLost: true, report: null }));
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull();
    cleanup();
    await renderDevice(dev({ filesLost: true, available: false }));
    await screen.findByRole("tab", { name: E.detail.tabOverview });
    expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull();
  });
});

describe("项目", () => {
  it("项目 shows no hidden count and a provider refusal in the UI language", async () => {
    await renderDevice(dev(), {
      locale: "zh",
      routes: {
        [`GET ${PROJECTS}/candidates`]: () =>
          json(200, { candidates: [], base: "/workspace", supported: true }),
        [`POST ${PROJECTS}`]: () =>
          json(422, {
            error: {
              code: "device.project_refused",
              message: "Outside the container",
              details: [{ reason: { en: "Outside the container", zh: "不在容器里" } }],
            },
          }),
      },
    });
    const user = await openTab(Z.detail.tabProjects);
    const section = (await screen.findByRole("region", { name: Z.projects.title })) as HTMLElement;
    expect(within(section).getByText("api")).toBeTruthy();
    expect(section.textContent).not.toMatch(/隐藏/);
    await user.click(within(section).getByRole("button", { name: Z.projects.add }));
    const dialog = await screen.findByRole("dialog", { name: Z.projects.addTitle });
    // the base the kernel returned is the prefix
    expect(within(dialog).getByText("/workspace/")).toBeTruthy();
    const path = within(dialog).getByRole("textbox", { name: Z.projects.pathLabel });
    await user.type(path, "etc");
    await user.click(within(dialog).getByRole("button", { name: Z.projects.addSubmit }));
    expect(await within(dialog).findByText("不在容器里")).toBeTruthy();
    expect(path.getAttribute("aria-invalid")).toBe("true");
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it("a device without project support says so without naming a kind of device", async () => {
    await renderDevice(dev({ provider: "device-local" }), {
      routes: { [`GET ${PROJECTS}`]: () => json(200, projectList({ supported: false })) },
    });
    await openTab(E.detail.tabProjects);
    const section = (await screen.findByRole("region", { name: E.projects.title })) as HTMLElement;
    expect(within(section).getByText(E.projects.unsupported)).toBeTruthy();
    expect(within(section).queryByRole("button", { name: E.projects.add })).toBeNull();
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
  it("first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderDevice(dev());
    expect(await screen.findByText(E.state.notStarted)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("empty cache shows the template loading with two tabs, then the nameplate", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/devices/e1", {
      [`GET ${PROJECTS}`]: () => json(200, projectList()),
      [`GET ${BASE}/e1`]: async () => {
        await held;
        return json(200, { device: dev() });
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-template="DetailPage"]')).not.toBeNull(),
    );
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(tabs()).toHaveLength(2);
    await act(async () => release());
    expect(await screen.findByRole("heading", { level: 1, name: "Build box" })).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });
});
