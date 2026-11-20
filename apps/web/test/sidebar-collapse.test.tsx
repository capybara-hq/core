// The collapsible sidebar (design spec §4.1): the person's choice is held by the frame, written to
// the `cb-sidebar` cookie in the event handler, and drawn by the first paint through the cookie the
// layout reads (`sidebarCollapsed`).
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameElement, renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const real = window.matchMedia;
const widthStub = (width: number) =>
  ((q: string) => {
    const features = [...q.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
    return {
      matches:
        features.length > 0 &&
        features.every(([, k, n]) => (k === "min" ? width >= Number(n) : width <= Number(n))),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }) as unknown as typeof window.matchMedia;

const sidebar = () => document.querySelector('[data-part="sidebar"]') as HTMLElement | null;
const clearCookie = () => {
  // biome-ignore lint/suspicious/noDocumentCookie: a test clears its cookie
  document.cookie = "cb-sidebar=; path=/; max-age=0";
};

beforeEach(() => {
  window.matchMedia = widthStub(1000);
  clearCookie();
});
afterEach(() => {
  cleanup();
  window.matchMedia = real;
  clearCookie();
});

describe("the collapsible sidebar", () => {
  it("expanded: the full sidebar; its toggle collapses it and remembers the choice in the cookie", async () => {
    renderFrame(shellOf());
    expect(sidebar()?.getAttribute("data-mode")).toBe("full");
    await userEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(sidebar()?.getAttribute("data-mode")).toBe("rail");
    expect(document.cookie).toContain("cb-sidebar=rail");
    await userEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(sidebar()?.getAttribute("data-mode")).toBe("full");
    expect(document.cookie).not.toContain("cb-sidebar");
  });

  it("a collapsed cookie draws the rail on the expanded class from the first client render", () => {
    renderFrame(shellOf(), undefined, { sidebarCollapsed: true });
    expect(sidebar()?.getAttribute("data-mode")).toBe("rail");
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeTruthy();
  });

  it("the server render carries the choice on both panels, so CSS draws the right one", async () => {
    const html = renderToString(frameElement(shellOf(), undefined, { sidebarCollapsed: true }));
    expect(html.match(/data-collapsed="true"/g)?.length).toBe(2);
    expect(html).toContain('data-mode="full"');
    expect(html).toContain('data-mode="rail"');
  });

  it("the shortcut toggles it", async () => {
    renderFrame(shellOf());
    await userEvent.keyboard("{Meta>}\\{/Meta}");
    expect(sidebar()?.getAttribute("data-mode")).toBe("rail");
    expect(document.cookie).toContain("cb-sidebar=rail");
  });
});
