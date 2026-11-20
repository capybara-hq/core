import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { badgeText, DesignProvider, FloatingIconButton, TOUCH_QUERY } from "../src/index";
import { css, parseCss } from "./css-rules";

afterEach(cleanup);

const ui = (el: React.ReactElement) => render(<DesignProvider locale="en">{el}</DesignProvider>);

describe("badgeText", () => {
  it("is null for 0 or none, 99+ above 99, n+ when truncated", () => {
    expect(badgeText(undefined)).toBeNull();
    expect(badgeText({ count: 0 })).toBeNull();
    expect(badgeText({ count: 3 })).toBe("3");
    expect(badgeText({ count: 3, more: true })).toBe("3+");
    expect(badgeText({ count: 99 })).toBe("99");
    expect(badgeText({ count: 120 })).toBe("99+");
    expect(badgeText({ count: 120, more: true })).toBe("99+");
  });
});

describe("FloatingIconButton", () => {
  it("is a button named by its label and fires onClick", () => {
    const onClick = vi.fn();
    ui(<FloatingIconButton icon="menu" label="Menu" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders the badge text only while the count is above 0", () => {
    const { container, rerender } = ui(
      <FloatingIconButton icon="menu" label="Menu" badge={{ count: 3, more: true }} />,
    );
    expect(container.querySelector(".cb-float-badge")?.textContent).toBe("3+");
    rerender(
      <DesignProvider locale="en">
        <FloatingIconButton icon="menu" label="Menu" badge={{ count: 0 }} />
      </DesignProvider>,
    );
    expect(container.querySelector(".cb-float-badge")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Menu");
  });

  it("renders a link through the design link component with an href", () => {
    ui(<FloatingIconButton icon="arrow-left" label="Back" href="/chat" />);
    const link = screen.getByRole("link", { name: "Back" });
    expect(link.getAttribute("href")).toBe("/chat");
    expect(link.classList.contains("cb-float-btn")).toBe(true);
  });
});

describe("the floating button's CSS", () => {
  const rules = parseCss(css("touch.css"));
  const rule = (at: string | null) =>
    rules.find((r) => r.at === at && r.selector === ".cb-float-btn");

  it("sizes from control.prominent, and from touch.float under the touch query", () => {
    expect(rule(null)?.decls.width).toBe("var(--cb-control-prominent)");
    expect(rule(null)?.decls.height).toBe("var(--cb-control-prominent)");
    expect(rule(TOUCH_QUERY)?.decls.width).toBe("var(--cb-touch-float)");
    expect(rule(TOUCH_QUERY)?.decls.height).toBe("var(--cb-touch-float)");
  });

  it("draws the float ground, hairline and shadow tokens", () => {
    const d = rule(null)?.decls ?? {};
    expect(d.background).toBe("var(--cb-float-ground)");
    expect(d.border).toBe("1px solid var(--cb-float-line)");
    expect(d["box-shadow"]).toBe("var(--cb-shadow-float-touch)");
    expect(d["border-radius"]).toBe("var(--cb-radius-pill)");
  });
});
