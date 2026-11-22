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
  const rules = parseCss(css("display.css")).filter(
    (r) => r.at === "not all and (min-width: 600px)",
  );
  const find = (selector: string) =>
    rules.find((r) =>
      r.selector
        .split(",")
        .map((s) => s.trim())
        .includes(selector),
    );

  it("below 600 (ClassForms' query) the tabs share the width equally at control.default", () => {
    expect(find('.cb-tabs[data-look="segmented-compact"] > .cb-tab')?.decls.flex).toBe("1 1 0");
    expect(find('.cb-tabs[data-look="segmented-compact"]')?.decls.height).toBe(
      "var(--cb-control-default)",
    );
  });

  it("the tabs fill the whole box, so nothing is clipped and the hit area is the box's 44", () => {
    const box = find('.cb-tabs[data-look="segmented-compact"]')?.decls ?? {};
    const tab = find('.cb-tabs[data-look="segmented-compact"] > .cb-tab')?.decls ?? {};
    expect(tab.height).toBe("100%");
    expect(tab["min-height"]).toBeUndefined();
    // the frame line is an inset outline: it takes no room from the tabs and paints over them
    expect(box.border).toBe("0");
    expect(box.outline).toBe("1px solid var(--cb-line)");
    expect(box["outline-offset"]).toBe("-1px");
  });

  it("the selected tab takes the selected ground and tabs keep the touch padding", () => {
    const sel = find('.cb-tabs[data-look="segmented-compact"] > .cb-tab[data-state="selected"]');
    expect(sel?.decls.background).toBe("var(--cb-selected)");
    expect(find('.cb-tabs[data-look="segmented-compact"] > .cb-tab')?.decls.padding).toBe(
      "0 var(--cb-space-4)",
    );
  });
});
