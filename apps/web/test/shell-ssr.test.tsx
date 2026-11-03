// web-SSR spec §3–§5: the server-rendered shell. AppFrame paints from the layout's props (no browser
// read on mount), session changes go through router.refresh() in a transition, the setup frame
// carries the steps in its sidebar, and the kernel-starting and error frames retry by themselves.
import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { act, cleanup, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import ErrorPage from "../src/app/(app)/error";
import { SessionGuard } from "../src/components/SessionGuard";
import { KernelStarting } from "../src/components/shell/KernelStarting";
import { ApiClientError } from "../src/lib/api";
import { navigateBrowser } from "../src/lib/browser";
import { keys } from "../src/lib/query/keys";
import { conversationGroupsQuery, inboxCountQuery } from "../src/lib/query/shell";
import type { Me } from "../src/lib/session";
import { broadcastSession, useSessionSync } from "../src/lib/session-sync";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { Link, pathname, resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch } from "./support/server";
import {
  frameElement,
  NOT_READY,
  PROVIDER_ONLY,
  READY,
  renderFrame,
  shellOf,
} from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));

const sl = zh.setupLayout;
const setupPage = () => document.querySelector('[data-template="SetupPage"]');
const workSidebar = () => document.querySelector('[data-part="sidebar"][data-context="work"]');
const chooser = () => document.querySelector('[data-template="AuthPage"]');
const twoOrgs: Me = {
  ...ME,
  memberships: [...ME.memberships, { orgId: "o2", slug: "beta", name: "Beta", role: "member" }],
};
const as = (role: string, enterprise = false): Me => ({
  ...ME,
  account: { ...ME.account, isEnterpriseAdmin: enterprise },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

beforeEach(() => {
  resetNavigation("/");
  vi.mocked(navigateBrowser).mockReset();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("first paint from the layout's props", () => {
  it("a ready org: the shell, with the seeded conversations and pending count, and no browser read", async () => {
    const calls = expectNoFirstPaintFetch();
    renderFrame(
      shellOf(ME, {
        groups: {
          groups: [
            {
              agent: { id: "a1", name: "研究助手" },
              latestAt: "2026-10-20T06:32:00.000Z",
              conversations: [],
              more: false,
            },
          ],
          next: null,
          archivedCount: 0,
        },
        pending: { count: 2, more: false },
      }),
    );
    expect(screen.getByText("page body")).toBeTruthy();
    expect(workSidebar()).not.toBeNull();
    expect(screen.getByRole("button", { name: "研究助手" })).toBeTruthy();
    expect(screen.getByRole("link", { name: `${zh.nav.inbox}，2 项待处理` })).toBeTruthy();
    expect(document.querySelector('[data-part="pending-state"]')).toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls).toEqual([]);
  });

  it("an org that is not ready: the setup frame on /, never the shell", async () => {
    const calls = expectNoFirstPaintFetch();
    renderFrame(shellOf(ME, { readiness: NOT_READY }));
    expect(setupPage()).not.toBeNull();
    expect(workSidebar()).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: zh.chat.setup.title })).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls).toEqual([]);
  });

  it("no current org: the chooser", async () => {
    const calls = expectNoFirstPaintFetch();
    renderFrame(shellOf({ ...ME, currentOrgId: null }));
    expect(chooser()).not.toBeNull();
    expect(screen.getByRole("heading", { name: zh.orgChooser.title })).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls).toEqual([]);
  });

  it("the server render is the frame itself, not a neutral state", () => {
    const html = renderToString(frameElement(shellOf(ME)));
    expect(html).toContain('data-part="sidebar"');
    expect(html).toContain("page body");
    expect(html).not.toContain('data-part="pending-state"');
    const setup = renderToString(frameElement(shellOf(ME, { readiness: NOT_READY })));
    expect(setup).toContain('data-template="SetupPage"');
  });

  it("new props from the server replace the frame (router.refresh)", () => {
    const view = renderFrame(shellOf(ME, { readiness: NOT_READY }));
    expect(setupPage()).not.toBeNull();
    view.update(shellOf(ME));
    expect(setupPage()).toBeNull();
    expect(screen.getByText("page body")).toBeTruthy();
  });
});

/** A BroadcastChannel that records what this tab posts. */
function fakeChannel(): unknown[] {
  const posted: unknown[] = [];
  class FakeChannel {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage(m: unknown) {
      posted.push(m);
    }
    close() {}
  }
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  return posted;
}

describe("session-changing actions", () => {
  it("switching org: PUT, a broadcast, then a full navigation to /; the old page stays meanwhile (ruling R4)", async () => {
    const posted = fakeChannel();
    const calls = stubApi({ "PUT /api/v1/me/current-org": () => noContent() });
    const view = renderFrame(shellOf(twoOrgs));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "当前组织：Acme，切换组织" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Beta" }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/"));
    expect(router.push).not.toHaveBeenCalled();
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ orgId: "o2" });
    expect(posted).toEqual([expect.objectContaining({ kind: "org-switched" })]);
    // no client navigation, no /me read; the old org's page and shell stay until the unload
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
    expect(screen.getByText("page body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "当前组织：Acme，切换组织" })).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
    // the new document
    view.update(shellOf({ ...twoOrgs, currentOrgId: "o2" }));
    expect(screen.getByRole("button", { name: "当前组织：Beta，切换组织" })).toBeTruthy();
  });

  it("creating an org from the chooser: the dialog stays pending until the new document, which is the setup frame", async () => {
    const none: Me = { ...ME, currentOrgId: null, memberships: [] };
    const calls = stubApi({
      "POST /api/v1/orgs": () =>
        new Response(JSON.stringify({ org: { id: "o9", slug: "new", name: "New" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      "PUT /api/v1/me/current-org": () => noContent(),
    });
    const view = renderFrame(shellOf(none));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: zh.orgChooser.create }));
    const dialog = await screen.findByRole("dialog", { name: zh.home.createOrg.title });
    // a create dialog: focus on the name, 新建 disabled until it has one
    expect(document.activeElement).toBe(within(dialog).getByRole("textbox"));
    const submit = within(dialog).getByRole("button", {
      name: zh.home.createOrg.submit,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(within(dialog).getByRole("textbox"), "New");
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/"));
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "/api/v1/orgs"],
      ["PUT", "/api/v1/me/current-org"],
    ]);
    // still the chooser with the dialog busy: nothing of the shell yet
    expect(workSidebar()).toBeNull();
    expect(chooser()).not.toBeNull();
    expect(
      within(screen.getByRole("dialog", { name: zh.home.createOrg.title }))
        .getByRole("button", { name: zh.home.createOrg.submit })
        .getAttribute("aria-busy"),
    ).toBe("true");
    view.update(
      shellOf(
        {
          ...none,
          currentOrgId: "o9",
          memberships: [{ orgId: "o9", slug: "new", name: "New", role: "owner" }],
        },
        { readiness: NOT_READY },
      ),
    );
    expect(setupPage()).not.toBeNull();
    expect(workSidebar()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("signing out: a full navigation to /login and a broadcast to other tabs", async () => {
    const posted = fakeChannel();
    stubApi({ "POST /api/v1/auth/logout": () => noContent() });
    renderFrame(shellOf(ME));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "账户: Grant" }));
    await user.click(await screen.findByRole("menuitem", { name: zh.common.logout }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/login"));
    expect(posted).toEqual([expect.objectContaining({ kind: "signed-out" })]);
  });
});

describe("the setup sidebar's steps per role (web-SSR spec §4)", () => {
  type Row = { id: string; state: string; href: string | null; optional: boolean; text: string };
  const rows = (): Row[] =>
    [...document.querySelectorAll<HTMLElement>('[data-part="step-item"]')].map((el) => ({
      id: el.getAttribute("data-rove") ?? "",
      state: el.getAttribute("data-state") ?? "",
      href: el.getAttribute("href"),
      optional: el.getAttribute("data-optional") === "true",
      text: el.textContent ?? "",
    }));
  const s = sl.steps;

  it("an enterprise admin who is also an org admin", () => {
    renderFrame(shellOf(ME, { readiness: NOT_READY }));
    expect(rows()).toEqual([
      { id: "model", state: "todo", href: "/admin/extensions", optional: false, text: s.model },
      {
        id: "agent",
        state: "waiting",
        href: null,
        optional: false,
        text: `${s.agent}${sl.agent.needsModel}`,
      },
      { id: "channels", state: "todo", href: "/channels/new", optional: true, text: s.channels },
      { id: "members", state: "todo", href: "/settings/members", optional: true, text: s.members },
      { id: "catalog", state: "todo", href: "/catalog", optional: true, text: s.catalog },
    ]);
  });

  it("an org admin waits for a deployment admin's model", () => {
    renderFrame(shellOf(as("admin"), { readiness: NOT_READY }));
    const r = rows();
    expect(r.map((x) => [x.id, x.state, x.href])).toEqual([
      ["model", "waiting", null],
      ["agent", "waiting", null],
      ["channels", "todo", "/channels/new"],
      ["members", "todo", "/settings/members"],
      ["catalog", "todo", "/catalog"],
    ]);
    expect(r[0]?.text).toBe(`${s.model}${sl.model.needsDeploymentAdmin}`);
  });

  it("a member waits for the model; later, only their connections", () => {
    renderFrame(shellOf(as("member"), { readiness: NOT_READY }));
    const r = rows();
    expect(r.map((x) => [x.id, x.state, x.href, x.optional])).toEqual([
      ["model", "waiting", null, false],
      ["agent", "waiting", null, false],
      ["connections", "todo", "/account/connections", true],
    ]);
    expect(r[0]?.text).toBe(`${s.model}${sl.model.waitingForAdmin}`);
    expect(r[1]?.text).toBe(`${s.agent}${sl.agent.needsModel}`);
  });

  it("a member with a model creates the agent; the model step is done", () => {
    renderFrame(shellOf(as("member"), { readiness: PROVIDER_ONLY }));
    expect(rows().map((x) => [x.id, x.state, x.href])).toEqual([
      ["model", "done", null],
      ["agent", "todo", "/agents/new"],
      ["connections", "todo", "/account/connections"],
    ]);
  });

  it("a guest waits for both, with nothing to do later", () => {
    renderFrame(shellOf(as("guest"), { readiness: PROVIDER_ONLY }));
    const r = rows();
    expect(r.map((x) => [x.id, x.state])).toEqual([
      ["model", "done"],
      ["agent", "waiting"],
    ]);
    expect(r[1]?.text).toBe(`${s.agent}${sl.agent.waitingForAdmin}`);
  });

  it("the current step is marked; the setup home is current on /", () => {
    resetNavigation("/settings/members");
    renderFrame(shellOf(as("admin"), { readiness: NOT_READY }));
    const members = document.querySelector('[data-rove="members"]') as HTMLElement;
    expect(members.getAttribute("aria-current")).toBe("page");
    cleanup();
    resetNavigation("/");
    renderFrame(shellOf(as("admin"), { readiness: NOT_READY }));
    const home = document.querySelector('[data-rove="home"]') as HTMLElement;
    expect(home.getAttribute("aria-current")).toBe("page");
  });

  it("while the setup frame shows, it refreshes every 30 s and on focus", () => {
    vi.useFakeTimers();
    renderFrame(shellOf(as("member"), { readiness: NOT_READY }));
    expect(router.refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(30_000));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("a ready shell does not refresh by itself", () => {
    vi.useFakeTimers();
    stubApi({
      "GET /api/v1/orgs/o1/inbox": () =>
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        new Response(JSON.stringify({ groups: [], next: null }), { status: 200 }),
    });
    renderFrame(shellOf(ME, { readiness: READY }));
    act(() => vi.advanceTimersByTime(30_000));
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

function intl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="zh" messages={zh}>
      <DesignProvider locale="zh" link={Link as LinkComponent}>
        <ToastProvider>{node}</ToastProvider>
      </DesignProvider>
    </NextIntlClientProvider>
  );
}

describe("the kernel is starting (ruling R2)", () => {
  it("refreshes every 3 s for 60 s, then offers 重试", async () => {
    vi.useFakeTimers();
    render(intl(<KernelStarting />));
    expect(screen.getByText(zh.errors.page.starting, { selector: "h2" })).toBeTruthy();
    expect(document.querySelector('[data-template="StatusPage"][data-kind="maintenance"]')).toBe(
      document.querySelector('[data-template="StatusPage"]'),
    );
    expect(screen.queryByRole("button", { name: zh.errors.page.retry })).toBeNull();
    act(() => vi.advanceTimersByTime(3_000));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(57_000));
    expect(router.refresh).toHaveBeenCalledTimes(20);
    act(() => vi.advanceTimersByTime(9_000));
    expect(router.refresh).toHaveBeenCalledTimes(20);
    const retry = screen.getByRole("button", { name: zh.errors.page.retry });
    act(() => retry.click());
    expect(router.refresh).toHaveBeenCalledTimes(21);
  });
});

describe("error.tsx (ruling R2)", () => {
  it("加载失败 with 重试 (refresh, then reset); retries by itself once after 3 s", () => {
    vi.useFakeTimers();
    const reset = vi.fn();
    render(intl(<ErrorPage error={new Error("boom")} reset={reset} />));
    expect(screen.getByText(zh.errors.page.title, { selector: "h2" })).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
    act(() => vi.advanceTimersByTime(3_000));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    // the boundary draws the page again after a failed retry: no second automatic retry
    cleanup();
    render(intl(<ErrorPage error={new Error("boom")} reset={reset} />));
    act(() => vi.advanceTimersByTime(10_000));
    expect(reset).toHaveBeenCalledTimes(1);
    act(() => screen.getByRole("button", { name: zh.errors.page.retry }).click());
    expect(router.refresh).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(2);
  });
});

describe("cross-tab session sync", () => {
  class Bus {
    static all: Bus[] = [];
    onmessage: ((e: MessageEvent) => void) | null = null;
    constructor(readonly name: string) {
      Bus.all.push(this);
    }
    postMessage(data: unknown) {
      for (const b of Bus.all)
        if (b !== this && b.name === this.name) b.onmessage?.({ data } as MessageEvent);
    }
    close() {
      Bus.all = Bus.all.filter((b) => b !== this);
    }
  }

  it("a broadcast from another tab calls the handler of its kind, never the sender's own", () => {
    Bus.all = [];
    vi.stubGlobal("BroadcastChannel", Bus);
    const signed = vi.fn();
    const org = vi.fn();
    renderHook(() => useSessionSync(signed, org));
    // the same tab's broadcast is ignored
    broadcastSession("org-switched");
    expect(org).not.toHaveBeenCalled();
    // another tab's message
    const other = new Bus("capybara-session");
    other.postMessage({ kind: "org-switched", from: "another-tab", at: 1 });
    expect(org).toHaveBeenCalledTimes(1);
    other.postMessage({ kind: "signed-out", from: "another-tab", at: 2 });
    other.postMessage({ kind: "signed-in", from: "another-tab", at: 3 });
    expect(signed).toHaveBeenCalledTimes(2);
  });

  it("without BroadcastChannel, the storage event carries it", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const signed = vi.fn();
    const org = vi.fn();
    renderHook(() => useSessionSync(signed, org));
    broadcastSession("signed-in");
    expect(JSON.parse(localStorage.getItem("capybara:session") ?? "{}").kind).toBe("signed-in");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "capybara:session",
        newValue: JSON.stringify({ kind: "org-switched", from: "another-tab", at: 5 }),
      }),
    );
    expect(org).toHaveBeenCalledTimes(1);
    expect(signed).not.toHaveBeenCalled();
  });

  it("the frame follows: an org switch or a sign-out elsewhere reloads /", async () => {
    Bus.all = [];
    vi.stubGlobal("BroadcastChannel", Bus);
    renderFrame(shellOf(ME));
    const other = new Bus("capybara-session");
    act(() => other.postMessage({ kind: "org-switched", from: "another-tab", at: 1 }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledTimes(1));
    expect(navigateBrowser).toHaveBeenCalledWith("/");
    expect(router.push).not.toHaveBeenCalled();
    act(() => other.postMessage({ kind: "signed-out", from: "another-tab", at: 2 }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledTimes(2));
  });
});

describe("persistent sidebar sections (web query cache spec §6)", () => {
  const groupsGets = (calls: { method: string; url: string }[]) =>
    calls.filter((c) => c.method === "GET" && c.url.includes("/conversations/groups"));
  const inboxGets = (calls: { method: string; url: string }[]) =>
    calls.filter((c) => c.method === "GET" && c.url.includes("/inbox"));

  it("sidebar refetches stale groups on path change and not fresh ones", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, { groups: [], next: null, archivedCount: 0 }),
      "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [] }),
    });
    const view = renderFrame(shellOf(ME));
    const move = async (to: string) => {
      pathname.current = to;
      view.rerender(frameElement(shellOf(ME), <p>page body</p>, {}, view.client));
      await act(() => new Promise((r) => setTimeout(r, 20)));
    };
    // fresh from the layout: a path change reads nothing
    await move("/agents");
    expect(calls).toEqual([]);
    // the groups went stale (31 s old), the count is still fresh: only the groups are read
    const groups = conversationGroupsQuery("o1").queryKey;
    view.client.setQueryData(groups, view.client.getQueryData(groups), {
      updatedAt: Date.now() - 31_000,
    });
    await move("/skills");
    await vi.waitFor(() => expect(groupsGets(calls)).toHaveLength(1));
    expect(inboxGets(calls)).toHaveLength(0);
    // now both are stale
    const count = inboxCountQuery("o1").queryKey;
    view.client.setQueryData(count, view.client.getQueryData(count), {
      updatedAt: Date.now() - 31_000,
    });
    await move("/connectors");
    await vi.waitFor(() => expect(inboxGets(calls)).toHaveLength(1));
    expect(groupsGets(calls)).toHaveLength(1);
  });

  it("a path change with the same pathname reads nothing", async () => {
    const calls = stubApi({});
    const view = renderFrame(shellOf(ME));
    const groups = conversationGroupsQuery("o1").queryKey;
    view.client.setQueryData(groups, view.client.getQueryData(groups), { updatedAt: 0 });
    view.rerender(frameElement(shellOf(ME), <p>page body</p>, {}, view.client));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls).toEqual([]);
  });
});

describe("signing out (sign-out race)", () => {
  const signedOut = () => new ApiClientError(401, "auth.session_expired", "expired");

  it("a 401 read while the sign-out is pending leaves the navigation to the sign-out", async () => {
    let release: (r: Response) => void = () => {};
    stubApi({
      "POST /api/v1/auth/logout": () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    });
    const view = renderFrame(shellOf(ME), <SessionGuard>page body</SessionGuard>);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "账户: Grant" }));
    await user.click(await screen.findByRole("menuitem", { name: zh.common.logout }));
    // the logout's own 401 storm: a read finds the session gone before the answer
    await act(async () => {
      await view.client
        .prefetchQuery({
          queryKey: keys.org("o1").agents(),
          queryFn: () => Promise.reject(signedOut()),
          retry: false,
        })
        .catch(() => {});
    });
    expect(router.replace).not.toHaveBeenCalled();
    await act(async () => {
      release(noContent());
    });
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/login"));
    expect(router.replace).not.toHaveBeenCalled();
  });
});
