// Server-rendered times hydrate with the server's clock and zone, then follow the browser's (CI
// failure of e2e/ssr.spec.ts, 2026-11-04: the old home overview's 「接着上次的会话」 meta was 现在 on
// the server and 1分钟前 in the browser, and Next's error overlay then covered the page). The home
// page is gone (the new conversation is the home); the probe below renders the same two kinds of
// time a page renders: a relative age (`useNow`) and an untitled conversation's `MM-DD HH:mm`
// (`useTimeZone`), under the app's DesignRoot as the root layout passes it the server's clock.
import {
  formatDateTime,
  formatRelative,
  type ServerClock,
  untitledLabel,
  useNow,
  useTimeZone,
} from "@capybara-hq/design";
import { act, cleanup, render } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignRoot } from "../src/components/design-root";
import { parseTimeZone, shortTime } from "../src/lib/time";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/** The server's render time: 10:00:30 UTC, so 61 s later the age has crossed a minute. */
const T = Date.parse("2026-11-04T10:00:30.000Z");
/** A zone no test machine runs in (UTC+13:45 in November): its `HH:mm` differs from any other. */
const FAR_ZONE = "Pacific/Chatham";
const browserZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A conversation updated at the server's render time, untitled: its age and its label. */
function Probe() {
  const now = useNow();
  const timeZone = useTimeZone();
  return (
    <p data-testid="probe">
      {`研究助手 · ${formatRelative(new Date(T).toISOString(), "zh", now)}`}
      {" | "}
      {untitledLabel(new Date(T), "zh", timeZone)}
    </p>
  );
}

/** Renders the probe on the "server" at T, then hydrates it in the "browser". */
async function hydrateProbe(opts: { clock?: ServerClock; beforeHydrate?: () => void }) {
  const tree = (
    <DesignRoot locale="zh" {...(opts.clock !== undefined && { clock: opts.clock })}>
      <Probe />
    </DesignRoot>
  );
  const html = renderToString(tree);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  opts.beforeHydrate?.();
  const errors: string[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const text = args.map(String).join(" ");
    if (/hydrat|didn't match/i.test(text)) errors.push(text);
  });
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, tree, { onRecoverableError: (e) => errors.push(String(e)) });
    });
  } finally {
    consoleError.mockRestore();
  }
  const text = () => container.querySelector('[data-testid="probe"]')?.textContent ?? "";
  const unmount = () => {
    act(() => root?.unmount());
    container.remove();
  };
  return { html, errors, text, unmount };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("server-rendered times", () => {
  it("a browser clock 61 s ahead hydrates the server's age (现在), then shows its own (1分钟前)", async () => {
    const { html, errors, text, unmount } = await hydrateProbe({
      clock: { now: T, timeZone: browserZone },
      beforeHydrate: () => vi.setSystemTime(T + 61_000),
    });
    expect(html).toContain("研究助手 · 现在");
    expect(errors).toEqual([]);
    // right after hydration the browser's clock
    expect(text()).toContain("研究助手 · 1分钟前");
    unmount();
  });

  it("control: without the server's clock the same load mismatches (the CI failure)", async () => {
    const { errors, unmount } = await hydrateProbe({
      beforeHydrate: () => vi.setSystemTime(T + 61_000),
    });
    expect(errors.join("\n")).toMatch(/Hydration failed|didn't match/);
    unmount();
  });

  it("a browser in another zone hydrates the server's MM-DD HH:mm, then writes its own", async () => {
    const { html, errors, text, unmount } = await hydrateProbe({
      clock: { now: T, timeZone: FAR_ZONE },
    });
    const server = formatDateTime(new Date(T), "compact", FAR_ZONE);
    const local = formatDateTime(new Date(T), "compact");
    expect(server).not.toBe(local);
    expect(html).toContain(`未命名会话 · ${server}`);
    expect(errors).toEqual([]);
    expect(text()).toContain(`未命名会话 · ${local}`);
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
