import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClock } from "../src/conversation/clock";
import {
  DateTime,
  DesignProvider,
  formatDateTime,
  formatRelative,
  type ServerClock,
  useNow,
  useTimeZone,
} from "../src/index";

/** The server's render time; 61 s later its age has crossed into the next minute. */
const T = Date.parse("2026-11-04T10:00:30.000Z");
/** A zone no test machine runs in (UTC+13:45 in November). */
const FAR_ZONE = "Pacific/Chatham";
const browserZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

function Age({ iso }: { iso: string }) {
  return <span data-testid="age">{formatRelative(iso, "zh", useNow())}</span>;
}

function Running({ startedAt }: { startedAt: number }) {
  const now = useClock(true, undefined);
  return <span data-testid="running">{`${Math.round((now - startedAt) / 1000)}s`}</span>;
}

function Untitled({ iso }: { iso: string }) {
  return <span data-testid="at">{formatDateTime(iso, "compact", useTimeZone())}</span>;
}

/**
 * Renders `ui` on the "server" with `clock`, moves the browser's clock with `before`, then hydrates
 * the HTML in the browser with the same props. Returns the hydration errors React reported.
 */
async function hydrate(ui: ReactElement, clock: ServerClock | undefined, before?: () => void) {
  const tree = (
    <DesignProvider locale="zh" {...(clock !== undefined && { clock })}>
      {ui}
    </DesignProvider>
  );
  const html = renderToString(tree);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  before?.();
  const errors: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const text = args.map(String).join(" ");
    if (/hydrat|didn't match/i.test(text)) errors.push(text);
  });
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, tree, { onRecoverableError: (e) => errors.push(String(e)) });
    });
  } finally {
    spy.mockRestore();
  }
  const unmount = () => {
    act(() => root?.unmount());
    container.remove();
  };
  return { html, container, errors, unmount };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("hydration with the server's clock", () => {
  const justNow = new Date(T).toISOString();

  it("a relative age: the server's 现在 hydrates, then the browser's clock (61 s ahead) says 1分钟前", async () => {
    const { html, container, errors, unmount } = await hydrate(
      <Age iso={justNow} />,
      { now: T, timeZone: browserZone },
      () => vi.setSystemTime(T + 61_000),
    );
    expect(html).toContain("现在");
    expect(errors).toEqual([]);
    expect(container.textContent).toBe("1分钟前");
    // it keeps following the clock (re-read every 30 s)
    act(() => {
      vi.setSystemTime(T + 121_000);
      vi.advanceTimersByTime(30_000);
    });
    expect(container.textContent).toBe("2分钟前");
    unmount();
  });

  it("control: without the server's clock the same hydration mismatches", async () => {
    const { errors, unmount } = await hydrate(<Age iso={justNow} />, undefined, () =>
      vi.setSystemTime(T + 61_000),
    );
    expect(errors.join("\n")).toMatch(/Hydration failed/);
    unmount();
  });

  it("DateTime: the server's zone and age hydrate, then the browser's zone and age", async () => {
    const minuteAgo = new Date(T - 60_000).toISOString();
    const { html, container, errors, unmount } = await hydrate(
      <DateTime value={minuteAgo} />,
      { now: T, timeZone: FAR_ZONE },
      () => vi.setSystemTime(T + 61_000),
    );
    const server = formatDateTime(minuteAgo, "full", FAR_ZONE);
    expect(server).not.toBe(formatDateTime(minuteAgo));
    expect(html).toContain(server);
    expect(html).toContain('title="1分钟前"');
    expect(errors).toEqual([]);
    const time = container.querySelector("time");
    expect(time?.textContent).toBe(formatDateTime(minuteAgo));
    expect(time?.getAttribute("title")).toBe("2分钟前");
    unmount();
  });

  it("a compact date in the server's zone hydrates, then the browser's zone", async () => {
    const { html, container, errors, unmount } = await hydrate(<Untitled iso={justNow} />, {
      now: T,
      timeZone: FAR_ZONE,
    });
    expect(html).toContain(formatDateTime(justNow, "compact", FAR_ZONE));
    expect(errors).toEqual([]);
    expect(container.textContent).toBe(formatDateTime(justNow, "compact"));
    unmount();
  });

  it("a running duration (useClock) hydrates the server's, then ticks each second", async () => {
    const { html, container, errors, unmount } = await hydrate(
      <Running startedAt={T - 5_000} />,
      { now: T, timeZone: browserZone },
      () => vi.setSystemTime(T + 3_000),
    );
    expect(html).toContain("5s");
    expect(errors).toEqual([]);
    expect(container.textContent).toBe("8s");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toBe("9s");
    unmount();
  });
});

describe("without a server clock (client-only trees, tests)", () => {
  it("useNow and useTimeZone are the browser's at once", () => {
    render(
      <DesignProvider locale="zh">
        <Age iso={new Date(T - 5 * 60_000).toISOString()} />
        <Untitled iso={new Date(T).toISOString()} />
      </DesignProvider>,
    );
    expect(screen.getByTestId("age").textContent).toBe("5分钟前");
    expect(screen.getByTestId("at").textContent).toBe(formatDateTime(new Date(T), "compact"));
  });
});

describe("formatDateTime in a zone", () => {
  it("writes the zone's calendar fields, midnight as 00", () => {
    expect(formatDateTime("2026-11-04T10:05:00.000Z", "full", "UTC")).toBe("2026-11-04 10:05");
    expect(formatDateTime("2026-11-04T10:15:00.000Z", "full", FAR_ZONE)).toBe("2026-11-05 00:00");
    expect(formatDateTime("2026-11-04T10:05:00.000Z", "compact", "Asia/Shanghai")).toBe(
      "11-04 18:05",
    );
  });
});
