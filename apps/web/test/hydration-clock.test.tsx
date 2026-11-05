// Server-rendered times hydrate with the server's clock and zone, then follow the browser's (CI
// failure of e2e/ssr.spec.ts, 2026-11-04: the overview's 「接着上次的会话」 meta was 现在 on the
// server and 1分钟前 in the browser, and Next's error overlay then covered the page).
import { formatDateTime } from "@capybara-hq/design";
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import { DesignRoot } from "../src/components/design-root";
import { navigateBrowser } from "../src/lib/browser";
import { parseTimeZone, shortTime } from "../src/lib/time";
import { json } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { hydrateRouteWithCache } from "./support/query";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

/** The server's render time: 10:00:30 UTC, so 61 s later the age has crossed a minute. */
const T = Date.parse("2026-11-04T10:00:30.000Z");
/** A zone no test machine runs in (UTC+13:45 in November): its `HH:mm` differs from any other. */
const FAR_ZONE = "Pacific/Chatham";
const browserZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The overview's reads: one conversation updated at the server's render time, untitled. */
function overviewRoutes(): Routes {
  const at = new Date(T).toISOString();
  return {
    "GET /api/v1/orgs/o1/agents": () =>
      json(200, {
        agents: [
          { id: "ag1", definition: { name: "研究助手", model: { provider: "f", model: "m" } } },
        ],
      }),
    "GET /api/v1/orgs/o1/models": () =>
      json(200, { providers: [{ provider: "f", models: [{ id: "m" }] }] }),
    "GET /api/v1/orgs/o1/inbox": () => json(200, { truncated: false, items: [] }),
    "GET /api/v1/orgs/o1/conversations/groups": () =>
      json(200, {
        next: null,
        groups: [
          {
            agent: { id: "ag1", name: "研究助手" },
            latestAt: at,
            more: false,
            conversations: [
              { id: "c1", agentId: "ag1", title: null, createdAt: at, updatedAt: at },
            ],
          },
        ],
      }),
    "GET /api/v1/orgs/o1/skills": () => json(200, { skills: [] }),
    "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [] }),
    "GET /api/v1/orgs/o1/members": () => json(200, { members: [{}] }),
  };
}

/** The overview's 「接着上次的会话」 row of c1. */
function recentRow(container: HTMLElement): HTMLElement {
  const list = within(container).getByRole("list", { name: zh.home.recent.title });
  return within(list).getAllByRole("listitem")[0] as HTMLElement;
}

beforeEach(() => {
  resetNavigation("/");
  vi.mocked(navigateBrowser).mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the overview's server-rendered times", () => {
  it("a browser clock 61 s ahead hydrates the server's age (现在), then shows its own (1分钟前)", async () => {
    expectNoFirstPaintFetch();
    const { container, errors, html, unmount } = await hydrateRouteWithCache(
      "/",
      overviewRoutes(),
      {
        locale: "zh",
        clock: { now: T, timeZone: browserZone },
        beforeHydrate: () => vi.setSystemTime(T + 61_000),
      },
    );
    expect(html).toContain("研究助手 · 现在");
    expect(errors).toEqual([]);
    // right after hydration the browser's clock
    expect(recentRow(container).textContent).toContain("研究助手 · 1分钟前");
    unmount();
  });

  it("control: without the server's clock the same load mismatches (the CI failure)", async () => {
    expectNoFirstPaintFetch();
    const { errors, unmount } = await hydrateRouteWithCache("/", overviewRoutes(), {
      locale: "zh",
      beforeHydrate: () => vi.setSystemTime(T + 61_000),
    });
    expect(errors.join("\n")).toMatch(/Hydration failed/);
    unmount();
  });

  it("a browser in another zone hydrates the server's MM-DD HH:mm, then writes its own", async () => {
    expectNoFirstPaintFetch();
    const { container, errors, html, unmount } = await hydrateRouteWithCache(
      "/",
      overviewRoutes(),
      { locale: "zh", clock: { now: T, timeZone: FAR_ZONE } },
    );
    const server = formatDateTime(new Date(T), "compact", FAR_ZONE);
    const local = formatDateTime(new Date(T), "compact");
    expect(server).not.toBe(local);
    expect(html).toContain(`未命名会话 · ${server}`);
    expect(errors).toEqual([]);
    expect(recentRow(container).textContent).toContain(`未命名会话 · ${local}`);
    unmount();
  });
});

describe("the time zone cookie", () => {
  const clear = () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API
    document.cookie = "cb-tz=; max-age=0; path=/";
  };
  afterEach(clear);

  it("DesignRoot saves the browser's zone when the server wrote times in another", () => {
    clear();
    render(
      <DesignRoot locale="zh" clock={{ now: T, timeZone: FAR_ZONE }}>
        <span />
      </DesignRoot>,
    );
    expect(document.cookie).toContain(`cb-tz=${browserZone}`);
  });

  it("and writes nothing when the server already used the browser's zone", () => {
    clear();
    render(
      <DesignRoot locale="zh" clock={{ now: T, timeZone: browserZone }}>
        <span />
      </DesignRoot>,
    );
    expect(document.cookie).not.toContain("cb-tz=");
  });
});

describe("time helpers", () => {
  it("parseTimeZone keeps IANA zones and drops anything else", () => {
    expect(parseTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(parseTimeZone("UTC")).toBe("UTC");
    expect(parseTimeZone(undefined)).toBeUndefined();
    expect(parseTimeZone("")).toBeUndefined();
    expect(parseTimeZone("Not/AZone")).toBeUndefined();
    expect(parseTimeZone("x".repeat(65))).toBeUndefined();
  });

  it("shortTime writes HH:mm in the given zone", () => {
    expect(shortTime("2026-11-04T10:05:00.000Z", "en-GB", "UTC")).toBe("10:05");
    expect(shortTime("2026-11-04T10:05:00.000Z", "en-GB", FAR_ZONE)).toBe("23:50");
  });
});
