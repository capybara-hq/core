import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
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
const PROJECTS = `${BASE}/e1/projects`;
const T = "2026-11-07T08:00:00.000Z";
const E = en.devices;
const P = en.devices.projects;

const mode = (over: Record<string, unknown> = {}) => ({
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
  limits: {
    cpu: 2,
    memoryMb: 2048,
    diskMb: 10240,
    mode: "auto",
    network: { kind: "open-public", hosts: [] },
  },
  mode: mode(),
  createdAt: T,
  ...over,
});
const local = (over: Record<string, unknown> = {}) =>
  cloud({
    name: "Laptop",
    source: "local",
    provider: "@local",
    online: true,
    machine: {
      id: "m1",
      name: "grant-mbp",
      os: "darwin",
      mode: "os",
      programVersion: "0.5.0",
      lastSeenAt: T,
    },
    network: { features: ["policyOpId", "projects"], policy: { mode: "auto", allowedDomains: [] } },
    mode: mode({
      network: { kind: "allowlist", hosts: [], source: "platform" },
      local: { reported: "auto", allowedDomains: [] },
      sandboxNetwork: null,
    }),
    ...over,
  });

const project = (name: string, path: string) => ({ name, path, createdAt: T });
const projectList = (over: Record<string, unknown> = {}) => ({
  projects: [project("api", "/workspace/api"), project("web", "/workspace/web")],
  hidden: 0,
  mode: "sandbox",
  base: "/workspace",
  supported: true,
  ...over,
});

const routes = (device: unknown, list: unknown = projectList()) => ({
  [`GET ${BASE}/e1`]: () => json(200, { device }),
  [`GET ${PROJECTS}`]: () => json(200, list),
});
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const renderDetail = (opts: Parameters<typeof renderRouteWithCache>[2] = {}) =>
  renderRouteWithCache("/devices/e1", lastStubRoutes(), opts);
const openSettings = async () => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: E.detail.tabSettings }));
  return user;
};
const projectsSection = () =>
  screen.findByRole("region", { name: P.title }) as Promise<HTMLElement>;
const gets = (calls: Call[], url: string) =>
  calls.filter((c) => c.method === "GET" && c.url.split("?")[0] === url).length;

beforeEach(() => resetNavigation("/devices/e1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the overview's projects", () => {
  it("lists the device's projects read-only, with the hidden count", async () => {
    stubApi(routes(cloud(), projectList({ hidden: 2 })));
    await renderDetail();
    const section = await projectsSection();
    expect(within(section).getByText("api")).toBeTruthy();
    expect(within(section).getByText("/workspace/web")).toBeTruthy();
    expect(within(section).getByText(/2 more projects/)).toBeTruthy();
    // read only: no remove, no add
    expect(within(section).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(within(section).queryByRole("button", { name: P.add })).toBeNull();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("first render from the hydrated cache makes no browser read (projects prefetched)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/devices/e1", routes(cloud()));
    expect(await screen.findByText("api")).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("an empty cache reads the device and its projects, never the candidates", async () => {
    const { calls } = await renderRouteEmptyCache("/devices/e1", {
      ...routes(cloud()),
      [`GET ${PROJECTS}/candidates`]: () =>
        json(200, { candidates: [], mode: "sandbox", base: "/workspace", supported: true }),
    });
    expect(await screen.findByText("api")).toBeTruthy();
    await settle();
    expect(gets(calls, PROJECTS)).toBe(1);
    expect(gets(calls, `${PROJECTS}/candidates`)).toBe(0);
  });
});

describe("the settings tab's projects", () => {
  it("lists the projects with 移除 each; the candidates are not read on page load", async () => {
    const calls = stubApi(routes(cloud()));
    await renderDetail();
    await openSettings();
    const section = await projectsSection();
    expect(within(section).getByText("api")).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Remove project api" })).toBeTruthy();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    await settle();
    expect(gets(calls, `${PROJECTS}/candidates`)).toBe(0);
  });

  it("adding sends the typed relative path (the workspace/ prefix is fixed) and refreshes the list", async () => {
    let added = false;
    const calls = stubApi({
      ...routes(cloud()),
      [`GET ${PROJECTS}`]: () =>
        json(
          200,
          added
            ? projectList({
                projects: [...projectList().projects, project("app", "/workspace/src/app")],
              })
            : projectList(),
        ),
      [`GET ${PROJECTS}/candidates`]: () =>
        json(200, { candidates: [], mode: "sandbox", base: "/workspace", supported: true }),
      [`POST ${PROJECTS}`]: () => {
        added = true;
        return json(201, { project: project("app", "/workspace/src/app") });
      },
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(within(await projectsSection()).getByRole("button", { name: P.add }));
    const dialog = await screen.findByRole("dialog", { name: P.addTitle });
    // the base is shown, never typed
    expect(within(dialog).getByText("workspace/")).toBeTruthy();
    const path = within(dialog).getByRole("textbox", { name: P.pathLabel });
    await user.type(path, "src/app");
    // the name defaults to the last segment
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: new RegExp(`^${P.nameLabel}`),
        }) as HTMLInputElement
      ).placeholder,
    ).toBe("app");
    const before = gets(calls, PROJECTS);
    await user.click(within(dialog).getByRole("button", { name: P.addSubmit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ path: "src/app" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // the add invalidates the list
    await vi.waitFor(() => expect(gets(calls, PROJECTS)).toBeGreaterThan(before));
    expect(await within(await projectsSection()).findByText("/workspace/src/app")).toBeTruthy();
  });

  it("the candidates are read only when the form opens, and picking one fills it", async () => {
    const calls = stubApi({
      ...routes(cloud()),
      [`GET ${PROJECTS}/candidates`]: () =>
        json(200, {
          candidates: [
            { path: "/workspace/repo", relativePath: "repo", suggestedName: "repo" },
            { path: "/workspace/repo/pkg", relativePath: "repo/pkg", suggestedName: "pkg" },
          ],
          mode: "sandbox",
          base: "/workspace",
          supported: true,
        }),
      [`POST ${PROJECTS}`]: () => json(201, { project: project("pkg", "/workspace/repo/pkg") }),
    });
    await renderDetail();
    const user = await openSettings();
    await settle();
    expect(gets(calls, `${PROJECTS}/candidates`)).toBe(0);
    await user.click(within(await projectsSection()).getByRole("button", { name: P.add }));
    const dialog = await screen.findByRole("dialog", { name: P.addTitle });
    await user.click(await within(dialog).findByRole("button", { name: "Use workspace/repo/pkg" }));
    // the dialog with its candidate list, over the settings section: never a box in a box
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    expect(gets(calls, `${PROJECTS}/candidates`)).toBe(1);
    expect(
      (within(dialog).getByRole("textbox", { name: P.pathLabel }) as HTMLInputElement).value,
    ).toBe("repo/pkg");
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: new RegExp(`^${P.nameLabel}`),
        }) as HTMLInputElement
      ).value,
    ).toBe("pkg");
    await user.click(within(dialog).getByRole("button", { name: P.addSubmit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      path: "repo/pkg",
      name: "pkg",
    });
  });

  it("a refusal renders inline under the field and the list is unchanged", async () => {
    const calls = stubApi({
      ...routes(cloud()),
      [`GET ${PROJECTS}/candidates`]: () =>
        json(200, { candidates: [], mode: "sandbox", base: "/workspace", supported: true }),
      [`POST ${PROJECTS}`]: () =>
        json(422, {
          error: { code: "device.project_path_missing", message: "No such directory: nope" },
        }),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(within(await projectsSection()).getByRole("button", { name: P.add }));
    const dialog = await screen.findByRole("dialog", { name: P.addTitle });
    const path = within(dialog).getByRole("textbox", { name: P.pathLabel });
    await user.type(path, "nope");
    const before = gets(calls, PROJECTS);
    await user.click(within(dialog).getByRole("button", { name: P.addSubmit }));
    // under the path field, in the reader's language, mapped from the code
    await vi.waitFor(() => expect(path.getAttribute("aria-describedby") ?? "").not.toBe(""));
    expect(await within(dialog).findByText(en.errors.device.project_path_missing)).toBeTruthy();
    expect(path.getAttribute("aria-invalid")).toBe("true");
    // the dialog stays, the list is not read again
    expect(screen.getByRole("dialog", { name: P.addTitle })).toBeTruthy();
    expect(gets(calls, PROJECTS)).toBe(before);
  });

  it("a name refusal lands under the name field", async () => {
    stubApi({
      ...routes(cloud()),
      [`GET ${PROJECTS}/candidates`]: () =>
        json(200, { candidates: [], mode: "sandbox", base: "/workspace", supported: true }),
      [`POST ${PROJECTS}`]: () =>
        json(409, { error: { code: "device.project_name_taken", message: "taken" } }),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(within(await projectsSection()).getByRole("button", { name: P.add }));
    const dialog = await screen.findByRole("dialog", { name: P.addTitle });
    await user.type(within(dialog).getByRole("textbox", { name: P.pathLabel }), "api2");
    const name = within(dialog).getByRole("textbox", { name: new RegExp(`^${P.nameLabel}`) });
    await user.type(name, "api");
    await user.click(within(dialog).getByRole("button", { name: P.addSubmit }));
    expect(await within(dialog).findByText(en.errors.device.project_name_taken)).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
  });

  it("a validation refusal lands under the field its detail names, in the reader's language", async () => {
    let field = "name";
    stubApi({
      ...routes(cloud()),
      [`GET ${PROJECTS}/candidates`]: () =>
        json(200, { candidates: [], mode: "sandbox", base: "/workspace", supported: true }),
      [`POST ${PROJECTS}`]: () =>
        json(400, {
          error: {
            code: "validation_failed",
            message: "Request validation failed",
            details: [{ path: field, message: "server text" }],
          },
        }),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(within(await projectsSection()).getByRole("button", { name: P.add }));
    const dialog = await screen.findByRole("dialog", { name: P.addTitle });
    const path = within(dialog).getByRole("textbox", { name: P.pathLabel });
    const name = within(dialog).getByRole("textbox", { name: new RegExp(`^${P.nameLabel}`) });
    await user.type(path, "app");
    await user.type(name, "bad");
    await user.click(within(dialog).getByRole("button", { name: P.addSubmit }));
    expect(await within(dialog).findByText(en.errors.device.project_name_invalid)).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(path.getAttribute("aria-invalid")).not.toBe("true");
    field = "path";
    await user.click(within(dialog).getByRole("button", { name: P.addSubmit }));
    expect(
      await within(dialog).findByText(P.pathInvalid.replace("{prefix}", "workspace/")),
    ).toBeTruthy();
    expect(path.getAttribute("aria-invalid")).toBe("true");
    expect(within(dialog).queryByText("server text")).toBeNull();
  });

  it("an absolute path is hinted before submitting, and nothing is sent", async () => {
    const calls = stubApi({
      ...routes(cloud()),
      [`GET ${PROJECTS}/candidates`]: () =>
        json(200, { candidates: [], mode: "sandbox", base: "/workspace", supported: true }),
      [`POST ${PROJECTS}`]: () => json(201, { project: project("app", "/workspace/app") }),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(within(await projectsSection()).getByRole("button", { name: P.add }));
    const dialog = await screen.findByRole("dialog", { name: P.addTitle });
    const path = within(dialog).getByRole("textbox", { name: P.pathLabel });
    await user.type(path, "/workspace/app");
    const hint = P.pathAbsolute.replace("{prefix}", "workspace/");
    expect(await within(dialog).findByText(hint)).toBeTruthy();
    expect(path.getAttribute("aria-invalid")).toBe("true");
    await user.click(within(dialog).getByRole("button", { name: P.addSubmit }));
    await settle();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("a local device in auto mode shows the home as ~/", async () => {
    stubApi({
      ...routes(local(), projectList({ mode: "auto", base: "/Users/grant", projects: [] })),
      [`GET ${PROJECTS}/candidates`]: () =>
        json(200, { candidates: [], mode: "auto", base: "/Users/grant", supported: true }),
    });
    await renderDetail({ locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "设置" }));
    const section = (await screen.findByRole("region", {
      name: zh.devices.projects.title,
    })) as HTMLElement;
    await user.click(within(section).getByRole("button", { name: zh.devices.projects.add }));
    const dialog = await screen.findByRole("dialog", { name: zh.devices.projects.addTitle });
    expect(within(dialog).getByText("~/")).toBeTruthy();
  });

  it("a device without project support explains why and offers no form", async () => {
    stubApi(routes(local(), projectList({ projects: [], supported: false, mode: "auto" })));
    await renderDetail();
    await openSettings();
    const section = await projectsSection();
    expect(within(section).getByText(P.unsupportedLocal)).toBeTruthy();
    expect(within(section).queryByRole("button", { name: P.add })).toBeNull();
  });

  it("a cloud device without project support names its provider as the reason", async () => {
    stubApi(routes(cloud(), projectList({ projects: [], supported: false })));
    await renderDetail();
    await openSettings();
    const section = await projectsSection();
    expect(within(section).getByText(P.unsupportedCloud)).toBeTruthy();
    expect(within(section).queryByRole("button", { name: P.add })).toBeNull();
  });

  it("removing asks first, then deletes and invalidates the list", async () => {
    let removed = false;
    const calls = stubApi({
      ...routes(cloud()),
      [`GET ${PROJECTS}`]: () =>
        json(
          200,
          removed ? projectList({ projects: [project("web", "/workspace/web")] }) : projectList(),
        ),
      [`DELETE ${PROJECTS}/api`]: () => {
        removed = true;
        return new Response(null, { status: 204 });
      },
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(
      within(await projectsSection()).getByRole("button", { name: "Remove project api" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Remove project api?" });
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: P.removeSubmit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await vi.waitFor(() =>
      expect(within(screen.getByRole("region", { name: P.title })).queryByText("api")).toBeNull(),
    );
  });

  it("a projects read the kernel refuses draws nothing of the section", async () => {
    stubApi({
      ...routes(cloud()),
      [`GET ${PROJECTS}`]: () => json(404, { error: { code: "device.not_found", message: "no" } }),
    });
    await renderDetail();
    await openSettings();
    await settle();
    expect(screen.queryByRole("region", { name: P.title })).toBeNull();
  });
});
