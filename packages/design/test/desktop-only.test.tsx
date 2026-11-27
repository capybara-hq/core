// The "Manage this on a computer" notice and the touch route gate (mobile touch plan Task 29, Decision 20):
// the server render holds the notice and the page and the touch query shows one; after hydration
// only one is mounted. Presentation only: the kernel decides access.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell, DesignProvider, DesktopOnlyNotice, TOUCH_QUERY } from "../src/index";
import { css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
});

const sidebar = {
  context: { kind: "work" as const, org: null, primary: [], more: [] },
  activeNav: "",
  account: { name: "grant", menu: [] },
};
const notice = (onCopy = () => {}) => ({
  title: "请在电脑上管理",
  description: "插件、扩展、渠道、组织设置和管理后台这类配置，只在电脑上提供。",
  url: "https://capybara.test/settings/members",
  copyLabel: "复制链接",
  backLabel: "回到对话",
  backHref: "/",
  onCopy,
});

function touchWindow(coarse: boolean) {
  const sized = matchMediaFor(390).matchMedia;
  vi.stubGlobal("matchMedia", (q: string) => {
    const t = q.trim();
    if (/pointer/.test(t)) {
      const matches = t.includes("not (any-pointer: fine)")
        ? coarse
        : t === "(any-pointer: fine)"
          ? !coarse
          : coarse;
      return { matches, media: q, addEventListener() {}, removeEventListener() {} };
    }
    return sized(q);
  });
}

const Child = ({ onEffect }: { onEffect?: () => void }) => {
  useEffect(() => onEffect?.(), [onEffect]);
  return <p>成员管理页</p>;
};
const shell = (props: { desktopOnly?: ReturnType<typeof notice>; onEffect?: () => void }) => (
  <DesignProvider locale="zh">
    <AppShell
      sidebar={sidebar}
      pathname="/settings/members"
      {...(props.desktopOnly ? { desktopOnly: props.desktopOnly } : {})}
    >
      <Child {...(props.onEffect ? { onEffect: props.onEffect } : {})} />
    </AppShell>
  </DesignProvider>
);

describe("DesktopOnlyNotice", () => {
  it("is a StatusPage form: title, sentence, the URL in code, copy and back to chat", () => {
    const onCopy = vi.fn();
    const { container } = render(
      <DesignProvider locale="zh">
        <DesktopOnlyNotice {...notice(onCopy)} />
      </DesignProvider>,
    );
    expect(container.querySelector('[data-template="StatusPage"]')).not.toBeNull();
    expect(screen.getAllByRole("heading", { name: "请在电脑上管理" }).length).toBeGreaterThan(0);
    expect(screen.getByText(/只在电脑上提供/)).toBeTruthy();
    expect(container.querySelector('[data-part="desktop-only-url"]')?.textContent).toBe(
      "https://capybara.test/settings/members",
    );
    fireEvent.click(screen.getByRole("button", { name: "复制链接" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    const back = screen.getByRole("link", { name: "回到对话" });
    expect(back.getAttribute("href")).toBe("/");
    expect(back.getAttribute("data-variant")).toBe("primary");
  });
});

describe("the gate in AppShell", () => {
  it("the server render holds the notice and the page", () => {
    const html = renderToString(shell({ desktopOnly: notice() }));
    expect(html).toContain("请在电脑上管理");
    expect(html).toContain("成员管理页");
  });

  it("without desktopOnly the page is drawn alone, with no wrapper or notice", () => {
    const html = renderToString(shell({}));
    expect(html).not.toContain("请在电脑上管理");
    expect(html).not.toContain("desktop-only");
  });

  it("the CSS shows the notice and hides the page only under the touch query", () => {
    const rules = parseCss(css("templates.css"));
    const at = (a: string | null, s: string) => rules.find((r) => r.at === a && r.selector === s);
    expect(at(null, ".cb-desktop-only-notice")?.decls).toMatchObject({ display: "none" });
    expect(at(TOUCH_QUERY, ".cb-desktop-only-notice")?.decls).toMatchObject({ display: "block" });
    expect(at(null, ".cb-desktop-only-page")?.decls).toMatchObject({ display: "contents" });
    expect(at(TOUCH_QUERY, ".cb-desktop-only-page")?.decls).toMatchObject({ display: "none" });
  });

  it("after hydration on touch only the notice is mounted and the page's effect never ran", async () => {
    const onEffect = vi.fn();
    touchWindow(true);
    render(shell({ desktopOnly: notice(), onEffect }));
    await act(async () => {});
    expect(screen.getAllByRole("heading", { name: "请在电脑上管理" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("成员管理页")).toBeNull();
    expect(onEffect).not.toHaveBeenCalled();
  });

  it("with a fine pointer the page is mounted and the notice is not in the DOM", async () => {
    const onEffect = vi.fn();
    touchWindow(false);
    render(shell({ desktopOnly: notice(), onEffect }));
    await act(async () => {});
    expect(screen.getByText("成员管理页")).toBeTruthy();
    expect(screen.queryByText("请在电脑上管理")).toBeNull();
    expect(onEffect).toHaveBeenCalled();
  });
});
