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

function Harness({ orgId, path = "/" }: { orgId: string | null; path?: string }) {
  const conversations = useConversationGroups(orgId, path);
  return <Sidebar {...base} conversations={conversations} mode="full" />;
}

const show = (orgId: string | null, path?: string) =>
  render(
    <DesignProvider locale="zh" link={Link as LinkComponent}>
      <Harness orgId={orgId} {...(path ? { path } : {})} />
    </DesignProvider>,
  );
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

  it("no org: an empty ready list, no request", () => {
    const calls = stubApi({});
    show(null);
    expect(within(section()).getByText("还没有会话，从 Agents 里选一个开始。")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});
