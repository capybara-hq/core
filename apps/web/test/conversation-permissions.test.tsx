import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConversationPermissions,
  getPermissionPreview,
  setConversationPermissions,
} from "../src/lib/permissions";
import { seedNewConversation } from "../src/lib/query/conversation";
import { keys } from "../src/lib/query/keys";
import { permissionPreviewQuery, permissionsQuery } from "../src/lib/query/permissions";
import { resetSession } from "../src/lib/query/workspace";
import { bodyOf, json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  DEVICES,
  FakeEventSource,
  LIMITS,
  MODELS,
  noProjects,
  permissionAvailability,
  permissionPreview,
  permissionsView,
  snapshotDefaults,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache, testQueryClient } from "./support/query";
import { expectNoFirstPaintFetch } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
beforeEach(() => {
  resetNavigation("/");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const base = "/api/v1/orgs/org%2Fspace/conversations/chat%3Fone/permissions";
describe("permission HTTP contracts", () => {
  it("encodes owner GET and returns the direct view", async () => {
    const view = permissionsView({ rootConversationId: "root", revision: 0 });
    const calls = stubApi({ [`GET ${base}`]: () => json(200, view) });
    expect(await getConversationPermissions("org/space", "chat?one")).toEqual(view);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([["GET", base, undefined]]);
  });

  it.each([
    { profile: "request-approval" as const, expectedRevision: 0 },
    { profile: "approve-for-me" as const, expectedRevision: 3 },
    { profile: "full-access" as const, expectedRevision: 4 },
    {
      profile: "full-access" as const,
      expectedRevision: 5,
      consentScopeRevision: "displayed-scope",
    },
  ])("PATCH preserves the supplied selection and returns only revision: $profile", async (body) => {
    const calls = stubApi({ [`PATCH ${base}`]: () => json(200, { revision: 6 }) });
    const result = await setConversationPermissions("org/space", "chat?one", body);
    expect(bodyOf(calls[0])).toEqual(body);
    expect(calls.map((c) => [c.method, c.url])).toEqual([["PATCH", base]]);
    expect(result).toEqual({ revision: 6 });
    expect(result).not.toHaveProperty("profile");
    expect(calls[0]?.headers.get("X-Capybara-Csrf")).toBe("1");
  });

  it("encodes selected device and project preview without adding scope fields", async () => {
    const view = permissionPreview({ deviceId: "device/one", project: "reports & notes" });
    const url =
      "/api/v1/orgs/org%2Fspace/conversation-permission-preview?deviceId=device%2Fone&project=reports+%26+notes";
    const calls = stubApi({ [`GET ${url}`]: () => json(200, view) });
    expect(await getPermissionPreview("org/space", "device/one", "reports & notes")).toEqual(view);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([["GET", url, undefined]]);
  });

  it("omits project in free mode", async () => {
    const url = "/api/v1/orgs/o1/conversation-permission-preview?deviceId=d1";
    const calls = stubApi({ [`GET ${url}`]: () => json(200, permissionPreview()) });
    await getPermissionPreview("o1", "d1");
    expect(calls[0]?.url).toBe(url);
  });

  it("forwards cancellation to all three HTTP operations", async () => {
    stubApi({
      [`GET ${base}`]: () => json(200, permissionsView()),
      [`PATCH ${base}`]: () => json(200, { revision: 1 }),
      "GET /api/v1/orgs/org%2Fspace/conversation-permission-preview?deviceId=d1": () =>
        json(200, permissionPreview()),
    });
    const signal = new AbortController().signal;
    await getConversationPermissions("org/space", "chat?one", signal);
    await setConversationPermissions(
      "org/space",
      "chat?one",
      { profile: "approve-for-me", expectedRevision: 0 },
      signal,
    );
    await getPermissionPreview("org/space", "d1", undefined, signal);
    for (const [, init] of vi.mocked(fetch).mock.calls) expect(init?.signal).toBe(signal);
  });
});

const homeRoutes = (devices: unknown = DEVICES) => ({
  "GET /api/v1/orgs/o1/conversations/groups": () => json(200, { groups: [] }),
  "GET /api/v1/orgs/o1/agents": () => json(200, AGENTS),
  "GET /api/v1/orgs/o1/models": () => json(200, MODELS),
  "GET /api/v1/orgs/o1/attachments/limits": () => json(200, LIMITS),
  "GET /api/v1/orgs/o1/devices": () => json(200, devices),
  ...noProjects(),
});

describe("permission query foundation", () => {
  it("separates org, conversation, device and project and keeps previews below their explicit prefix", () => {
    expect(permissionsQuery("o1", "c1").queryKey).toEqual([
      "org",
      "o1",
      "conversation",
      "c1",
      "permissions",
    ]);
    expect(permissionPreviewQuery("o1", "d1", "notes").queryKey).toEqual([
      "org",
      "o1",
      "device",
      "d1",
      "permissionPreview",
      "notes",
    ]);
    expect(keys.org("o1").permissionPreviewAll("d1")).toEqual([
      "org",
      "o1",
      "device",
      "d1",
      "permissionPreview",
    ]);
    const variants = [
      permissionPreviewQuery("o1", "d1"),
      permissionPreviewQuery("o2", "d1"),
      permissionPreviewQuery("o1", "d2"),
      permissionPreviewQuery("o1", "d1", "notes"),
    ];
    expect(new Set(variants.map((q) => JSON.stringify(q.queryKey))).size).toBe(4);
  });

  it("prefetches only the selected usable device after its projects, with no browser first-paint read", async () => {
    const browser = expectNoFirstPaintFetch();
    const view = permissionPreview({ deviceId: "e2" });
    const result = await renderRouteWithCache(
      "/",
      {
        ...homeRoutes({ ...DEVICES, lastUsedId: "e2" }),
        "GET /api/v1/orgs/o1/conversation-permission-preview?deviceId=e2": () => json(200, view),
      },
      { locale: "en" },
    );
    const urls = result.calls.map((c) => c.url);
    expect(urls.filter((u) => u.includes("permission-preview"))).toEqual([
      "/api/v1/orgs/o1/conversation-permission-preview?deviceId=e2",
    ]);
    expect(urls.indexOf("/api/v1/orgs/o1/devices/e2/projects")).toBeLessThan(
      urls.indexOf("/api/v1/orgs/o1/conversation-permission-preview?deviceId=e2"),
    );
    expect(result.client.getQueryData(permissionPreviewQuery("o1", "e2").queryKey)).toEqual(view);
    render(
      <QueryClientProvider client={result.client}>
        <PreviewRead deviceId="e2" />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("preview-read").textContent).toBe("success:e2");
    expect(browser).toEqual([]);
    expect(result.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it.each([
    { ...DEVICES, items: [], defaultId: null, cloudAvailable: false },
    {
      ...DEVICES,
      items: DEVICES.items.map((d) => ({ ...d, source: "local", available: false, online: false })),
      cloudAvailable: false,
    },
  ])("no selected usable device means no preview or provision", async (devices) => {
    const browser = expectNoFirstPaintFetch();
    const result = await renderRouteWithCache("/", homeRoutes(devices), { locale: "en" });
    expect(
      result.calls.filter((c) => c.url.includes("permission-preview") || c.method !== "GET"),
    ).toEqual([]);
    expect(browser).toEqual([]);
  });

  it("existing session reset removes both owner views and device previews before navigation", async () => {
    const client = testQueryClient();
    client.setQueryData(permissionsQuery("o1", "c1").queryKey, permissionsView());
    client.setQueryData(permissionPreviewQuery("o1", "d1").queryKey, permissionPreview());
    let navigated = false;
    await resetSession(client, () => {
      expect(client.getQueryCache().getAll()).toEqual([]);
      navigated = true;
    });
    expect(navigated).toBe(true);
  });

  it("first-send cache seeding leaves permissions unknown", () => {
    const client = testQueryClient();
    seedNewConversation(client, "o1", CONV().conversation, {
      event: userMsg(1, "hi"),
      events: [userMsg(1, "hi")],
    });
    expect(client.getQueryData(permissionsQuery("o1", "c1").queryKey)).toBeUndefined();
  });
});

/** Query-only observer beside the page's read-only owner picker (no editing control is mounted). */
function PermissionRead({ id = "c1" }: { id?: string }) {
  const q = useQuery(permissionsQuery("o1", id));
  return (
    <p data-testid="permission-read">
      {q.status}:{q.data?.revision ?? "unknown"}
    </p>
  );
}

function PreviewRead({ deviceId }: { deviceId: string }) {
  const q = useQuery(permissionPreviewQuery("o1", deviceId));
  return (
    <p data-testid="preview-read">
      {q.status}:{q.data?.deviceId ?? "unknown"}
    </p>
  );
}

const chatRoutes = () => ({
  ...snapshotDefaults(),
  "GET /api/v1/orgs/o1/conversations/c1": () => json(200, CONV()),
  "GET /api/v1/orgs/o1/conversations/c1/events": () => json(200, { events: [] }),
});

describe("permission query lifecycle without activating product UI", () => {
  it("mounting an owner observer reads the hydrated direct view without a first-paint fetch", async () => {
    const browser = expectNoFirstPaintFetch();
    const route = await renderRouteWithCache("/chat/c1", chatRoutes(), { locale: "en" });
    render(
      <QueryClientProvider client={route.client}>
        <PermissionRead />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("permission-read").textContent).toBe("success:0");
    expect(route.calls.filter((c) => c.url.endsWith("/permissions"))).toHaveLength(1);
    expect(browser).toEqual([]);
  });

  it("keeps an uncached read pending and exposes failure without fabricating a profile", async () => {
    const held = deferred<Response>();
    const route = await renderRouteEmptyCache("/chat/c1", {
      ...chatRoutes(),
      "GET /api/v1/orgs/o1/conversations/c1/permissions": () => held.promise,
    });
    const probe = render(
      <QueryClientProvider client={route.client}>
        <PermissionRead />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("permission-read").textContent).toBe("pending:unknown");
    await waitFor(() =>
      expect(route.calls.filter((c) => c.url.endsWith("/permissions"))).toHaveLength(1),
    );
    await act(async () =>
      held.resolve(json(403, { error: { code: "forbidden", message: "Not permitted" } })),
    );
    await waitFor(() =>
      expect(screen.getByTestId("permission-read").textContent).toBe("error:unknown"),
    );
    expect(route.client.getQueryData(permissionsQuery("o1", "c1").queryKey)).toBeUndefined();
    probe.unmount();
  });

  it("retains only the last authoritative view when a refresh fails", async () => {
    const route = await renderRouteEmptyCache("/chat/c1", {
      ...chatRoutes(),
      "GET /api/v1/orgs/o1/conversations/c1/permissions": () =>
        json(403, { error: { code: "forbidden", message: "No access" } }),
    });
    const q = permissionsQuery("o1", "c1");
    route.client.setQueryData(q.queryKey, permissionsView({ revision: 4 }));
    render(
      <QueryClientProvider client={route.client}>
        <PermissionRead />
      </QueryClientProvider>,
    );
    await act(async () => {
      await route.client.invalidateQueries({ queryKey: q.queryKey });
    });
    await waitFor(() => expect(screen.getByTestId("permission-read").textContent).toBe("error:4"));
    // the page's own read-only owner picker read once on mount (empty cache), the refresh once
    expect(route.calls.filter((c) => c.url.endsWith("/permissions"))).toHaveLength(2);
    expect(route.client.getQueryData(q.queryKey)).toEqual(permissionsView({ revision: 4 }));
  });

  it("cancels the obsolete first read before replacing it with a fresh authoritative read", async () => {
    const old = deferred<Response>();
    let read = 0;
    const route = await renderRouteEmptyCache("/chat/c1", {
      ...chatRoutes(),
      "GET /api/v1/orgs/o1/conversations/c1/permissions": () =>
        ++read === 1 ? old.promise : Promise.resolve(json(200, permissionsView({ revision: 2 }))),
    });
    render(
      <QueryClientProvider client={route.client}>
        <PermissionRead />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(read).toBe(1));
    const firstSignal = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).endsWith("/permissions"))?.[1]?.signal;
    const q = permissionsQuery("o1", "c1");
    await act(async () => {
      await route.client.cancelQueries({ queryKey: q.queryKey });
      await route.client.invalidateQueries({ queryKey: q.queryKey });
    });
    expect(firstSignal?.aborted).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId("permission-read").textContent).toBe("success:2"),
    );
    await act(async () => old.resolve(json(200, permissionsView({ revision: 1 }))));
    expect(route.client.getQueryData(q.queryKey)).toEqual(permissionsView({ revision: 2 }));
    expect(read).toBe(2);
  });

  it("forwards preview query cancellation to its HTTP read", async () => {
    const held = deferred<Response>();
    stubApi({
      "GET /api/v1/orgs/o1/conversation-permission-preview?deviceId=d1&project=notes": () =>
        held.promise,
    });
    const client = testQueryClient();
    const q = permissionPreviewQuery("o1", "d1", "notes");
    const pending = client.fetchQuery(q).catch((e: unknown) => e);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls).toHaveLength(1));
    const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
    await client.cancelQueries({ queryKey: q.queryKey });
    expect(signal?.aborted).toBe(true);
    held.resolve(json(200, permissionPreview()));
    await pending;
    expect(client.getQueryData(q.queryKey)).toBeUndefined();
  });

  it.each([
    permissionAvailability("supported"),
    permissionAvailability("unprobed"),
    permissionAvailability("unsupported"),
    {
      state: "supported" as const,
      report: {
        version: 1 as const,
        restricted: null,
        fullAccess: false,
        background: false,
        unavailableReason: "Runtime unavailable",
      },
    },
  ])(
    "preserves the actual availability facts $state independently from the ceiling",
    async (availability) => {
      const view = permissionPreview({ availability, fullAccessCeiling: false });
      stubApi({
        "GET /api/v1/orgs/o1/conversation-permission-preview?deviceId=d1": () => json(200, view),
      });
      const result = await testQueryClient().fetchQuery(permissionPreviewQuery("o1", "d1"));
      expect(result).toEqual(view);
      expect(result).not.toHaveProperty("reviewerConfigured");
    },
  );
});
