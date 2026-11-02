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
import type { ConversationGroupsPage } from "../src/lib/conversations";
import { bodyOf, json, noContent, stubApi } from "./support/api";
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
type Row = ReturnType<typeof conv> & { activity?: "running" | "waiting" | null };
const group = (agentId: string, name: string, convs: Row[], more = false) => ({
  agent: { id: agentId, name },
  latestAt: "2026-10-20T06:32:00.000Z",
  conversations: convs,
  more,
});

const base: Omit<SidebarProps, "conversations"> = {
  context: { kind: "work", org: null, primary: [], more: [] },
  newConversation: { href: "/agents" },
  activeNav: "",
  account: { name: "Grant", menu: [] },
  onOpenCommands: () => {},
};
const onError = vi.fn();

function Harness({
  orgId,
  path = "/",
  initial,
}: {
  orgId: string | null | undefined;
  path?: string;
  initial?: ConversationGroupsPage | null;
}) {
  const conversations = useConversationGroups(orgId, path, {
    onError,
    ...(initial !== undefined ? { initial } : {}),
  });
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
    await userEvent.click(within(section()).getByRole("button", { name: "显示更多" }));
    expect(await screen.findByRole("link", { name: "二" })).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/conversations?agentId=a1&after=c1"))).toBe(true);
    expect(within(section()).queryByRole("button", { name: "显示更多" })).toBeNull();
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

  it("the group ＋ opens a new conversation with that agent picked (created on first send)", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, { groups: [group("a1", "研究助手", [conv("c1", "a1", "一")])], next: null }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(screen.getByRole("button", { name: "与 研究助手 新建会话" }));
    expect(router.push).toHaveBeenCalledWith("/chat?agent=a1");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reloads when a conversation's title changed (cap:conversations-changed)", async () => {
    let title = "一";
    stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, { groups: [group("a1", "研究助手", [conv("c1", "a1", title)])], next: null }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    title = "新的标题";
    act(() => {
      window.dispatchEvent(new Event("cap:conversations-changed"));
    });
    expect(await screen.findByRole("link", { name: "新的标题" })).toBeTruthy();
  });

  it("reloads every 30 s, so a background conversation's state dot follows its runs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let activity: "running" | null = null;
      const calls = stubApi({
        "GET /api/v1/orgs/o1/conversations/groups": () =>
          json(200, {
            groups: [group("a1", "研究助手", [{ ...conv("c1", "a1", "一"), activity }])],
            next: null,
          }),
      });
      show("o1");
      await screen.findByRole("link", { name: "一" });
      const loads = () => calls.filter((c) => c.url.includes("/conversations/groups")).length;
      const before = loads();
      activity = "running";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(loads()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
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
    expect(within(section()).getByText("还没有会话。")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("session still loading (undefined): busy, no empty hint, no request (I2)", () => {
    const calls = stubApi({});
    show(undefined);
    expect(section().getAttribute("aria-busy")).toBe("true");
    expect(within(section()).queryByText("还没有会话。")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("useConversationGroups seeded from the server (web-SSR §3.1)", () => {
  const seeded = (orgId: string, initial: ConversationGroupsPage | null, path = "/") => (
    <DesignProvider locale="zh" link={Link as LinkComponent}>
      <Harness orgId={orgId} path={path} initial={initial} />
    </DesignProvider>
  );
  const page = (title: string): ConversationGroupsPage => ({
    groups: [group("a1", "研究助手", [conv("c1", "a1", title)])],
    next: null,
    archivedCount: 3,
  });

  it("the server's page paints at once, with no browser read", async () => {
    const calls = stubApi({});
    render(seeded("o1", page("一")));
    expect(screen.getByRole("link", { name: "一" })).toBeTruthy();
    expect(within(section()).getByRole("button", { name: /已归档/ })).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls).toEqual([]);
  });

  it("a failed server read: the error state, and 重试 loads", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () => json(200, page("重试后")),
    });
    render(seeded("o1", null));
    expect(calls).toEqual([]);
    await userEvent.click(within(section()).getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: "重试后" })).toBeTruthy();
  });

  it("new props from the server replace the rows; another org's page never shows the old rows", () => {
    stubApi({});
    const r = render(seeded("o1", page("一")));
    r.rerender(seeded("o1", page("刷新后")));
    expect(screen.getByRole("link", { name: "刷新后" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "一" })).toBeNull();
    r.rerender(seeded("o2", { groups: [], next: null }));
    expect(screen.queryByRole("link", { name: "刷新后" })).toBeNull();
  });

  it("live updates continue: focus and the 30 s poll read again", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/conversations/groups": () => json(200, page("新")),
    });
    render(seeded("o1", page("一")));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByRole("link", { name: "新" })).toBeTruthy();
    expect(calls).toHaveLength(1);
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
      // a later page: an older latest activity than page 1's groups (the kernel's order)
      "GET /api/v1/orgs/o1/conversations/groups?after=a1": () =>
        json(200, {
          groups: [
            {
              ...group("a2", "客服分流", [conv("c9", "a2", "九")]),
              latestAt: "2026-10-19T00:00:00.000Z",
            },
          ],
          next: null,
        }),
    });
    return { calls, pageOneCalls: () => pageOne };
  }

  it("More, then a route into the older conversation: the row stays listed and current", async () => {
    const { pageOneCalls } = api();
    const r = show("o1", "/agents");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(within(section()).getByRole("button", { name: "显示更多" }));
    await screen.findByRole("link", { name: "二" });
    r.rerender(frame("o1", "/chat/c0"));
    await vi.waitFor(() => expect(pageOneCalls()).toBe(2));
    // let the refresh's answer apply
    await act(async () => {});
    const row = screen.getByRole("link", { name: "二" });
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(within(section()).queryByRole("button", { name: "显示更多" })).toBeNull();
  });

  it("More, then window focus: the loaded rows stay; a new conversation shows first", async () => {
    const { pageOneCalls } = api({ fresh: true });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(within(section()).getByRole("button", { name: "显示更多" }));
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
    await userEvent.click(within(section()).getByRole("button", { name: "显示更多" }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "更多分组" }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    // the rows stay, so the viewer can try again
    expect(within(section()).getByRole("button", { name: "显示更多" })).toBeTruthy();
  });
});

describe("useConversationGroups filter, archived list and row actions (web order §2.1)", () => {
  const groupsUrl = "GET /api/v1/orgs/o1/conversations/groups";

  it("the filter asks the kernel with q and state; an empty q is omitted", async () => {
    const calls = stubApi({
      [groupsUrl]: () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c1", "a1", "整理要点")])],
          next: null,
          archivedCount: 0,
        }),
    });
    show("o1");
    await screen.findByRole("link", { name: "整理要点" });
    const user = userEvent.setup();
    await user.click(within(section()).getByRole("button", { name: "筛选会话" }));
    await user.type(screen.getByRole("textbox", { name: "按标题搜索" }), "要点");
    await vi.waitFor(() =>
      expect(calls.at(-1)?.url).toBe("/api/v1/orgs/o1/conversations/groups?q=%E8%A6%81%E7%82%B9"),
    );
    await user.clear(screen.getByRole("textbox", { name: "按标题搜索" }));
    await user.click(screen.getByRole("radio", { name: "运行中" }));
    await vi.waitFor(() =>
      expect(calls.at(-1)?.url).toBe("/api/v1/orgs/o1/conversations/groups?state=running"),
    );
    expect(calls.some((c) => c.url.includes("q=&") || c.url.endsWith("q="))).toBe(false);
  });

  it("archive refreshes the groups and the archived count", async () => {
    let archived = false;
    const calls = stubApi({
      [groupsUrl]: () =>
        json(200, {
          groups: archived ? [] : [group("a1", "研究助手", [conv("c1", "a1", "一")])],
          next: null,
          archivedCount: archived ? 1 : 0,
        }),
      "PATCH /api/v1/orgs/o1/conversations/c1": () => {
        archived = true;
        return json(200, { conversation: conv("c1", "a1", "一") });
      },
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    expect(within(section()).queryByRole("button", { name: /已归档/ })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "会话操作：一" }));
    await user.click(await screen.findByRole("menuitem", { name: "归档" }));
    expect(await within(section()).findByRole("button", { name: "已归档 · 1" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "一" })).toBeNull();
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ archived: true });
  });

  it("the archived list loads ?archived=1 groups in place; unarchive returns the row", async () => {
    let archived = true;
    const calls = stubApi({
      [groupsUrl]: () =>
        json(200, {
          groups: archived ? [] : [group("a1", "研究助手", [conv("c1", "a1", "旧的")])],
          next: null,
          archivedCount: archived ? 1 : 0,
        }),
      "GET /api/v1/orgs/o1/conversations/groups?archived=1": () =>
        json(200, {
          groups: archived ? [group("a1", "研究助手", [conv("c1", "a1", "旧的")])] : [],
          next: null,
          archivedCount: archived ? 1 : 0,
        }),
      "PATCH /api/v1/orgs/o1/conversations/c1": () => {
        archived = false;
        return json(200, { conversation: conv("c1", "a1", "旧的") });
      },
    });
    show("o1");
    const user = userEvent.setup();
    await user.click(await within(section()).findByRole("button", { name: "已归档 · 1" }));
    expect(await screen.findByRole("link", { name: "旧的" })).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/groups?archived=1"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "会话操作：旧的" }));
    await user.click(await screen.findByRole("menuitem", { name: "取消归档" }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ archived: false }),
    );
    // the archived view stays open, now empty, and its count follows
    expect(await within(section()).findByText("没有已归档的会话。")).toBeTruthy();
    expect(
      within(section()).getByRole("button", { name: "返回会话列表：已归档 · 0" }),
    ).toBeTruthy();
  });

  it("deleting the open conversation navigates to /chat", async () => {
    let deleted = false;
    const calls = stubApi({
      [groupsUrl]: () =>
        json(200, {
          groups: deleted ? [] : [group("a1", "研究助手", [conv("c1", "a1", "当前的")])],
          next: null,
          archivedCount: 0,
        }),
      "DELETE /api/v1/orgs/o1/conversations/c1": () => {
        deleted = true;
        return noContent();
      },
    });
    show("o1", "/chat/c1");
    await screen.findByRole("link", { name: "当前的" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "会话操作：当前的" }));
    await user.click(await screen.findByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除会话？" });
    await user.click(within(dialog).getByRole("button", { name: "删除" }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("deleting another conversation stays on the page", async () => {
    stubApi({
      [groupsUrl]: () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c1", "a1", "当前的"), conv("c2", "a1", "别的")])],
          next: null,
          archivedCount: 0,
        }),
      "DELETE /api/v1/orgs/o1/conversations/c2": () => noContent(),
    });
    show("o1", "/chat/c1");
    await screen.findByRole("link", { name: "别的" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "会话操作：别的" }));
    await user.click(await screen.findByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除会话？" });
    await user.click(within(dialog).getByRole("button", { name: "删除" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a failed action reports the error", async () => {
    stubApi({
      [groupsUrl]: () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c1", "a1", "一")])],
          next: null,
          archivedCount: 0,
        }),
      "PATCH /api/v1/orgs/o1/conversations/c1": () =>
        json(500, { error: { code: "internal", message: "x" } }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "会话操作：一" }));
    await user.click(await screen.findByRole("menuitem", { name: "归档" }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("link", { name: "一" })).toBeTruthy();
  });
});

describe("useConversationGroups refresh drops rows that left the view (review r1)", () => {
  const groupsUrl = "GET /api/v1/orgs/o1/conversations/groups";
  const at = (id: string, agentId: string, title: string, updatedAt: string) => ({
    ...conv(id, agentId, title),
    updatedAt,
  });

  it("an external archive disappears after the refresh; an older More row stays", async () => {
    // pages of two rows: c4 c3 | c2 c1; c3 is archived elsewhere, so page 1 becomes c4 c2
    const c4 = at("c4", "a1", "四", "2026-10-20T10:00:00.000Z");
    const c3 = at("c3", "a1", "三", "2026-10-20T09:00:00.000Z");
    const c2 = at("c2", "a1", "二", "2026-10-20T08:00:00.000Z");
    const c1 = at("c1", "a1", "一", "2026-10-20T07:00:00.000Z");
    let archivedElsewhere = false;
    stubApi({
      [groupsUrl]: () =>
        json(200, {
          groups: [group("a1", "研究助手", archivedElsewhere ? [c4, c2] : [c4, c3], true)],
          next: null,
          archivedCount: archivedElsewhere ? 1 : 0,
        }),
      "GET /api/v1/orgs/o1/conversations?agentId=a1&after=c3": () =>
        json(200, { conversations: [c2, c1], next: null }),
    });
    show("o1");
    await screen.findByRole("link", { name: "三" });
    await userEvent.click(within(section()).getByRole("button", { name: "显示更多" }));
    await screen.findByRole("link", { name: "一" });
    archivedElsewhere = true;
    await act(async () => {
      window.dispatchEvent(new Event("cap:conversations-changed"));
    });
    await vi.waitFor(() => expect(screen.queryByRole("link", { name: "三" })).toBeNull());
    const names = within(section())
      .getAllByRole("link")
      .map((l) => l.textContent);
    expect(names).toEqual(["四", "二", "一"]);
  });

  it("a fresh page that is complete (no more) drops every row it lacks", async () => {
    let stopped = false;
    stubApi({
      [groupsUrl]: () =>
        json(200, {
          groups: [
            group(
              "a1",
              "研究助手",
              stopped
                ? [at("c3", "a1", "三", "2026-10-20T09:00:00.000Z")]
                : [
                    at("c3", "a1", "三", "2026-10-20T09:00:00.000Z"),
                    at("c1", "a1", "一", "2026-10-20T07:00:00.000Z"),
                  ],
            ),
          ],
          next: null,
          archivedCount: 0,
        }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    stopped = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() => expect(screen.queryByRole("link", { name: "一" })).toBeNull());
  });

  it("a group loaded with More groups that the server no longer returns goes", async () => {
    let gone = false;
    stubApi({
      [groupsUrl]: () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c1", "a1", "一")])],
          next: gone ? null : "a1",
          archivedCount: 0,
        }),
      "GET /api/v1/orgs/o1/conversations/groups?after=a1": () =>
        json(200, { groups: [group("a2", "客服分流", [conv("c9", "a2", "九")])], next: null }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    await userEvent.click(screen.getByRole("button", { name: "更多分组" }));
    await screen.findByRole("link", { name: "九" });
    gone = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() => expect(screen.queryByRole("link", { name: "九" })).toBeNull());
  });

  it("archiving the only row of a group with more drops the group header at once", async () => {
    let n = 0;
    stubApi({
      [groupsUrl]: () => {
        n += 1;
        if (n > 1) return new Promise<Response>(() => {});
        return json(200, {
          groups: [
            group("a1", "研究助手", [conv("c1", "a1", "一")]),
            group("a2", "客服分流", [conv("c9", "a2", "九")], true),
          ],
          next: null,
          archivedCount: 0,
        });
      },
      "PATCH /api/v1/orgs/o1/conversations/c9": () =>
        json(200, { conversation: conv("c9", "a2", "九") }),
    });
    show("o1");
    await screen.findByRole("link", { name: "九" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "会话操作：九" }));
    await user.click(await screen.findByRole("menuitem", { name: "归档" }));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "客服分流" })).toBeNull());
    expect(screen.getByRole("button", { name: "研究助手" })).toBeTruthy();
  });
});

describe("useConversationGroups filter races (review r1)", () => {
  const groupsUrl = "GET /api/v1/orgs/o1/conversations/groups";

  it("a filter change keeps the rows shown while the new answer loads", async () => {
    stubApi({
      [groupsUrl]: () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c1", "a1", "一")])],
          next: null,
          archivedCount: 0,
        }),
      "GET /api/v1/orgs/o1/conversations/groups?state=running": () =>
        new Promise<Response>(() => {}),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    const user = userEvent.setup();
    await user.click(within(section()).getByRole("button", { name: "筛选会话" }));
    await user.click(screen.getByRole("radio", { name: "全部" }));
    await user.click(screen.getByRole("radio", { name: "运行中" }));
    expect(section().getAttribute("aria-busy")).not.toBe("true");
    // the rows narrow locally (c1 has no activity) but the section is not a skeleton
    expect(within(section()).getByText("没有匹配的会话")).toBeTruthy();
  });

  it("an answer for the previous filter arriving last is dropped", async () => {
    let releaseOld: (r: Response) => void = () => {};
    let first = true;
    stubApi({
      [groupsUrl]: () => {
        if (first) {
          first = false;
          return json(200, {
            groups: [group("a1", "研究助手", [conv("c1", "a1", "一")])],
            next: null,
            archivedCount: 0,
          });
        }
        return new Promise<Response>((r) => {
          releaseOld = r;
        });
      },
      "GET /api/v1/orgs/o1/conversations/groups?state=waiting": () =>
        json(200, {
          groups: [group("a1", "研究助手", [{ ...conv("c5", "a1", "等我"), activity: "waiting" }])],
          next: null,
          archivedCount: 0,
        }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    // a refresh of the unfiltered list is in flight
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    const user = userEvent.setup();
    await user.click(within(section()).getByRole("button", { name: "筛选会话" }));
    await user.click(screen.getByRole("radio", { name: "等待我" }));
    await screen.findByRole("link", { name: "等我" });
    await act(async () => {
      releaseOld(
        json(200, {
          groups: [group("b9", "旧答复", [{ ...conv("c8", "b9", "过期"), activity: "waiting" }])],
          next: null,
          archivedCount: 0,
        }),
      );
    });
    expect(screen.queryByRole("link", { name: "过期" })).toBeNull();
    expect(screen.getByRole("link", { name: "等我" })).toBeTruthy();
  });

  it("an org switch resets the filter and the archived view", async () => {
    const calls = stubApi({
      [groupsUrl]: () => json(200, { groups: [], next: null, archivedCount: 2 }),
      "GET /api/v1/orgs/o1/conversations/groups?archived=1": () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c1", "a1", "旧的")])],
          next: null,
          archivedCount: 2,
        }),
      "GET /api/v1/orgs/o2/conversations/groups": () =>
        json(200, {
          groups: [group("b1", "客服分流", [conv("d1", "b1", "B 的会话")])],
          next: null,
          archivedCount: 0,
        }),
    });
    const r = show("o1");
    const user = userEvent.setup();
    await user.click(await within(section()).findByRole("button", { name: "已归档 · 2" }));
    await screen.findByRole("link", { name: "旧的" });
    r.rerender(frame("o2"));
    expect(await screen.findByRole("link", { name: "B 的会话" })).toBeTruthy();
    expect(within(section()).queryByRole("button", { name: /返回会话列表/ })).toBeNull();
    expect(calls.some((c) => c.url.includes("/orgs/o2/") && c.url.includes("archived"))).toBe(
      false,
    );
  });

  it("a More answer arriving after a view change is ignored", async () => {
    let releaseMore: (r: Response) => void = () => {};
    stubApi({
      [groupsUrl]: () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c1", "a1", "一")], true)],
          next: null,
          archivedCount: 1,
        }),
      "GET /api/v1/orgs/o1/conversations?agentId=a1&after=c1": () =>
        new Promise<Response>((r) => {
          releaseMore = r;
        }),
      "GET /api/v1/orgs/o1/conversations/groups?archived=1": () =>
        json(200, {
          groups: [group("a1", "研究助手", [conv("c7", "a1", "归档的")])],
          next: null,
          archivedCount: 1,
        }),
    });
    show("o1");
    await screen.findByRole("link", { name: "一" });
    const user = userEvent.setup();
    await user.click(within(section()).getByRole("button", { name: "显示更多" }));
    await user.click(within(section()).getByRole("button", { name: "已归档 · 1" }));
    await screen.findByRole("link", { name: "归档的" });
    await act(async () => {
      releaseMore(json(200, { conversations: [conv("c0", "a1", "迟到的")], next: null }));
    });
    expect(screen.queryByRole("link", { name: "迟到的" })).toBeNull();
  });
});
