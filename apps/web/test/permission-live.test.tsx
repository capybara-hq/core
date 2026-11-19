import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationPermission } from "../src/components/conversation/PermissionPicker";
import type { Conversation, ConversationEvent } from "../src/lib/conversations";
import type { ConversationPermissions } from "../src/lib/permissions";
import type { EventWindow } from "../src/lib/query/conversation";
import { keys } from "../src/lib/query/keys";
import { permissionWatermark, raisePermissionWatermark } from "../src/lib/query/permission-state";
import { permissionsQuery } from "../src/lib/query/permissions";
import { resetSession } from "../src/lib/query/workspace";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import {
  CONV,
  envView,
  FakeEventSource,
  permissionAvailability,
  permissionsView,
  snapshotDefaults,
} from "./support/conversation";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { pageElement, testQueryClient } from "./support/render";

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

const BASE = "/api/v1/orgs/o1/conversations";
const failed = () => json(500, { error: { code: "internal", message: "Database unavailable" } });

/** The page's routes for `id` (server prefetch and browser alike), with `view` as its owner read. */
const chatRoutes = (
  id: string,
  row: Record<string, unknown> = {},
  view: ConversationPermissions = permissionsView({ rootConversationId: id }),
  events: ConversationEvent[] = [],
) => ({
  ...snapshotDefaults(id),
  [`GET ${BASE}/${id}`]: () => json(200, CONV(id, row)),
  [`GET ${BASE}/${id}/events`]: () => json(200, { events }),
  [`GET ${BASE}/${id}/permissions`]: () => json(200, view),
});

const pickers = () => document.querySelector('[data-part="composer-pickers"]') as HTMLElement;
/** The editable permission button of the desktop composer (null while locked). */
const editable = () => within(pickers()).queryByRole("button", { name: /^Permissions: / });
/** The locked permission value of the desktop composer (null while editable). */
const locked = () =>
  pickers().querySelector<HTMLElement>(
    '[data-locked="true"][title], .cb-picker[data-locked="true"]',
  );
const lockedProfile = (text: string) =>
  [...pickers().querySelectorAll<HTMLElement>('[data-locked="true"]')].find(
    (e) => e.textContent === text,
  );
const reads = (calls: Call[], id = "c1") =>
  calls.filter((c) => c.method === "GET" && c.url === `${BASE}/${id}/permissions`);
const patches = (calls: Call[]) => calls.filter((c) => c.method === "PATCH");

const profileEvent = (seq: number, revision: number, newProfile = "request-approval") =>
  ({
    seq,
    runId: null,
    type: "permission_profile_changed",
    payload: {
      oldProfile: "approve-for-me",
      newProfile,
      actorAccountId: "a9",
      reason: "user",
      deviceId: null,
      scopeRevision: null,
      revision,
    },
    createdAt: "2026-11-16T10:00:00.000Z",
  }) as unknown as ConversationEvent;

async function choose(user: ReturnType<typeof userEvent.setup>, name: RegExp | string) {
  const button = await waitFor(() => {
    const b = editable();
    expect(b).not.toBeNull();
    return b as HTMLElement;
  });
  await user.click(button);
  await user.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name }));
}

describe("live profile change of an interactive root (Task 10D)", () => {
  it("PATCH sends expectedRevision and holds the revision watermark through a failed GET", async () => {
    const user = userEvent.setup();
    let after = 0;
    let patched = false;
    const calls = stubApi({
      ...chatRoutes("c1"),
      [`PATCH ${BASE}/c1/permissions`]: () => {
        patched = true;
        return json(200, { revision: 4 });
      },
      // the refresh after the write fails; the manual Refresh then reads revision 4
      [`GET ${BASE}/c1/permissions`]: () =>
        !patched
          ? json(200, permissionsView({ revision: 3 }))
          : ++after <= 2
            ? failed() // the app's one 5xx retry fails too
            : json(200, permissionsView({ profile: "request-approval", revision: 4 })),
    });
    const route = await renderRouteWithCache(
      "/chat/c1",
      chatRoutes("c1", {}, permissionsView({ revision: 3 })),
      { locale: "en" },
    );
    await choose(user, "Request approval");
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(bodyOf(patches(calls)[0])).toEqual({ profile: "request-approval", expectedRevision: 3 });
    // the refresh failed: the last confirmed value stays, locked and marked unconfirmed
    await screen.findByText(
      "Couldn't confirm the current permissions. The value shown is the last confirmed one.",
    );
    expect(editable()).toBeNull();
    expect(locked()?.textContent).toBe("Approve for me");
    expect(locked()?.getAttribute("title")).toBe(
      "Last confirmed permissions. Refreshing before they can change again.",
    );
    expect(route.client.getQueryData(permissionsQuery("o1", "c1").queryKey)).toMatchObject({
      revision: 3,
    });
    // nothing rolled back, nothing resent
    expect(patches(calls)).toHaveLength(1);
    expect(permissionWatermark(route.client, { accountId: "a1", orgId: "o1", rootId: "c1" })).toBe(
      4,
    );
    // Refresh only reads; revision 4 confirms the write and the editor returns
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(editable()?.getAttribute("aria-label")).toBe("Permissions: Request approval"),
    );
    expect(patches(calls)).toHaveLength(1);
    expect(after).toBe(3);
  });

  it("a later revision than the PATCH answer confirms too (no exact equality)", async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...chatRoutes("c1"),
      [`PATCH ${BASE}/c1/permissions`]: () => json(200, { revision: 4 }),
      [`GET ${BASE}/c1/permissions`]: () =>
        json(200, permissionsView({ profile: "full-access", revision: 6 })),
    });
    await renderRouteWithCache("/chat/c1", chatRoutes("c1", {}, permissionsView({ revision: 3 })), {
      locale: "en",
    });
    await choose(user, "Request approval");
    await waitFor(() =>
      expect(editable()?.getAttribute("aria-label")).toBe("Permissions: Full access"),
    );
    expect(patches(calls)).toHaveLength(1);
  });

  it("a 409 reads the state again, asks for a new choice and never resends", async () => {
    const user = userEvent.setup();
    let read = 0;
    const calls = stubApi({
      ...chatRoutes("c1"),
      [`PATCH ${BASE}/c1/permissions`]: () =>
        json(409, {
          error: { code: "conflict", message: "Permissions changed; refresh and retry" },
        }),
      [`GET ${BASE}/c1/permissions`]: () =>
        json(200, permissionsView({ profile: "approve-for-me", revision: 3 + ++read })),
    });
    await renderRouteWithCache("/chat/c1", chatRoutes("c1", {}, permissionsView({ revision: 3 })), {
      locale: "en",
    });
    await choose(user, "Request approval");
    await screen.findByText(
      "The permissions or their scope changed meanwhile. Check the current choice and choose again.",
    );
    await waitFor(() => expect(reads(calls).length).toBeGreaterThanOrEqual(1));
    await waitFor(() =>
      expect(editable()?.getAttribute("aria-label")).toBe("Permissions: Approve for me"),
    );
    expect(patches(calls)).toHaveLength(1);
  });

  it("Full access asks about the conversation's own device and scope, then PATCHes that consent", async () => {
    const user = userEvent.setup();
    const view = permissionsView({
      revision: 2,
      deviceId: "d1",
      scopeRevision: "scope-9",
      availability: permissionAvailability("supported"),
      outsideSandboxCeiling: true,
    });
    const device = {
      [`GET ${BASE}/c1/device`]: () => json(200, { device: envView("d1", "Build box") }),
    };
    const routes = { ...chatRoutes("c1", { deviceId: "d1" }, view), ...device };
    const calls = stubApi({
      ...routes,
      [`PATCH ${BASE}/c1/permissions`]: () =>
        json(409, { error: { code: "conflict", message: "Device authority changed" } }),
    });
    await renderRouteWithCache("/chat/c1", routes, { locale: "en" });
    await choose(user, /^Full access/);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Use Full access on Build box?")).toBeTruthy();
    // cancel changes nothing and sends nothing
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(patches(calls)).toHaveLength(0);
    await choose(user, /^Full access/);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Use Full access" }),
    );
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(bodyOf(patches(calls)[0])).toEqual({
      profile: "full-access",
      consentScopeRevision: "scope-9",
      expectedRevision: 2,
    });
    // a stale consent: read again; Full again needs the dialog again, nothing is resent
    await screen.findByText(
      "The permissions or their scope changed meanwhile. Check the current choice and choose again.",
    );
    await choose(user, /^Full access/);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(patches(calls)).toHaveLength(1);
  });

  it("a root profile event raises the watermark: a lower read keeps the editor locked", async () => {
    const held = deferred<Response>();
    let read = 0;
    const calls = stubApi({
      ...chatRoutes("c1"),
      [`GET ${BASE}/c1/permissions`]: () =>
        ++read === 1 ? json(200, permissionsView({ revision: 4 })) : held.promise,
    });
    const route = await renderRouteWithCache(
      "/chat/c1",
      chatRoutes("c1", {}, permissionsView({ revision: 3 })),
      { locale: "en" },
    );
    expect(editable()).not.toBeNull();
    const es = FakeEventSource.instances[0] as FakeEventSource;
    // the open's catch-up ends with an ordinary event (it reads the side data, before the change)
    act(() => es.emit("event", { ...profileEvent(1, 0), type: "run_started", payload: {} }));
    await waitFor(() => expect(read).toBe(1));
    read = 0;
    act(() => es.emit("event", profileEvent(2, 5)));
    // the event's revision 5 is required before the profile can change again
    await waitFor(() => expect(editable()).toBeNull());
    await waitFor(() => expect(read).toBe(1));
    await waitFor(() =>
      expect(route.client.getQueryData(permissionsQuery("o1", "c1").queryKey)).toMatchObject({
        revision: 4,
      }),
    );
    expect(editable()).toBeNull();
    // a read at revision 5 confirms it
    await act(async () => {
      void route.client.invalidateQueries({ queryKey: permissionsQuery("o1", "c1").queryKey });
    });
    await waitFor(() => expect(read).toBe(2));
    await act(async () =>
      held.resolve(json(200, permissionsView({ profile: "request-approval", revision: 5 }))),
    );
    await waitFor(() =>
      expect(editable()?.getAttribute("aria-label")).toBe("Permissions: Request approval"),
    );
    expect(patches(calls)).toHaveLength(0);
  });

  it("a slow read of a lower revision never replaces a newer cached view", async () => {
    const client = testQueryClient();
    const q = permissionsQuery("o1", "c1");
    client.setQueryData(q.queryKey, permissionsView({ profile: "full-access", revision: 6 }));
    stubApi({ [`GET ${BASE}/c1/permissions`]: () => json(200, permissionsView({ revision: 5 })) });
    await client.fetchQuery({ ...q, staleTime: 0 });
    expect(client.getQueryData(q.queryKey)).toEqual(
      permissionsView({ profile: "full-access", revision: 6 }),
    );
    // another root's view is never kept over the answer
    client.setQueryData(q.queryKey, permissionsView({ rootConversationId: "c0", revision: 9 }));
    await client.fetchQuery({ ...q, staleTime: 0 });
    expect(client.getQueryData(q.queryKey)).toEqual(permissionsView({ revision: 5 }));
  });
});

describe("fix round 1 (10D review minors)", () => {
  it("Minor 1: a PATCH without an answer is unconfirmed until a read started after it succeeds", async () => {
    const user = userEvent.setup();
    let patched = false;
    let after = 0;
    const late = deferred<Response>();
    const calls = stubApi({
      ...chatRoutes("c1"),
      [`PATCH ${BASE}/c1/permissions`]: () => {
        patched = true;
        return Promise.reject(new TypeError("Failed to fetch"));
      },
      [`GET ${BASE}/c1/permissions`]: () =>
        !patched
          ? json(200, permissionsView({ revision: 3 }))
          : ++after <= 2
            ? failed()
            : late.promise,
    });
    await renderRouteWithCache("/chat/c1", chatRoutes("c1", {}, permissionsView({ revision: 3 })), {
      locale: "en",
    });
    await choose(user, "Request approval");
    await screen.findByText(
      "No answer arrived, so the change may or may not have been saved. The value shown is the last confirmed one.",
    );
    expect(editable()).toBeNull();
    expect(locked()?.textContent).toBe("Approve for me");
    expect(locked()?.getAttribute("title")).toBe(
      "Last confirmed permissions. Refreshing before they can change again.",
    );
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await act(async () =>
      late.resolve(json(200, permissionsView({ profile: "request-approval", revision: 4 }))),
    );
    await waitFor(() =>
      expect(editable()?.getAttribute("aria-label")).toBe("Permissions: Request approval"),
    );
    expect(patches(calls)).toHaveLength(1);
  });

  it("Minor 2: a Full dialog closed by a newer revision never comes back by itself", async () => {
    const user = userEvent.setup();
    let read = 0;
    const view = (revision: number) =>
      permissionsView({
        revision,
        deviceId: "d1",
        scopeRevision: "scope-9",
        availability: permissionAvailability("supported"),
        outsideSandboxCeiling: true,
      });
    const routes = {
      ...chatRoutes("c1", { deviceId: "d1" }, view(2)),
      [`GET ${BASE}/c1/device`]: () => json(200, { device: envView("d1", "Build box") }),
    };
    const calls = stubApi({
      ...routes,
      [`GET ${BASE}/c1/permissions`]: () => json(200, view(++read < 2 ? 2 : 3)),
    });
    await renderRouteWithCache("/chat/c1", routes, { locale: "en" });
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => es.emit("event", { ...profileEvent(1, 0), type: "run_started", payload: {} }));
    await waitFor(() => expect(read).toBe(1));
    await choose(user, /^Full access/);
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => es.emit("event", profileEvent(2, 3, "approve-for-me")));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(read).toBe(2));
    await waitFor(() => expect(editable()).not.toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(patches(calls)).toHaveLength(0);
  });

  it("Minor 3: a PATCH also refreshes the sub-agent wait cards the root page shows", async () => {
    const user = userEvent.setup();
    const wait = {
      seq: 1,
      runId: "r1",
      type: "subagent_waiting",
      payload: {
        subagentId: "sa1",
        childRunId: "cr1",
        kind: "approval",
        approvalId: "ap2",
        toolKey: "Bash",
        requestedFor: "a1",
        approverRole: null,
      },
      createdAt: "2026-11-16T10:00:00.000Z",
    } as unknown as ConversationEvent;
    const approvalRoute = {
      "GET /api/v1/orgs/o1/approvals/ap2": () =>
        json(404, { error: { code: "approval.not_found", message: "Not found" } }),
    };
    const routes = {
      ...chatRoutes("c1", {}, permissionsView({ revision: 3 }), [wait]),
      ...approvalRoute,
    };
    const calls = stubApi({
      ...routes,
      [`PATCH ${BASE}/c1/permissions`]: () => json(200, { revision: 4 }),
      [`GET ${BASE}/c1/permissions`]: () =>
        json(200, permissionsView({ profile: "request-approval", revision: 4 })),
      "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [] }),
      "GET /api/v1/orgs/o1/inbox/count": () => json(200, { count: 0 }),
    });
    const route = await renderRouteWithCache("/chat/c1", routes, { locale: "en" });
    await act(async () => {});
    const waitReads = () => calls.filter((c) => c.url === "/api/v1/orgs/o1/approvals/ap2").length;
    const before = waitReads();
    await choose(user, "Request approval");
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    await waitFor(() => expect(waitReads()).toBeGreaterThan(before));
    expect(route.client.getQueryData(permissionsQuery("o1", "c1").queryKey)).toMatchObject({
      revision: 4,
    });
  });

  it("Minor 4: Full waits until the device's name is known", async () => {
    const user = userEvent.setup();
    const view = permissionsView({
      revision: 2,
      deviceId: "d1",
      scopeRevision: "scope-9",
      availability: permissionAvailability("supported"),
      outsideSandboxCeiling: true,
    });
    const routes = {
      ...chatRoutes("c1", { deviceId: "d1" }, view),
      // the bound device's read never answers
      [`GET ${BASE}/c1/device`]: () => new Promise<Response>(() => {}),
    };
    await renderRouteEmptyCache("/chat/c1", routes, { locale: "en" });
    const button = await waitFor(() => {
      const b = editable();
      expect(b).not.toBeNull();
      return b as HTMLElement;
    });
    await user.click(button);
    const full = within(screen.getByRole("menu")).getByRole("menuitemradio", {
      name: /^Full access/,
    });
    expect(full.getAttribute("aria-disabled")).toBe("true");
    expect(full.textContent).toContain("Checking this device…");
  });

  it("Minor 5: below the watermark with nothing in flight and no error, Refresh is offered", async () => {
    stubApi({ [`GET ${BASE}/c1/permissions`]: () => json(200, permissionsView({ revision: 3 })) });
    const client = testQueryClient();
    client.setQueryData(permissionsQuery("o1", "c1").queryKey, permissionsView({ revision: 3 }));
    raisePermissionWatermark(client, { accountId: "a1", orgId: "o1", rootId: "c1" }, 4);
    const row = CONV("c1").conversation as unknown as Conversation;
    render(pageElement(<Probe row={row} />, { client, locale: "en" }));
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByTestId("probe").textContent).toBe("locked:Approve for me");
  });
});

/** The hook alone, as a remounting composer uses it. */
function Probe({ row }: { row: Conversation }) {
  const p = useConversationPermission({
    orgId: "o1",
    conversationId: row.id,
    row,
    events: [],
    deviceLabel: "—",
  });
  return (
    <>
      <output data-testid="probe">
        {p.picker === undefined
          ? "none"
          : `${p.picker.locked ? "locked" : "editable"}:${p.picker.value}`}
      </output>
      {p.notice}
    </>
  );
}

describe("the watermark outlives remounts and ends with the session", () => {
  it("returning to a cached revision below the watermark stays locked; resetSession clears it", async () => {
    stubApi({ [`GET ${BASE}/c1/permissions`]: failed });
    const client = testQueryClient();
    const q = permissionsQuery("o1", "c1");
    client.setQueryData(q.queryKey, permissionsView({ revision: 3 }));
    const row = CONV("c1").conversation as unknown as Conversation;
    const scope = { accountId: "a1", orgId: "o1", rootId: "c1" };
    raisePermissionWatermark(client, scope, 4);
    const first = render(pageElement(<Probe row={row} />, { client, locale: "en" }));
    expect(screen.getByTestId("probe").textContent).toBe("locked:Approve for me");
    first.unmount();
    // back again: still below the watermark
    render(pageElement(<Probe row={row} />, { client, locale: "en" }));
    expect(screen.getByTestId("probe").textContent).toBe("locked:Approve for me");
    // a lower raise never lowers it
    raisePermissionWatermark(client, scope, 2);
    expect(permissionWatermark(client, scope)).toBe(4);
    await act(async () => {
      await resetSession(client, () => {});
    });
    expect(permissionWatermark(client, scope)).toBeUndefined();
  });
});

describe("an owner's child follows its root's profile (Important 1)", () => {
  const childRow = { parentConversationId: "c1" };
  const inherited = (over: Partial<ConversationPermissions> = {}) =>
    permissionsView({ rootConversationId: "c1", revision: 2, ...over });
  const childEvents = [
    {
      seq: 1,
      runId: null,
      type: "user_message",
      payload: { content: [{ type: "text", text: "task" }], authorAccountId: "a1" },
      createdAt: "2026-11-16T09:00:00.000Z",
    } as unknown as ConversationEvent,
  ];
  const rootStream = () =>
    FakeEventSource.instances.find((e) => e.url.includes("/conversations/c1/stream"));

  function mount(browserView: () => ConversationPermissions) {
    const calls = stubApi({
      ...chatRoutes("c2", childRow, inherited(), childEvents),
      [`GET ${BASE}/c2/permissions`]: () => json(200, browserView()),
      // the root's row only: its cursor, never its log
      [`GET ${BASE}/c1`]: () => json(200, CONV("c1", { lastSeq: 7 })),
    });
    return calls;
  }

  it("an idle child with no pending card updates from a root-only profile event", async () => {
    let current = inherited();
    const calls = mount(() => current);
    // the root changed between the server's read and the subscription
    current = inherited({ profile: "request-approval", revision: 3 });
    const route = await renderRouteWithCache(
      "/chat/c2",
      chatRoutes("c2", childRow, inherited(), childEvents),
      { locale: "en" },
    );
    await waitFor(() => expect(lockedProfile("Approve for me")).toBeTruthy());
    await waitFor(() => expect(rootStream()).toBeDefined());
    const es = rootStream() as FakeEventSource;
    expect(es.url).toContain("after=7");
    // the open itself reads the inherited view again: the race is closed without any event
    act(() => es.emit("open"));
    await waitFor(() => expect(lockedProfile("Request approval")).toBeTruthy());
    expect(reads(calls, "c2")).toHaveLength(1);
    expect(lockedProfile("Request approval")?.getAttribute("title")).toBe(
      "Follows the main conversation's permissions",
    );
    // only the root's profile changes: the child's label follows, nothing else happens
    current = inherited({ profile: "full-access", revision: 4 });
    act(() => es.emit("event", profileEvent(8, 4, "full-access")));
    await waitFor(() => expect(lockedProfile("Full access")).toBeTruthy());
    expect(reads(calls, "c2")).toHaveLength(2);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    // root events never enter the child's window, and the root's log is never read
    const window = route.client.getQueryData<EventWindow>(
      keys.org("o1").conversation("c2").events(),
    );
    expect(window?.events.map((e) => e.seq)).toEqual([1]);
    expect(route.client.getQueryData(keys.org("o1").conversation("c1").events())).toBeUndefined();
    expect(calls.filter((c) => c.url.startsWith(`${BASE}/c1/events`))).toEqual([]);
    // a repeated or older root seq changes nothing (cursor dedupe)
    act(() => es.emit("event", profileEvent(8, 4, "full-access")));
    act(() => es.emit("event", profileEvent(6, 1, "approve-for-me")));
    await act(async () => {});
    expect(reads(calls, "c2")).toHaveLength(2);
    expect(permissionWatermark(route.client, { accountId: "a1", orgId: "o1", rootId: "c1" })).toBe(
      4,
    );
    // other root events only advance the cursor
    act(() => es.emit("event", { ...childEvents[0], seq: 9 }));
    await act(async () => {});
    expect(reads(calls, "c2")).toHaveLength(2);
    // an automatic reconnect with nothing new still reads the view again
    current = inherited({ profile: "request-approval", revision: 5 });
    act(() => es.emit("open"));
    await waitFor(() => expect(lockedProfile("Request approval")).toBeTruthy());
    expect(reads(calls, "c2")).toHaveLength(3);
  });

  it("the browser giving up rechecks the root row and reopens from the retained cursor", async () => {
    const calls = mount(() => inherited());
    await renderRouteWithCache("/chat/c2", chatRoutes("c2", childRow, inherited(), childEvents), {
      locale: "en",
    });
    await waitFor(() => expect(rootStream()).toBeDefined());
    const first = rootStream() as FakeEventSource;
    act(() => first.emit("open"));
    act(() => first.emit("event", profileEvent(10, 3)));
    const rowReads = () => calls.filter((c) => c.url === `${BASE}/c1`).length;
    const before = rowReads();
    act(() => first.giveUp());
    await waitFor(() => expect(rowReads()).toBe(before + 1));
    await waitFor(() =>
      expect(
        FakeEventSource.instances.filter((e) => e.url.includes("/conversations/c1/stream")),
      ).toHaveLength(2),
    );
    const reopened = FakeEventSource.instances
      .filter((e) => e.url.includes("/conversations/c1/stream"))
      .at(-1) as FakeEventSource;
    expect(reopened.url).toContain("after=10");
  });

  it("unmount during the recovery's root row read never reopens the stream", async () => {
    let rowRead = 0;
    const held = deferred<Response>();
    stubApi({
      ...chatRoutes("c2", childRow, inherited(), childEvents),
      [`GET ${BASE}/c1`]: () =>
        ++rowRead === 1 ? json(200, CONV("c1", { lastSeq: 7 })) : held.promise,
    });
    const route = await renderRouteWithCache(
      "/chat/c2",
      chatRoutes("c2", childRow, inherited(), childEvents),
      { locale: "en" },
    );
    await waitFor(() => expect(rootStream()).toBeDefined());
    act(() => (rootStream() as FakeEventSource).giveUp());
    await waitFor(() => expect(rowRead).toBe(2));
    route.unmount();
    await act(async () => held.resolve(json(200, CONV("c1", { lastSeq: 7 }))));
    expect(
      FakeEventSource.instances.filter((e) => e.url.includes("/conversations/c1/stream")),
    ).toHaveLength(1);
  });

  it("a server error frame stops the subscription; unmount closes it and ignores late events", async () => {
    const calls = mount(() => inherited());
    const route = await renderRouteWithCache(
      "/chat/c2",
      chatRoutes("c2", childRow, inherited(), childEvents),
      { locale: "en" },
    );
    await waitFor(() => expect(rootStream()).toBeDefined());
    const es = rootStream() as FakeEventSource;
    act(() => es.emit("error", { code: "auth.session_revoked" }));
    await act(async () => {});
    expect(
      FakeEventSource.instances.filter((e) => e.url.includes("/conversations/c1/stream")),
    ).toHaveLength(1);
    expect(es.readyState).toBe(2);
    route.unmount();
    const readsBefore = reads(calls, "c2").length;
    act(() => es.emit("event", profileEvent(20, 9)));
    act(() => es.emit("open"));
    await act(async () => {});
    expect(reads(calls, "c2")).toHaveLength(readsBefore);
    expect(
      permissionWatermark(route.client, { accountId: "a1", orgId: "o1", rootId: "c1" }),
    ).toBeUndefined();
  });

  it("unmount closes the open root stream", async () => {
    mount(() => inherited());
    const route = await renderRouteWithCache(
      "/chat/c2",
      chatRoutes("c2", childRow, inherited(), childEvents),
      { locale: "en" },
    );
    await waitFor(() => expect(rootStream()).toBeDefined());
    const es = rootStream() as FakeEventSource;
    expect(es.readyState).toBe(1);
    route.unmount();
    expect(es.readyState).toBe(2);
  });

  it("a shared viewer of a child reads no owner view, no root row and opens no root stream", async () => {
    const viewerRow = { parentConversationId: "c1", accountId: "someone-else" };
    const calls = stubApi(chatRoutes("c2", viewerRow, inherited(), childEvents));
    const route = await renderRouteWithCache(
      "/chat/c2",
      chatRoutes("c2", viewerRow, inherited(), childEvents),
      { locale: "en" },
    );
    await act(async () => {});
    expect(FakeEventSource.instances.map((e) => e.url)).toEqual([
      expect.stringContaining("/conversations/c2/stream"),
    ]);
    expect(calls.filter((c) => c.url.endsWith("/permissions"))).toEqual([]);
    expect(route.calls.filter((c) => c.url.endsWith("/permissions"))).toEqual([]);
    expect(calls.filter((c) => c.url === `${BASE}/c1`)).toEqual([]);
  });

  it("a root opens no second subscription of its own", async () => {
    stubApi(chatRoutes("c1"));
    await renderRouteWithCache("/chat/c1", chatRoutes("c1"), { locale: "en" });
    await act(async () => {});
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("a child stays locked for its owner (inherited, never PATCHed)", async () => {
    stubApi(chatRoutes("c2", childRow, inherited(), childEvents));
    await renderRouteWithCache("/chat/c2", chatRoutes("c2", childRow, inherited(), childEvents), {
      locale: "en",
    });
    await waitFor(() => expect(lockedProfile("Approve for me")).toBeTruthy());
    expect(editable()).toBeNull();
  });
});

describe("the root row the child reads is the owner's root (cursor bootstrap)", () => {
  it("bootstraps the cursor from the root row without reading its log", async () => {
    const calls = stubApi({
      ...chatRoutes(
        "c2",
        { parentConversationId: "c1" },
        permissionsView({ rootConversationId: "c1" }),
      ),
      [`GET ${BASE}/c1`]: () => json(200, CONV("c1", { lastSeq: 42 })),
    });
    await renderRouteWithCache(
      "/chat/c2",
      chatRoutes(
        "c2",
        { parentConversationId: "c1" },
        permissionsView({ rootConversationId: "c1" }),
      ),
      { locale: "en" },
    );
    await waitFor(() =>
      expect(
        FakeEventSource.instances.find((e) => e.url.includes("/conversations/c1/stream"))?.url,
      ).toContain("after=42"),
    );
    expect(calls.filter((c) => c.url.includes("/c1/events"))).toEqual([]);
  });
});
