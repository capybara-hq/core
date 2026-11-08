// Server-rendered times hydrate with the server's clock and zone, then follow the browser's (CI
// failure of e2e/ssr.spec.ts, 2026-11-04: the old home overview's 「接着上次的会话」 meta was 现在 on
// the server and 1分钟前 in the browser, and Next's error overlay then covered the page). The home
// page is gone (the new conversation is the home); a real route stands in: the service tokens list,
// whose `DateTime` cells write `YYYY-MM-DD HH:mm` in the zone (`useTimeZone`) and the relative age
// as their tooltip (`useNow`).
import { formatDateTime } from "@capybara-hq/design";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** The tokens page's read: one token created at the server's render time, never used. */
function tokenRoutes(): Routes {
  const at = new Date(T).toISOString();
  return {
    "GET /api/v1/orgs/o1/service-tokens": () =>
      json(200, {
        tokens: [
          {
            id: "t1",
            name: "ci",
            role: "member",
            createdAt: at,
            lastUsedAt: null,
            expiresAt: null,
          },
        ],
      }),
  };
}

/** The token's created cell. */
const createdCell = (container: HTMLElement) =>
  container.querySelector(`time[datetime="${new Date(T).toISOString()}"]`) as HTMLElement;

beforeEach(() => {
  resetNavigation("/settings/tokens");
  vi.mocked(navigateBrowser).mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a route's server-rendered times", () => {
  it("a browser clock 61 s ahead hydrates the server's age (现在), then shows its own (1分钟前)", async () => {
    expectNoFirstPaintFetch();
    const { container, errors, html, unmount } = await hydrateRouteWithCache(
      "/settings/tokens",
      tokenRoutes(),
      {
        locale: "zh",
        clock: { now: T, timeZone: browserZone },
        beforeHydrate: () => vi.setSystemTime(T + 61_000),
      },
    );
    expect(html).toContain('title="现在"');
    expect(errors).toEqual([]);
    // right after hydration the browser's clock
    expect(createdCell(container).getAttribute("title")).toBe("1分钟前");
    unmount();
  });

  it("control: without the server's clock the same load mismatches (the CI failure)", async () => {
    expectNoFirstPaintFetch();
    const { errors, unmount } = await hydrateRouteWithCache("/settings/tokens", tokenRoutes(), {
      locale: "zh",
      clock: null,
      beforeHydrate: () => vi.setSystemTime(T + 61_000),
    });
    expect(errors.join("\n")).toMatch(/hydrat|didn't match/i);
    unmount();
  });

  it("a browser in another zone hydrates the server's YYYY-MM-DD HH:mm, then writes its own", async () => {
    expectNoFirstPaintFetch();
    const { container, errors, html, unmount } = await hydrateRouteWithCache(
      "/settings/tokens",
      tokenRoutes(),
      { locale: "zh", clock: { now: T, timeZone: FAR_ZONE } },
    );
    const server = formatDateTime(new Date(T), "full", FAR_ZONE);
    const local = formatDateTime(new Date(T), "full");
    expect(server).not.toBe(local);
    expect(html).toContain(server);
    expect(errors).toEqual([]);
    expect(createdCell(container).textContent).toBe(local);
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
