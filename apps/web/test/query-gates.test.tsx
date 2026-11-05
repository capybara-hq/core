// @vitest-environment jsdom
// Client-side gates and the session reset (web query cache spec §3.2, §6).
import { type QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionGuard } from "../src/components/SessionGuard";
import type { OrgReadiness } from "../src/lib/agents";
import { ApiClientError } from "../src/lib/api";
import { loginPathFor } from "../src/lib/auth-sources";
import { agentsQuery } from "../src/lib/query/agents";
import { makeQueryClient } from "../src/lib/query/client";
import { defineQuery } from "../src/lib/query/define";
import { keys } from "../src/lib/query/keys";
import { usePageQuery } from "../src/lib/query/page-query";
import { meQuery, readinessQuery } from "../src/lib/query/shell";
import { resetSession, useAdmin, useWorkspace } from "../src/lib/query/workspace";
import type { Me } from "../src/lib/session";
import { isSignedOut } from "../src/lib/signed-out";
import { json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { NOT_READY, READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

beforeEach(() => {
  resetNavigation("/agents");
  vi.unstubAllGlobals();
});

const kernelError = (status: number, code: string) =>
  json(status, { error: { code, message: code } });

const asRole = (role: string): Me => ({
  ...ME,
  account: { ...ME.account, isEnterpriseAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

/** A browser client holding what the layout's prefetch would have put there. */
function seeded(me: Me, readiness: OrgReadiness = READY): QueryClient {
  const qc = makeQueryClient();
  qc.setQueryData(meQuery().queryKey, me);
  if (me.currentOrgId !== null)
    qc.setQueryData(readinessQuery(me.currentOrgId).queryKey, readiness);
  return qc;
}

const wrapper = (qc: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

describe("useWorkspace", () => {
  it("a member below admin gets noAccess admin", () => {
    const { result } = renderHook(() => useWorkspace({ min: "admin" }), {
      wrapper: wrapper(seeded(asRole("member"))),
    });
    expect(result.current).toEqual({ kind: "noAccess", need: "admin" });
  });

  it("a guest below member gets noAccess member", () => {
    const { result } = renderHook(() => useWorkspace({ min: "member" }), {
      wrapper: wrapper(seeded(asRole("guest"))),
    });
    expect(result.current).toEqual({ kind: "noAccess", need: "member" });
  });

  it("an admin passes the admin gate", () => {
    const me = asRole("admin");
    const { result } = renderHook(() => useWorkspace({ min: "admin" }), {
      wrapper: wrapper(seeded(me)),
    });
    expect(result.current).toEqual({ kind: "ok", me, orgId: "o1", role: "admin" });
  });

  it("an org that is not ready redirects to / unless the page is a setup route", async () => {
    const qc = seeded(ME, NOT_READY);
    const gated = renderHook(() => useWorkspace(), { wrapper: wrapper(qc) });
    expect(gated.result.current).toEqual({ kind: "pending" });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));

    router.replace.mockClear();
    const setup = renderHook(() => useWorkspace({ setup: "home" }), { wrapper: wrapper(qc) });
    expect(setup.result.current.kind).toBe("ok");
    const step = renderHook(() => useWorkspace({ setup: "step" }), { wrapper: wrapper(qc) });
    expect(step.result.current.kind).toBe("ok");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("no current org is noOrg, and nothing cached is pending", () => {
    const none = renderHook(() => useWorkspace(), {
      wrapper: wrapper(seeded({ ...ME, currentOrgId: null })),
    });
    expect(none.result.current).toEqual({ kind: "noOrg" });
    stubApi({});
    const empty = renderHook(() => useWorkspace(), { wrapper: wrapper(makeQueryClient()) });
    expect(empty.result.current).toEqual({ kind: "pending" });
  });
});

describe("useAdmin", () => {
  it("only enterprise admins pass", () => {
    const yes = renderHook(() => useAdmin(), { wrapper: wrapper(seeded(ME)) });
    expect(yes.result.current).toEqual({ kind: "ok", me: ME });
    const no = renderHook(() => useAdmin(), { wrapper: wrapper(seeded(asRole("owner"))) });
    expect(no.result.current).toEqual({ kind: "noAccess", need: "enterprise" });
  });
});

describe("a signed-out session on a client read", () => {
  function AgentsProbe() {
    const state = usePageQuery(agentsQuery("o1"));
    if (state.kind === "ready") return <p>rows:{state.data.agents.length}</p>;
    if (state.kind === "error") return <p>error:{state.code}</p>;
    return <p>loading</p>;
  }

  it("a 401 auth.* on a client query redirects to sign-in and clears the cache", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/agents": () => kernelError(401, "auth.required"),
      "POST /api/v1/auth/refresh": () => kernelError(401, "auth.required"),
    });
    const qc = makeQueryClient();
    const seen: string[] = [];
    const { container } = render(
      <QueryClientProvider client={qc}>
        <SessionGuard>
          <AgentsProbe />
        </SessionGuard>
      </QueryClientProvider>,
    );
    // every DOM state the page goes through
    const watcher = new MutationObserver(() => seen.push(container.textContent ?? ""));
    watcher.observe(container, { subtree: true, childList: true, characterData: true });
    seen.push(container.textContent ?? "");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(loginPathFor("/agents")));
    expect(loginPathFor("/agents")).toBe("/login?returnTo=%2Fagents");
    await waitFor(() => expect(qc.getQueryCache().getAll()).toEqual([]));
    watcher.disconnect();
    expect(seen.filter((s) => s.includes("error"))).toEqual([]);
    expect(container.textContent).not.toContain("error");
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it("other failures are left to the page", async () => {
    stubApi({ "GET /api/v1/orgs/o1/agents": () => kernelError(403, "forbidden") });
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <SessionGuard>
          <AgentsProbe />
        </SessionGuard>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("error:forbidden")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("isSignedOut is 401 with an auth.* code only", () => {
    expect(isSignedOut(new ApiClientError(401, "auth.token_expired", "x"))).toBe(true);
    expect(isSignedOut(new ApiClientError(401, "other", "x"))).toBe(false);
    expect(isSignedOut(new ApiClientError(403, "auth.forbidden", "x"))).toBe(false);
    expect(isSignedOut(new Error("x"))).toBe(false);
  });
});

describe("resetSession", () => {
  /** A probe read of one org whose answer the test controls; records its abort signal. */
  function probe(orgId: string) {
    const d: { signal?: AbortSignal; answer: (rows: string[]) => void } = { answer: () => {} };
    const query = defineQuery<string[]>({
      key: keys.org(orgId).agents(),
      fn: ({ signal }) => {
        d.signal = signal;
        return new Promise<string[]>((resolve) => {
          d.answer = resolve;
        });
      },
      freshness: "orgConfig",
    });
    return { d, query };
  }

  function Probe({ query }: { query: ReturnType<typeof probe>["query"] }) {
    const q = useQuery(query);
    return <p>{q.data === undefined ? "none" : (q.data as string[]).join(",")}</p>;
  }

  it("org switch cancels the old org's read before clearing, and its late answer never shows", async () => {
    const qc = makeQueryClient();
    const a = probe("A");
    const b = probe("B");
    const view = render(
      <QueryClientProvider client={qc}>
        <Probe query={a.query} />
      </QueryClientProvider>,
    );
    const seen: string[] = [];
    const watcher = new MutationObserver(() => seen.push(view.container.textContent ?? ""));
    watcher.observe(view.container, { subtree: true, childList: true, characterData: true });
    await waitFor(() => expect(a.d.signal).toBeDefined());
    expect(a.d.signal?.aborted).toBe(false);

    // the old read must already be cancelled when the cache is cleared
    let abortedAtClear: boolean | undefined;
    const clear = qc.clear.bind(qc);
    qc.clear = () => {
      abortedAtClear = a.d.signal?.aborted;
      clear();
    };
    await resetSession(qc, () => {
      expect(qc.getQueryCache().getAll()).toEqual([]);
    });
    expect(abortedAtClear).toBe(true);

    // org B: its own component and read
    view.rerender(
      <QueryClientProvider client={qc}>
        <Probe query={b.query} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(b.d.signal).toBeDefined());
    await act(async () => {
      a.d.answer(["Alpha-row"]);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(qc.getQueryData(keys.org("A").agents())).toBeUndefined();
    expect(view.container.textContent).toBe("none");
    await act(async () => {
      b.d.answer(["Beta-row"]);
      await new Promise((r) => setTimeout(r, 20));
    });
    watcher.disconnect();
    expect(view.container.textContent).toBe("Beta-row");
    expect(seen.filter((t) => t.includes("Alpha-row"))).toEqual([]);
    expect(
      qc
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey),
    ).toEqual([keys.org("B").agents()]);
  });

  it("clears and calls then in the same task, with nothing awaited in between", async () => {
    const qc = seeded(ME);
    const order: string[] = [];
    const clear = qc.clear.bind(qc);
    qc.clear = () => {
      order.push("clear");
      clear();
    };
    await resetSession(qc, () => order.push("then"));
    expect(order).toEqual(["clear", "then"]);
  });
});
