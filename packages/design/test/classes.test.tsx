import { describe, expect, it } from "vitest";
import { css, parseCss } from "./css-rules";

// Mobile layout spec §5.1: what each template's size-class form rests on. Every form is CSS (a page
// never branches on width), so the stylesheet is the thing to prove; the DOM halves are in
// list-detail.test.tsx and templates.test.tsx.

const decl = (file: string, selector: string, prop: string, at: string | null = null) =>
  parseCss(css(file)).find((r) => r.selector === selector && r.at === at)?.decls[prop];

describe("template forms per size class", () => {
  it("ListPage cards: auto-fill columns of at least layout.card-min, so two once two fit", () => {
    expect(decl("card-grid.css", ".cb-card-grid", "grid-template-columns")).toBe(
      "repeat(auto-fill, minmax(min(100%, var(--cb-layout-card-min)), 1fr))",
    );
    expect(css("tokens.css")).toMatch(/--cb-layout-card-min: 280px;/);
  });

  it("FormSection: the 240 label column stacks above the fields while the body is under 792", () => {
    const at = "cb-body (max-width: 791px)";
    expect(decl("templates.css", ".cb-form-section", "grid-template-columns", at)).toBe(
      "minmax(0, 1fr)",
    );
    expect(
      decl("templates.css", ".cb-form-section", "grid-template-columns", "(max-width: 840px)"),
    ).toBe("minmax(0, 1fr)");
  });

  it("SettingsPage: the 200 sub-nav stacks above the content by container; compact is a sticky row", () => {
    expect(
      decl(
        "templates.css",
        ".cb-settings-grid",
        "grid-template-columns",
        "cb-body (max-width: 751px)",
      ),
    ).toBe("minmax(0, 1fr)");
    const compact = "(max-width: 599px)";
    expect(decl("templates.css", ".cb-settings-nav", "position", compact)).toBe("sticky");
    expect(decl("templates.css", ".cb-settings-nav", "flex-direction", compact)).toBe("row");
    expect(decl("templates.css", ".cb-settings-nav", "overflow-x", compact)).toBe("auto");
  });

  it("DetailPage: the tabs scroll sideways at every width, the band is a column", () => {
    expect(decl("display.css", ".cb-tabs", "overflow-x")).toBe("auto");
    expect(decl("templates.css", ".cb-detail-band", "flex-direction")).toBe("column");
  });

  it("OverviewPage: StatCards are 2 x 2 on compact, one row otherwise", () => {
    expect(decl("shell.css", ".cb-stat-cards", "grid-template-columns", "(max-width: 599px)")).toBe(
      "repeat(2, minmax(0, 1fr))",
    );
  });

  it("ScheduleCalendar: the week grid needs a 580 frame (a container query), else the agenda", () => {
    expect(css("schedule-calendar.css")).toMatch(
      /\.cb-scal \{[^}]*container: cb-scal \/ inline-size;/,
    );
    const at = "cb-scal (max-width: 579px)";
    expect(decl("schedule-calendar.css", ".cb-scal-grid", "display", at)).toBe("none");
    expect(decl("schedule-calendar.css", ".cb-scal-agenda", "display", at)).toBe("flex");
  });

  it("TracePage: on compact the waterfall is the page and an open span is its own screen", () => {
    const at = "(max-width: 599px)";
    expect(
      decl(
        "templates.css",
        '.cb-trace[data-open="true"] > .cb-trace-waterfall, .cb-trace[data-open="false"] > .cb-trace-detail',
        "display",
        at,
      ),
    ).toBe("none");
  });
});

describe("SetupPage on compact", () => {
  it("the steps page shows only on compact while open; the setup home hides behind it", () => {
    const at = "(max-width: 599px)";
    expect(decl("templates.css", ".cb-setup-steps-page", "display")).toBe("none");
    expect(decl("templates.css", '.cb-setup-steps-page[data-open="true"]', "display", at)).toBe(
      "block",
    );
    expect(decl("templates.css", '.cb-setup-body[data-steps-open="true"]', "display", at)).toBe(
      "none",
    );
  });
});
