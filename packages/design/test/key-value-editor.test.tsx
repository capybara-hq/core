import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, KeyValueEditor } from "../src/index";

afterEach(cleanup);

const wrap = (ui: ReactElement, locale: "zh" | "en" = "en") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

function Host({
  initial,
  onChange,
}: {
  initial: [string, string][];
  onChange?: (v: unknown) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <KeyValueEditor
      label="Headers"
      keyLabel="Name"
      valueLabel="Value"
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

describe("KeyValueEditor (spec §6.28)", () => {
  it("is a labelled group of key / value rows with column labels", () => {
    wrap(<Host initial={[["X-Org", "acme"]]} />);
    expect(screen.getByRole("group", { name: "Headers" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Name 1" }) as HTMLInputElement).value).toBe(
      "X-Org",
    );
    expect((screen.getByRole("textbox", { name: "Value 1" }) as HTMLInputElement).value).toBe(
      "acme",
    );
  });

  it("adds a row and focuses its key", async () => {
    const onChange = vi.fn();
    wrap(<Host initial={[["a", "1"]]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onChange).toHaveBeenLastCalledWith([
      ["a", "1"],
      ["", ""],
    ]);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name 2" }));
  });

  it("edits a key and a value", async () => {
    const onChange = vi.fn();
    wrap(<Host initial={[["a", "1"]]} onChange={onChange} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Name 1" }), "b");
    await userEvent.type(screen.getByRole("textbox", { name: "Value 1" }), "2");
    expect(onChange).toHaveBeenLastCalledWith([["ab", "12"]]);
  });

  it("removes a row", async () => {
    const onChange = vi.fn();
    wrap(
      <Host
        initial={[
          ["a", "1"],
          ["b", "2"],
        ]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove a" }));
    expect(onChange).toHaveBeenLastCalledWith([["b", "2"]]);
    expect((screen.getByRole("textbox", { name: "Name 1" }) as HTMLInputElement).value).toBe("b");
  });

  it("disabled disables the inputs, add and remove", () => {
    wrap(
      <KeyValueEditor
        label="Headers"
        keyLabel="Name"
        valueLabel="Value"
        value={[["a", "1"]]}
        onChange={() => {}}
        disabled
      />,
      "zh",
    );
    expect(screen.getByRole("textbox", { name: "Name 1" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "添加" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "移除 a" })).toHaveProperty("disabled", true);
  });
});
