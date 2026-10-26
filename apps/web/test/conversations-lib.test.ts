import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConversationGroup,
  listConversationGroups,
  listConversations,
} from "../src/lib/conversations";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(body: unknown): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json(200, body);
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
    expect(urls).toEqual(["/api/v1/orgs/o%2F1/conversations/groups"]);
    expect(res).toEqual({ groups: [GROUP], next: null });
  });

  it("encodes perGroup, limit and after", async () => {
    const urls = stubFetch({ groups: [], next: null });
    await listConversationGroups("o1", { perGroup: 3, limit: 10, after: "ag 1&x" });
    expect(urls).toEqual([
      "/api/v1/orgs/o1/conversations/groups?perGroup=3&limit=10&after=ag+1%26x",
    ]);
  });
});

describe("listConversations", () => {
  it("filters by agentId and pages with after / limit", async () => {
    const urls = stubFetch({ conversations: GROUP.conversations, next: "c1" });
    const res = await listConversations("o1", { agentId: "ag 1", after: "c0", limit: 20 });
    expect(urls).toEqual(["/api/v1/orgs/o1/conversations?agentId=ag+1&after=c0&limit=20"]);
    expect(res.next).toBe("c1");
    expect(res.conversations[0]?.id).toBe("c1");
  });

  it("no options -> no query string", async () => {
    const urls = stubFetch({ conversations: [], next: null });
    await listConversations("o1");
    expect(urls).toEqual(["/api/v1/orgs/o1/conversations"]);
  });
});
