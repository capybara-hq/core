import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveConversation,
  type ConversationGroup,
  deleteConversation,
  listConversationGroups,
  listConversations,
} from "../src/lib/conversations";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(body: unknown, status = 200): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${String(input)}${init?.body ? ` ${init.body}` : ""}`);
      return status === 204 ? new Response(null, { status }) : json(status, body);
    }),
  );
  return urls;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

const GROUP: ConversationGroup = {
  agent: { id: "ag 1", name: "研究助手" },
  latestAt: "2026-10-26T12:20:00.000Z",
  conversations: [
    {
      id: "c1",
      orgId: "o/1",
      agentId: "ag 1",
      title: null,
      lastSeq: 0,
      createdAt: "2026-10-26T12:00:00.000Z",
      updatedAt: "2026-10-26T12:20:00.000Z",
    },
  ],
  more: true,
};

describe("listConversationGroups", () => {
  it("GET .../conversations/groups with no query by default", async () => {
    const urls = stubFetch({ groups: [GROUP], next: null });
    const res = await listConversationGroups("o/1");
    expect(urls).toEqual(["GET /api/v1/orgs/o%2F1/conversations/groups"]);
    expect(res).toEqual({ groups: [GROUP], next: null });
  });

  it("encodes perGroup, limit and after", async () => {
    const urls = stubFetch({ groups: [], next: null });
    await listConversationGroups("o1", { perGroup: 3, limit: 10, after: "ag 1&x" });
    expect(urls).toEqual([
      "GET /api/v1/orgs/o1/conversations/groups?perGroup=3&limit=10&after=ag+1%26x",
    ]);
  });
});

describe("listConversations", () => {
  it("filters by agentId and pages with after / limit", async () => {
    const urls = stubFetch({ conversations: GROUP.conversations, next: "c1" });
    const res = await listConversations("o1", { agentId: "ag 1", after: "c0", limit: 20 });
    expect(urls).toEqual(["GET /api/v1/orgs/o1/conversations?agentId=ag+1&after=c0&limit=20"]);
    expect(res.next).toBe("c1");
    expect(res.conversations[0]?.id).toBe("c1");
  });

  it("no options -> no query string", async () => {
    const urls = stubFetch({ conversations: [], next: null });
    await listConversations("o1");
    expect(urls).toEqual(["GET /api/v1/orgs/o1/conversations"]);
  });
});

describe("search, state and the archived list", () => {
  it("groups pass q, state and archived=1; archivedCount comes back", async () => {
    const urls = stubFetch({ groups: [], next: null, archivedCount: 2 });
    const res = await listConversationGroups("o1", {
      q: "要点 a",
      state: "running",
      archived: true,
    });
    expect(urls).toEqual([
      "GET /api/v1/orgs/o1/conversations/groups?q=%E8%A6%81%E7%82%B9+a&state=running&archived=1",
    ]);
    expect(res.archivedCount).toBe(2);
  });

  it("an empty or blank q is omitted (the kernel rejects ?q=), state all is omitted", async () => {
    const urls = stubFetch({ conversations: [], next: null });
    await listConversations("o1", { q: "  ", state: "all", archived: false });
    expect(urls).toEqual(["GET /api/v1/orgs/o1/conversations"]);
  });

  it("the list (a group's More) passes the same options", async () => {
    const urls = stubFetch({ conversations: [], next: null });
    await listConversations("o1", { agentId: "a1", after: "c1", q: "x", archived: true });
    expect(urls).toEqual(["GET /api/v1/orgs/o1/conversations?agentId=a1&after=c1&q=x&archived=1"]);
  });
});

describe("row actions", () => {
  it("archiveConversation PATCHes { archived }", async () => {
    const urls = stubFetch({ conversation: GROUP.conversations[0] });
    await archiveConversation("o1", "c 1", true);
    await archiveConversation("o1", "c 1", false);
    expect(urls).toEqual([
      'PATCH /api/v1/orgs/o1/conversations/c%201 {"archived":true}',
      'PATCH /api/v1/orgs/o1/conversations/c%201 {"archived":false}',
    ]);
  });

  it("deleteConversation sends DELETE (204)", async () => {
    const urls = stubFetch(null, 204);
    await deleteConversation("o1", "c1");
    expect(urls).toEqual(["DELETE /api/v1/orgs/o1/conversations/c1"]);
  });
});
