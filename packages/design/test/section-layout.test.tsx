import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesignProvider,
  DetailPage,
  FormPage,
  FormSection,
  formSectionLayout,
  SECTION_COLUMNS_MIN,
  SettingsPage,
  Stack,
} from "../src/index";
import { css, parseCss } from "./css-rules";

// Spec §5.3 "Columns by count": one or two sections stack, three or more stand in columns; the
// template decides from its section count, a page cannot.

afterEach(cleanup);

const header = { path: [{ label: "capybara" }], title: "页面" };
const row = { primary: { label: "保存", onSelect: () => {} } };
const sections = (n: number, prefix = "s") =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).map((id) => (
    <FormSection key={id} id={id} title={`分组 ${id}`}>
      <input aria-label={`字段 ${id}`} />
    </FormSection>
  ));
const layoutOf = (ui: React.ReactElement) => {
  const { container } = render(<DesignProvider locale="zh">{ui}</DesignProvider>);
  const template = container.querySelector(".cb-template");
  if (template === null) throw new Error("no template");
  return formSectionLayout(template);
};

describe("FormSection columns by count", () => {
  it("the threshold is three", () => {
    expect(SECTION_COLUMNS_MIN).toBe(3);
  });

  it.each([
    [1, "stacked"],
    [2, "stacked"],
    [3, "columns"],
    [5, "columns"],
  ] as const)("a FormPage with %i sections is %s", (n, want) => {
    expect(
      layoutOf(
        <FormPage header={header} actionRow={row}>
          {sections(n)}
        </FormPage>,
      ),
    ).toBe(want);
  });

  it("a DetailPage tab counts its own sections, a callout between them included", () => {
    expect(
      layoutOf(
        <DetailPage header={header}>
          <Stack gap={12}>
            {sections(1)}
            <p>说明</p>
            {sections(2, "b")}
          </Stack>
        </DetailPage>,
      ),
    ).toBe("columns");
    cleanup();
    expect(
      layoutOf(
        <DetailPage header={header}>
          <Stack gap={12}>{sections(1)}</Stack>
        </DetailPage>,
      ),
    ).toBe("stacked");
  });

  it("a SettingsPage is stacked whatever its count (its sub-nav is the title column)", () => {
    expect(
      layoutOf(
        <SettingsPage header={header} nav={[]} activeNav="">
          {sections(4)}
        </SettingsPage>,
      ),
    ).toBe("stacked");
  });

  it("FormSection takes no columns layout: only `stacked` can be forced", () => {
    // @ts-expect-error the columns are the template's choice
    const forced = <FormSection id="x" title="x" layout="columns" />;
    expect(forced).toBeTruthy();
  });

  it("three or more sections split across wrappers fail in development and tests", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <DesignProvider locale="zh">
          <FormPage header={header} actionRow={row}>
            <Stack gap={12}>{sections(2)}</Stack>
            <Stack gap={12}>{sections(1, "c")}</Stack>
          </FormPage>
        </DesignProvider>,
      ),
    ).toThrow(/3 sections stand in 2 wrappers/);
    error.mockRestore();
  });

  it("the stylesheet: columns only under the three-sibling :has() rule, never in settings", () => {
    const rules = parseCss(css("templates.css"));
    const columned = rules.filter(
      (r) => r.decls["grid-template-columns"] === "240px minmax(0, 1fr)",
    );
    expect(columned.length).toBe(1);
    expect(columned[0]?.at).toBe("cb-body (min-width: 792px)");
    const selector = (columned[0]?.selector ?? "").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
    expect(selector).toContain(
      ':not([data-template="SettingsPage"]):has(.cb-form-section ~ .cb-form-section ~ .cb-form-section)',
    );
  });
});
