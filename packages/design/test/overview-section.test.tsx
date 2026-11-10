import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OVERVIEW_SECTION_FIXTURE as F } from "../src/fixtures/index";
import { Card, DesignProvider, ItemList, OverviewSection, Text } from "../src/index";
import { findNestedBoxes } from "../src/reference/index";

// OverviewSection (spec §5.6): one section of an overview page, drawn as the one Card, whose body
// is a skeleton while loading, the in-place error line on failure, or the content.

afterEach(cleanup);

const wrap = (ui: ReactNode, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const rows = () => (
  <ItemList
    label={F.title}
    rows={F.rows.map((r) => ({ id: r.id, title: r.title, meta: r.meta }))}
  />
);

describe("OverviewSection", () => {
  it("draws the content in one Card with its title and actions", () => {
    const { container } = wrap(
      <OverviewSection title={F.title} actions={<Text>{F.action}</Text>} state="ready">
        {rows()}
      </OverviewSection>,
    );
    const cards = container.querySelectorAll(".cb-card");
    expect(cards).toHaveLength(1);
    // the loaded state is the reference set's `default`: no data-state, as on a plain Card
    expect(cards[0]?.hasAttribute("data-state")).toBe(false);
    expect(screen.getByText(F.title)).toBeTruthy();
    expect(screen.getByText(F.action)).toBeTruthy();
    expect(screen.getByText(F.rows[0]?.title ?? "")).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("draws the skeleton of the given block shapes, busy, with the title kept", () => {
    const { container } = wrap(
      <OverviewSection
        title={F.title}
        state="loading"
        loading={[
          { kind: "list", items: F.loadingItems },
          { kind: "lines", lines: 3 },
        ]}
      >
        {rows()}
      </OverviewSection>,
    );
    expect(screen.getByText(F.title)).toBeTruthy();
    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy?.getAttribute("aria-label")).toBe(F.title);
    // the list: a label slot over `items` lines; the lines block: 3 lines
    expect(busy?.querySelectorAll('[data-part="skeleton-text"]')).toHaveLength(
      1 + F.loadingItems + 3,
    );
    // the children are not drawn while loading
    expect(screen.queryByText(F.rows[0]?.title ?? "")).toBeNull();
    expect(container.querySelectorAll(".cb-card")).toHaveLength(1);
  });

  it("draws a default skeleton without shapes", () => {
    const { container } = wrap(
      <OverviewSection title={F.title} state="loading">
        {rows()}
      </OverviewSection>,
    );
    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy?.querySelectorAll('[data-part="skeleton-text"]').length).toBeGreaterThan(0);
  });

  it("draws the error line: the sentence, 重试 calls onRetry, 原始错误 toggles the raw text", async () => {
    const onRetry = vi.fn();
    const { container } = wrap(
      <OverviewSection
        title={F.title}
        state="error"
        error={{ summary: F.errorSummary, detail: F.errorDetail, onRetry }}
      >
        {rows()}
      </OverviewSection>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-part")).toBe("overview-section-error");
    expect(alert.textContent).toContain(F.errorSummary);
    expect(screen.queryByText(F.rows[0]?.title ?? "")).toBeNull();
    expect(container.querySelectorAll(".cb-card")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    expect(screen.queryByText(F.errorDetail)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "原始错误" }));
    expect(screen.getByText(F.errorDetail)).toBeTruthy();
  });

  it("names the retry in English and draws no toggle without a detail", () => {
    wrap(
      <OverviewSection title="Pending" state="error" error={{ summary: "x", onRetry: () => {} }}>
        {null}
      </OverviewSection>,
      "en",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Raw error" })).toBeNull();
  });

  it("is the box: an ItemList inside is not a nested box, a Card inside is", () => {
    const ok = wrap(
      <OverviewSection title={F.title} state="ready">
        {rows()}
      </OverviewSection>,
    );
    expect(findNestedBoxes(ok.container)).toEqual([]);
    cleanup();
    const bad = wrap(
      <OverviewSection title={F.title} state="ready">
        <Card title="inner">x</Card>
      </OverviewSection>,
    );
    const found = findNestedBoxes(bad.container);
    expect(found).toHaveLength(1);
    expect(found[0]?.outer).toBe("Card");
    expect(found[0]?.inner).toBe("Card");
  });
});
