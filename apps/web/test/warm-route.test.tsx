// Touch prefetch (mobile spec §7.3): a link warms its route's queries on pointerdown, a
// conversation row does it when it scrolls into view, each at most once while fresh.
import { Sidebar, useDesignLink } from "@capybara-hq/design";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignRoot } from "../src/components/design-root";
import { useConversationGroups } from "../src/components/shell/conversations";
import { meQuery } from "../src/lib/query/shell";
import { warmRoute } from "../src/lib/query/warm";
import { json, stubApi } from "./support/api";
import { snapshotDefaults } from "./support/conversation";
import { resetNavigation, router } from "./support/navigation";
import { ME, testQueryClient } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

beforeEach(() => resetNavigation("/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONV = {
  id: "c1",
  orgId: "o1",
  agentId: "a1",
  title: "One",
  titleSource: null,
  deviceId: null,
  activity: null,
  lastSeq: 0,
  createdAt: "2026-10-20T06:32:00.000Z",
  updatedAt: "2026-10-20T06:32:00.000Z",
};

const hit = (body: unknown) => () => json(200, body);
/** The routes of the conversation page's first paint. */
const chatRoutes = () => ({
  ...snapshotDefaults("c1"),
  "GET /api/v1/orgs/o1/conversations/c1": hit({ conversation: CONV }),
  "GET /api/v1/orgs/o1/conversations/c1/events": hit({ events: [], turnsBefore: 0 }),
});
const stubChat = () => stubApi(chatRoutes());
const reads = (calls: { url: string }[], part: string) =>
  calls.filter((c) => c.url.includes(part)).length;

function App({ href, client }: { href: string; client: ReturnType<typeof testQueryClient> }) {
  return (
    <QueryClientProvider client={client}>
      <DesignRoot locale="en">
        <RealLink href={href} />
      </DesignRoot>
    </QueryClientProvider>
  );
}
function RealLink({ href }: { href: string }) {
  const L = useDesignLink();
  return <L href={href}>go</L>;
}

function seeded() {
  const client = testQueryClient();
  client.setQueryData(meQuery().queryKey, ME);
  return client;
}

describe("warmRoute on pointerdown", () => {
  it("warms /chat/c1 once; a second pointerdown within freshness reads nothing", async () => {
    const calls = stubChat();
    const client = seeded();
    render(<App href="/chat/c1" client={client} />);
    fireEvent.pointerDown(screen.getByRole("link", { name: "go" }));
    await vi.waitFor(() => expect(reads(calls, "/conversations/c1/queue")).toBe(1));
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    expect(router.prefetch).toHaveBeenCalledWith("/chat/c1");
    const before = calls.length;
    fireEvent.pointerDown(screen.getByRole("link", { name: "go" }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.length).toBe(before);
  });

  it("a warm without a router does not use up the prefetch window", async () => {
    stubChat();
    const client = seeded();
    const ctx = {
      params: {},
      search: new URLSearchParams(),
      me: ME,
      orgId: "o1",
      locale: "en" as const,
      cookie: () => undefined,
      now: Date.now(),
    };
    await warmRoute(client, "/chat/c9", ctx);
    const prefetch = vi.fn();
    await warmRoute(client, "/chat/c9", ctx, { prefetch });
    expect(prefetch).toHaveBeenCalledWith("/chat/c9");
  });

  it.each([["https://example.com/chat/c1"], ["//example.com/chat/c1"], ["/no/such/page"]])(
    "reads nothing for %s",
    async (href) => {
      const calls = stubChat();
      render(<App href={href} client={seeded()} />);
      fireEvent.pointerDown(screen.getByRole("link", { name: "go" }));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(calls).toEqual([]);
    },
  );
});

describe("a conversation row in view", () => {
  class FakeObserver {
    static all: FakeObserver[] = [];
    els = new Set<Element>();
    constructor(private readonly cb: IntersectionObserverCallback) {
      FakeObserver.all.push(this);
    }
    observe(el: Element) {
      this.els.add(el);
    }
    unobserve(el: Element) {
      this.els.delete(el);
    }
    disconnect() {
      this.els.clear();
    }
    show() {
      const targets = [...this.els];
      this.cb(
        targets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
        this as unknown as IntersectionObserver,
      );
    }
  }

  function Rows({ client }: { client: ReturnType<typeof testQueryClient> }) {
    return (
      <QueryClientProvider client={client}>
        <DesignRoot locale="en">
          <Harness />
        </DesignRoot>
      </QueryClientProvider>
    );
  }
  // the real sidebar draws the rows; each reports through `onVisible`
  function Harness() {
    const conversations = useConversationGroups("o1", "/");
    return (
      <Sidebar
        context={{ kind: "work", org: null, primary: [], more: [] }}
        newConversation={{ href: "/agents" }}
        activeNav=""
        account={{ name: "Grant", menu: [] }}
        onOpenCommands={() => {}}
        conversations={conversations}
        mode="full"
      />
    );
  }

  it("warms its conversation once, however often it re-enters the view", async () => {
    FakeObserver.all = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    // a touch device: only its rows warm on scroll
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const chat = stubApiWithGroups();
    const client = seeded();
    render(<Rows client={client} />);
    await screen.findByRole("link", { name: "One" });
    expect(reads(chat, "/conversations/c1/queue")).toBe(0);
    await act(async () => {
      for (const o of FakeObserver.all) o.show();
    });
    await vi.waitFor(() => expect(reads(chat, "/conversations/c1/queue")).toBe(1));
    await act(async () => {
      for (const o of FakeObserver.all) o.show();
    });
    expect(reads(chat, "/conversations/c1/queue")).toBe(1);
  });
});

function stubApiWithGroups() {
  return stubApi({
    ...chatRoutes(),
    "GET /api/v1/orgs/o1/conversations/groups": hit({
      groups: [
        {
          agent: { id: "a1", name: "A", profile: null },
          latestAt: CONV.updatedAt,
          conversations: [CONV],
          more: false,
        },
      ],
      next: null,
    }),
  });
}
