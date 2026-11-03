import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Checkbox, DesignProvider, Field, FieldRow, Input } from "../src/index";

afterEach(cleanup);

const wrap = (ui: ReactElement, locale: "zh" | "en" = "en") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const css = readFileSync(resolve(import.meta.dirname, "../src/styles/field-row.css"), "utf8");

/** The bodies of every `@media (max-width: 639px) {…}` block. */
function narrow(text: string): string {
  const open = "@media (max-width: 639px) {";
  let out = "";
  let at = text.indexOf(open);
  while (at >= 0) {
    let depth = 1;
    let i = at + open.length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    out += `${text.slice(at + open.length, i - 1)}\n`;
    at = text.indexOf(open, i);
  }
  return out;
}

const row = (first: boolean, advanced?: ReactElement) => (
  <FieldRow first={first} {...(advanced ? { advanced } : {})}>
    <Field label="Model ID">
      <Input defaultValue="deepseek-chat" />
    </Field>
    <Field label="Context window">
      <Input defaultValue="128000" />
    </Field>
    <Checkbox checked={false} onChange={() => {}} label="Images" />
  </FieldRow>
);

describe("FieldRow (spec §6.27)", () => {
  it("lays its fields out in one row; labels are drawn on the first row only, named on every row", () => {
    const { container } = wrap(
      <>
        {row(true)}
        {row(false)}
      </>,
    );
    const rows = container.querySelectorAll('[data-part="field-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-first")).toBe("true");
    expect(rows[1]?.getAttribute("data-first")).toBe("false");
    // the label stays the field's accessible name on a later row
    expect(screen.getAllByRole("textbox", { name: "Model ID" })).toHaveLength(2);
    expect(css).toMatch(
      /\.cb-field-row\[data-first="false"\] > \.cb-field-row-fields > \.cb-field > \.cb-field-head \{[^}]*clip-path: inset\(50%\)/,
    );
  });

  it("wraps to a stack below 640, every label drawn again", () => {
    const n = narrow(css);
    expect(n).toMatch(/\.cb-field-row-fields \{[^}]*flex-direction: column;/);
    expect(n).toMatch(
      /\.cb-field-row\[data-first="false"\] > \.cb-field-row-fields > \.cb-field > \.cb-field-head \{[^}]*clip-path: none;/,
    );
  });

  it("puts the row's advanced fields behind an Advanced disclosure", async () => {
    wrap(
      row(
        true,
        <Field label="Stream idle timeout">
          <Input />
        </Field>,
      ),
    );
    const toggle = screen.getByRole("button", { name: "Advanced" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("textbox", { name: "Stream idle timeout" })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const box = screen.getByRole("textbox", { name: "Stream idle timeout" });
    expect(toggle.getAttribute("aria-controls")).toBe(
      box.closest('[data-part="field-row-more"]')?.id,
    );
    cleanup();
    wrap(row(true, <Input aria-label="x" />), "zh");
    expect(screen.getByRole("button", { name: "高级" })).toBeTruthy();
  });

  it("has no Advanced toggle without advanced fields", () => {
    wrap(row(true));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
