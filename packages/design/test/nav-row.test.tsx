import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, NavRow, TOUCH_QUERY } from "../src/index";
import { findNestedBoxes } from "../src/reference/index";
import { css, parseCss } from "./css-rules";

afterEach(cleanup);
const ui = (el: React.ReactElement) => render(<DesignProvider locale="en">{el}</DesignProvider>);

describe("NavRow", () => {
  it("is a link with an href and a button without", () => {
    ui(
      <>
        <NavRow icon="inbox" label="Inbox" href="/inbox" />
        <NavRow icon="search" label="Search" onSelect={() => {}} />
      </>,
    );
    expect(screen.getByRole("link", { name: "Inbox" }).getAttribute("href")).toBe("/inbox");
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
  });

  it("marks the current row and draws the count and the chevron", () => {
    const { container } = ui(
      <NavRow label="Inbox" href="/inbox" current badge={{ count: 120 }} trailing="chevron" />,
    );
    const row = screen.getByRole("link");
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(row.getAttribute("data-current")).toBe("true");
    expect(container.querySelector(".cb-navrow-badge")?.textContent).toBe("99+");
    expect(container.querySelector(".cb-navrow > .cb-icon")).toBeTruthy();
  });

  it("calls onSelect, and a row that opens a deeper level is not a drawer pick", () => {
    const onSelect = vi.fn();
    ui(
      <>
        <NavRow label="More" trailing="chevron" onSelect={onSelect} />
        <NavRow label="Agents" onSelect={() => {}} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "More" }).hasAttribute("data-drawer-pick")).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Agents" }).hasAttribute("data-drawer-pick")).toBe(
      true,
    );
  });

  it("draws no box of its own", () => {
    ui(<NavRow label="Inbox" href="/inbox" />);
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it("is touch.row high on touch and row.default otherwise, with no border", () => {
    const rules = parseCss(css("touch.css"));
    const row = (at: string | null) =>
      rules.find((r) => r.at === at && r.selector === ".cb-navrow");
    expect(row(null)?.decls["min-height"]).toBe("var(--cb-row-default)");
    expect(row(null)?.decls.border).toBe("0");
    expect(row(TOUCH_QUERY)?.decls["min-height"]).toBe("var(--cb-touch-row)");
  });

  it("keeps the count visible on the current row and the hover ground off touch screens", () => {
    const rules = parseCss(css("touch.css"));
    const badge = rules.find(
      (r) => r.selector === '.cb-navrow[data-current="true"] .cb-navrow-badge',
    );
    expect(badge?.decls.background).toBe("var(--cb-panel)");
    expect(rules.find((r) => r.at === null && r.selector.includes(":hover"))).toBeUndefined();
    expect(rules.some((r) => r.at === "(hover: hover)" && r.selector === ".cb-navrow:hover")).toBe(
      true,
    );
  });
});
