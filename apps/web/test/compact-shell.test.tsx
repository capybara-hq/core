// The compact shell in the app frame (design spec §4.6, §6.45): the bottom navigation from the
// same nav data as the sidebar, on tab roots only, the tab that holds a pushed route current, and
// the pending count on the inbox item.
import { cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNavigation } from "./support/navigation";
import { ME } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

beforeEach(() => resetNavigation("/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bar = () => document.querySelector('[data-part="bottom-nav"]') as HTMLElement | null;
const current = () =>
  [...(bar()?.querySelectorAll('[aria-current="page"]') ?? [])].map((e) =>
    e.getAttribute("data-id"),
  );

describe("the bottom navigation in the frame", () => {
  it("is four links, 会话 · 智能体 · 收件箱 · 我, on a tab root, the item current", () => {
    resetNavigation("/agents");
    renderFrame(shellOf(ME));
    const links = within(bar() as HTMLElement).getAllByRole("link");
    expect(links.map((l) => [l.getAttribute("href"), l.textContent])).toEqual([
      ["/conversations", "会话"],
      ["/agents", "智能体"],
      ["/inbox", "收件箱"],
      ["/me", "我"],
    ]);
    expect(current()).toEqual(["agents"]);
  });

  it("carries the pending count on the inbox item", () => {
    resetNavigation("/inbox");
    renderFrame(shellOf(ME, { pending: { count: 3, more: false } }));
    const inbox = within(bar() as HTMLElement).getByRole("link", { name: "收件箱，3 项待处理" });
    expect(inbox.querySelector('[data-part="item-badge"]')?.textContent).toBe("3");
    expect(current()).toEqual(["inbox"]);
  });

  it.each([
    ["/agents/new", "agents"],
    ["/chat/c1", "chats"],
    ["/", "chats"],
  ])("is hidden on the pushed route %s, where the top bar has back", (path) => {
    resetNavigation(path);
    renderFrame(shellOf(ME));
    expect(bar()).toBeNull();
    const top = document.querySelector('[data-part="top-bar"]') as HTMLElement;
    expect(top.getAttribute("data-pushed")).toBe("true");
  });

  it("keeps the Me tab current on the pages it leads to", () => {
    resetNavigation("/skills");
    renderFrame(shellOf(ME));
    expect(bar()).toBeNull();
    cleanup();
    resetNavigation("/me");
    renderFrame(shellOf(ME));
    expect(current()).toEqual(["me"]);
  });

  it("the setup frame has no bottom navigation", () => {
    renderFrame(
      shellOf(ME, { readiness: { modelProvider: "none", orgFixableProviders: [], agents: 0 } }),
    );
    expect(bar()).toBeNull();
  });
});
