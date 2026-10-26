import {
  DesignProvider,
  type LinkComponent,
  Sidebar,
  type SidebarProps,
} from "@capybara-hq/design";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationGroups } from "../src/components/shell/conversations";
import { json, stubApi } from "./support/api";
import { Link, router } from "./support/navigation";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

beforeEach(() => {
  localStorage.clear();
  router.push.mockClear();
  onError.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const conv = (id: string, agentId: string, title: string | null = null) => ({
  id,
  orgId: "o1",
  agentId,
  title,
  lastSeq: 1,
  createdAt: "2026-10-20T06:32:00.000Z",
  updatedAt: "2026-10-20T06:32:00.000Z",
});
const group = (agentId: string, name: string, convs: ReturnType<typeof conv>[], more = false) => ({
  agent: { id: agentId, name },
  latestAt: "2026-10-20T06:32:00.000Z",
  conversations: convs,
  more,
});

const base: Omit<SidebarProps, "conversations"> = {
  newConversation: { href: "/agents" },
  nav: [],
  activeNav: "",
  footerNav: [],
  account: { name: "Grant", org: "Acme", menu: [] },
  onOpenCommands: () => {},
};

const onError = vi.fn();

function Harness({ orgId, path = "/" }: { orgId: string | null | undefined; path?: string }) {
  const conversations = useConversationGroups(orgId, path, { onError });
  return <Sidebar {...base} conversations={conversations} mode="full" />;
}

const frame = (orgId: string | null | undefined, path?: string) => (
  <DesignProvider locale="zh" link={Link as LinkComponent}>
    <Harness orgId={orgId} {...(path ? { path } : {})} />
  </DesignProvider>
);
const show = (orgId: string | null | undefined, path?: string) => render(frame(orgId, path));
const section = () => screen.getByRole("region", { name: "会话" });

describe("useConversationGroups", () => {
  it("renders my groups; untitled rows read 未命名会话; the row under /chat/<id> is current", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c1", "a1", "整理要点"), conv("c2", "a1")])],
          next: null,
        }),
    });
    show("o1", "/chat/c1");
    const row = await screen.findByRole("link", { name: "整理要点" });
    expect(row.getAttribute("href")).toBe("/chat/c1");
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(within(section()).getByText(/^未命名会话 · /)).toBeTruthy();
    expect(screen.getByRole("button", { name: "研究助手" })).toBeTruthy();
  });

  it("More loads the group's next conversations after the last one", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c1", "a1", "一")], true)],
          next: null,
        }),
      "GET /api/v1/orgs/o1/conversations?agentId=a1&after=c1": () =>
        json(200, { conversations: [conv("c0", "a1", "二")], next: null }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(within(section()).getByRole("button", { name: "更多" }));
    expect(await screen.findByRole("link", { name: "二" })).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/conversations?agentId=a1&after=c1"))).toBe(true);
    expect(within(section()).queryByRole("button", { name: "更多" })).toBeNull();
  });

  it("More groups appends the next page, de-duplicating groups by agent id", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, { groups: [group("a1", "研究助手", [conv("c1", "a1", "一")])], next: "a1" }),
      "GET /api/v1/orgs/o1/conversations/groups?after=a1": () =>
        json(200, {
          groups: [
            group("a1", "研究助手", [conv("c1", "a1", "一")]),
            group("a2", "客服分流", [conv("c9", "a2", "九")]),
          ],
          next: null,
        }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(screen.getByRole("button", { name: "更多分组" }));
    expect(await screen.findByRole("link", { name: "九" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "研究助手" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "更多分组" })).toBeNull();
  });

  it("a failed load shows Retry, which loads again", async () => {
    let fail = true;
    stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        fail
          ? json(500, { error: { code: "internal", message: "x" } })
          : json(200, { groups: [group("a1", "研究助手", [conv("c1", "a1", "一")])], next: null }),
    });
    show("o1");
    expect(await within(section()).findByText("会话列表加载失败")).toBeTruthy();
    fail = false;
    await userEvent.click(within(section()).getByRole("button", { name: /重试/ }));
    expect(await screen.findByRole("link", { name: "一" })).toBeTruthy();
  });

  it("switching org reloads and never shows org A's conversations under org B", async () => {
    let releaseB: (r: Response) => void = () => {};
    stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c1", "a1", "A 的会话")])],
          next: null,
        }),
      "GET /api/v1/orgs/o2/conversations/groups": () =>
        new Promise<Response>((r) => {
          releaseB = r;
        }),
    });
    const r = show("o1");
    await screen.findByRole("link", { name: "A 的会话" });
    r.rerender(
      <DesignProvider locale="zh" link={Link as LinkComponent}>
        <Harness orgId="o2" />
      </DesignProvider>,
    );
    expect(screen.queryByRole("link", { name: "A 的会话" })).toBeNull();
    expect(section().getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      releaseB(
        json(200, {
          groups: [group("b1", "客服分流", [conv("d1", "b1", "B 的会话")])],
          next: null,
        }),
      );
    });
    expect(await screen.findByRole("link", { name: "B 的会话" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "A 的会话" })).toBeNull();
  });

  it("the group ＋ creates a conversation with that agent and opens it", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, { groups: [group("a1", "研究助手", [conv("c1", "a1", "一")])], next: null }),
      "POST /api/v1/orgs/o1/conversations": () => json(201, { conversation: conv("c7", "a1") }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(screen.getByRole("button", { name: "与 研究助手 新建会话" }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat/c7"));
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ agentId: "a1" });
  });

  it("collapsed groups are remembered per org (m4)", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, { groups: [group("a1", "研究助手", [conv("c1", "a1", "一")])], next: null }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(screen.getByRole("button", { name: "研究助手" }));
    expect(JSON.parse(localStorage.getItem("cap.sidebar.collapsed.o1") ?? "[]")).toEqual(["a1"]);
  });

  it("no current org (null): an empty ready list, no request", () => {
    const calls = stubApi({});
    show(null);
    expect(within(section()).getByText("还没有会话，从 Agents 里选一个开始。")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("session still loading (undefined): busy, no empty hint, no request (I2)", () => {
    const calls = stubApi({});
    show(undefined);
    expect(section().getAttribute("aria-busy")).toBe("true");
    expect(within(section()).queryByText("还没有会话，从 Agents 里选一个开始。")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("useConversationGroups refresh (I1)", () => {
  /** Page 1 has c1 with More; the More page has c0; a later page 1 may bring a new c2. */
  function api(opts: { fresh?: boolean; groupsNext?: string | null } = {}) {
    let pageOne = 0;
    const calls = stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () => {
        pageOne += 1;
        const rows =
          opts.fresh && pageOne > 1
            ? [conv("c2", "a1", "新的"), conv("c1", "a1", "一")]
            : [conv("c1", "a1", "一")];
        return json(200, {
          groups: [group("a1", "研究助手", rows, true)],
          next: opts.groupsNext ?? null,
        });
      },
      "GET /api/v1/orgs/o1/conversations?agentId=a1&after=c1": () =>
        json(200, { conversations: [conv("c0", "a1", "二")], next: null }),
      "GET /api/v1/orgs/o1/conversations/groups?after=a1": () =>
        json(200, { groups: [group("a2", "客服分流", [conv("c9", "a2", "九")])], next: null }),
    });
    return { calls, pageOneCalls: () => pageOne };
  }

  it("More, then a route into the older conversation: the row stays listed and current", async () => {
    const { pageOneCalls } = api();
    const r = show("o1", "/agents");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(within(section()).getByRole("button", { name: "更多" }));
    await screen.findByRole("link", { name: "二" });
    r.rerender(frame("o1", "/chat/c0"));
    await vi.waitFor(() => expect(pageOneCalls()).toBe(2));
    // let the refresh's answer apply
    await act(async () => {});
    const row = screen.getByRole("link", { name: "二" });
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(within(section()).queryByRole("button", { name: "更多" })).toBeNull();
  });

  it("More, then window focus: the loaded rows stay; a new conversation shows first", async () => {
    const { pageOneCalls } = api({ fresh: true });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(within(section()).getByRole("button", { name: "更多" }));
    await screen.findByRole("link", { name: "二" });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(pageOneCalls()).toBe(2);
    await screen.findByRole("link", { name: "新的" });
    const names = within(section())
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(names).toEqual(["新的", "一", "二"]);
  });

  it("More groups survive a refresh, and the groups cursor stays the loaded one", async () => {
    const { calls } = api({ groupsNext: "a1" });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(screen.getByRole("button", { name: "更多分组" }));
    await screen.findByRole("link", { name: "九" });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith("/conversations/groups"))).toHaveLength(2),
    );
    await act(async () => {});
    expect(screen.getByRole("link", { name: "九" })).toBeTruthy();
    // a2 was the last page: no More groups row comes back
    expect(screen.queryByRole("button", { name: "更多分组" })).toBeNull();
  });

  it("a route into /chat/* reloads, so a conversation started elsewhere shows", async () => {
    api({ fresh: true });
    const r = show("o1", "/agents");
    await screen.findByRole("link", { name: "一" });
    expect(screen.queryByRole("link", { name: "新的" })).toBeNull();
    r.rerender(frame("o1", "/chat/c2"));
    const row = await screen.findByRole("link", { name: "新的" });
    expect(row.getAttribute("aria-current")).toBe("page");
  });

  it("an older refresh answering last does not overwrite a newer one (m5)", async () => {
    const answers: ((r: Response) => void)[] = [];
    let n = 0;
    stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () => {
        n += 1;
        if (n === 1)
          return json(200, {
            groups: [group("a1", "研究助手", [conv("c1", "a1", "一")])],
            next: null,
          });
        return new Promise<Response>((r) => {
          answers.push(r);
        });
      },
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(answers).toHaveLength(2);
    await act(async () => {
      answers[1]?.(
        json(200, { groups: [group("a1", "研究助手", [conv("c3", "a1", "最新")])], next: null }),
      );
    });
    await screen.findByRole("link", { name: "最新" });
    await act(async () => {
      answers[0]?.(
        json(200, { groups: [group("b9", "旧答复", [conv("c8", "b9", "过期")])], next: null }),
      );
    });
    expect(screen.queryByRole("button", { name: "旧答复" })).toBeNull();
    expect(screen.getByRole("link", { name: "最新" })).toBeTruthy();
  });
});

describe("useConversationGroups errors (I3)", () => {
  it("a failing group ＋ reports the error; two quick clicks post once", async () => {
    let release: (r: Response) => void = () => {};
    const calls = stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, { groups: [group("a1", "研究助手", [conv("c1", "a1", "一")])], next: null }),
      "POST /api/v1/orgs/o1/conversations": () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    const plus = screen.getByRole("button", { name: "与 研究助手 新建会话" });
    await userEvent.click(plus);
    await userEvent.click(plus);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    await act(async () => {
      release(json(404, { error: { code: "agent.not_found", message: "gone" } }));
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(router.push).not.toHaveBeenCalled();
  });

  it("failing More and More groups report the error", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c1", "a1", "一")], true)],
          next: "a1",
        }),
      "GET /api/v1/orgs/o1/conversations?agentId=a1&after=c1": () =>
        json(500, { error: { code: "internal", message: "x" } }),
      "GET /api/v1/orgs/o1/conversations/groups?after=a1": () =>
        json(500, { error: { code: "internal", message: "x" } }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(within(section()).getByRole("button", { name: "更多" }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "更多分组" }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    // the rows stay, so the viewer can try again
    expect(within(section()).getByRole("button", { name: "更多" })).toBeTruthy();
  });
});
