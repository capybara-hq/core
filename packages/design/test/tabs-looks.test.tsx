import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, Tabs } from "../src/index";
import { css, parseCss } from "./css-rules";

afterEach(cleanup);

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, label: `Tab ${i}`, count: i }));

const view = (n: number, look?: "underline" | "segmented-compact") =>
  render(
    <DesignProvider locale="zh">
      <Tabs items={items(n)} value="t0" label="views" {...(look ? { look } : {})} />
    </DesignProvider>,
  );

describe("Tabs look", () => {
  it("segmented-compact keeps role tablist and writes data-look", () => {
    view(3, "segmented-compact");
    const list = screen.getByRole("tablist");
    expect(list.getAttribute("data-look")).toBe("segmented-compact");
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getAllByRole("tab")[0]?.getAttribute("data-state")).toBe("selected");
  });

  it("four tabs do not take the segmented look", () => {
    view(4, "segmented-compact");
    expect(screen.getByRole("tablist").hasAttribute("data-look")).toBe(false);
  });

  it("the default look writes no data-look", () => {
    view(3);
    expect(screen.getByRole("tablist").hasAttribute("data-look")).toBe(false);
  });
});

describe("Tabs segmented look CSS", () => {
  const rules = parseCss(css("display.css")).filter((r) => r.at === "(max-width: 599px)");
  const find = (selector: string) =>
    rules.find((r) =>
      r.selector
        .split(",")
        .map((s) => s.trim())
        .includes(selector),
    );

  it("below 600 the tabs share the width equally at control.default / touch.hit", () => {
    expect(find('.cb-tabs[data-look="segmented-compact"] > .cb-tab')?.decls["flex"]).toBe("1 1 0");
    expect(find('.cb-tabs[data-look="segmented-compact"]')?.decls["height"]).toBe(
      "var(--cb-control-default)",
    );
    expect(find('.cb-tabs[data-look="segmented-compact"] > .cb-tab')?.decls["min-height"]).toBe(
      "var(--cb-touch-hit)",
    );
  });
});
