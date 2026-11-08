// The device confirmation page `/device` (environments spec §6.2, §13.3): `capybara-device login`
// opens `/device?code=XXXX-XXXX`; the signed-in person compares the code with the terminal, picks
// the org and a new or existing connected environment, reads the disclosure and confirms or denies.
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderAuthRouteWithCache, renderRouteEmptyCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const CODE = "BCDF-GHJK";
const PAGE = `/device?code=${CODE}`;
const PENDING = `/api/v1/device/pending/${CODE}`;
const ENVS = "/api/v1/orgs/o1/environments";
const D = en.device;
const msgs = { zh, en } as const;

const MACHINE = { name: "grant-mbp", os: "darwin", arch: "arm64", programVersion: "0.1.0" };
const LIMITS = { cpu: 2, memoryMb: 2048, diskMb: 10240, egress: "allowlist", allowHosts: [] };
const env = (id: string, name: string | null, over: Record<string, unknown> = {}) => ({
  id,
  name,
  isDefault: name === null,
  ownerKind: "personal",
  source: "cloud",
  provider: "sandbox-docker",
  available: true,
  online: null,
  machine: null,
  sessionIsolation: false,
  filesLost: false,
  instance: null,
  limits: LIMITS,
  createdAt: "2026-11-07T08:00:00.000Z",
  ...over,
});
const LIST = {
  items: [
    env("e1", null),
    env("d1", "Old laptop", { source: "device", provider: "@device", online: false }),
  ],
  defaultId: "e1",
  lastUsedId: null,
  cloudAvailable: true,
};
const ROUTES: Routes = {
  "GET /api/v1/me": () => json(200, ME),
  [`GET ${PENDING}`]: () => json(200, { machine: MACHINE, expiresAt: "2026-11-08T08:10:00.000Z" }),
  [`GET ${ENVS}`]: () => json(200, LIST),
};
const unauthenticated = () => json(401, { error: { code: "auth.required", message: "x" } });
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));

beforeEach(() => resetNavigation("/device"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/device", () => {
  it.each(["zh", "en"] as const)(
    "device page shows the code and the disclosure and confirms into a new environment (%s)",
    async (locale) => {
      const m = msgs[locale].device;
      const calls = stubApi({
        ...ROUTES,
        "POST /api/v1/device/confirm": () => json(200, { environmentId: "d9" }),
      });
      const { container } = await renderAuthRouteWithCache(PAGE, lastStubRoutes(), { locale });
      expect(container.querySelector('[data-template="AuthPage"]')).not.toBeNull();
      expect(await screen.findByText(CODE)).toBeTruthy();
      expect(screen.getByText("grant-mbp")).toBeTruthy();
      expect(screen.getByText("macOS · arm64")).toBeTruthy();
      expect(screen.getByText("v0.1.0")).toBeTruthy();
      expect(within(screen.getByRole("note")).getByText(m.disclosure)).toBeTruthy();
      // the new environment's name defaults to the machine's
      expect(screen.getByRole("textbox", { name: m.name })).toHaveProperty("value", "grant-mbp");
      // nothing is sent before the person confirms
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
      const confirm = screen.getByRole("button", { name: m.confirm });
      expect(confirm.getAttribute("data-variant")).toBe("primary");
      await userEvent.setup().click(confirm);
      expect(await screen.findByText(m.doneTitle)).toBeTruthy();
      const post = calls.find((c) => c.method === "POST");
      expect(post?.url).toBe("/api/v1/device/confirm");
      expect(post?.headers.get("x-capybara-csrf")).toBe("1");
      expect(bodyOf(post)).toEqual({ userCode: CODE, orgId: "o1", name: "grant-mbp" });
    },
  );

  it("confirms into an existing connected environment of the org", async () => {
    const calls = stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": () => json(200, { environmentId: "d1" }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    const user = userEvent.setup();
    const target = await screen.findByRole("combobox", { name: D.environment });
    await user.click(target);
    await user.click(await screen.findByRole("option", { name: "Old laptop" }));
    // an existing environment keeps its own name: no name field
    expect(screen.queryByRole("textbox", { name: D.name })).toBeNull();
    await user.click(screen.getByRole("button", { name: D.confirm }));
    expect(await screen.findByText(D.doneTitle)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      userCode: CODE,
      orgId: "o1",
      environmentId: "d1",
    });
    // the environment is in the current org: the done state opens its page
    await user.click(screen.getByRole("button", { name: D.openEnvironment }));
    expect(router.replace).toHaveBeenCalledWith("/environments/d1");
  });

  it("an unnamed connected environment is labelled like everywhere else (environmentName)", async () => {
    stubApi({
      ...ROUTES,
      [`GET ${ENVS}`]: () =>
        json(200, {
          ...LIST,
          items: [
            ...LIST.items,
            env("d2", null, {
              isDefault: false,
              source: "device",
              provider: "@device",
              online: false,
              demotedFrom: { provider: "sandbox-docker", displayName: null, ordinal: 2 },
            }),
          ],
        }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: D.environment }));
    expect(await screen.findByRole("option", { name: "Personal (sandbox-docker) 2" })).toBeTruthy();
  });

  it("confirming invalidates the org's environments", async () => {
    const calls = stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": () => json(200, { environmentId: "d9" }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.confirm }));
    expect(await screen.findByText(D.doneTitle)).toBeTruthy();
    // the list was read again after the POST (invalidated while the form observed it)
    await vi.waitFor(() => {
      const names = calls.map((c) => `${c.method} ${c.url}`);
      expect(names.slice(names.indexOf("POST /api/v1/device/confirm"))).toContain(`GET ${ENVS}`);
    });
  });

  it("device page shows the expired state for an unknown code", async () => {
    stubApi({
      ...ROUTES,
      [`GET ${PENDING}`]: () =>
        json(404, { error: { code: "device.code_invalid", message: "unknown" } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    expect(await screen.findByText(D.invalidTitle)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(en.errors.device.code_invalid);
    expect(screen.getByText(D.invalidHint)).toBeTruthy();
    expect(screen.queryByRole("button", { name: D.confirm })).toBeNull();
  });

  it("a confirm the kernel could not hand over shows the start-over state", async () => {
    stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": () =>
        json(503, { error: { code: "device.unavailable", message: "x" } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.confirm }));
    expect(await screen.findByText(D.invalidTitle)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(en.errors.device.unavailable);
  });

  it("a refused confirm (limit reached) stays on the page with the error copy", async () => {
    stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": () =>
        json(409, { error: { code: "environment.limit_reached", message: "x" } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.confirm }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      en.errors.environment.limit_reached,
    );
    expect(screen.getByRole("button", { name: D.confirm })).toBeTruthy();
  });

  it("deny refuses the code and says so", async () => {
    const calls = stubApi({ ...ROUTES, "POST /api/v1/device/deny": () => noContent() });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.deny }));
    expect(await screen.findByText(D.deniedTitle)).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/v1/device/deny");
    expect(bodyOf(post)).toEqual({ userCode: CODE });
  });

  it("a confirm that finds the session gone signs in again, back here", async () => {
    stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": unauthenticated,
      "POST /api/v1/auth/refresh": unauthenticated,
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.confirm }));
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(`/login?returnTo=${encodeURIComponent(PAGE)}`),
    );
  });

  it("without a code the page asks for the one shown in the terminal", async () => {
    stubApi(ROUTES);
    await renderAuthRouteWithCache("/device", lastStubRoutes());
    const user = userEvent.setup();
    const field = await screen.findByRole("textbox", { name: D.code });
    const next = screen.getByRole("button", { name: D.continue });
    expect(next).toHaveProperty("disabled", true);
    await user.type(field, " bcdf-ghjk ");
    await user.click(next);
    expect(router.replace).toHaveBeenCalledWith(`/device?code=${CODE}`);
  });

  it("/device: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderAuthRouteWithCache(PAGE, ROUTES);
    expect(screen.getByText(CODE)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/device: an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache(PAGE, {
      ...ROUTES,
      [`GET ${PENDING}`]: async (c) => {
        await gate;
        return (ROUTES[`GET ${PENDING}`] as NonNullable<Routes[string]>)(c);
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-template="AuthPage"]')).not.toBeNull(),
    );
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("grant-mbp")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("grant-mbp")).toBeTruthy();
  });
});
