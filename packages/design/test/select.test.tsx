import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../src/controls/a11y";
import {
  DesignProvider,
  Field,
  MENU_FILTER_THRESHOLD,
  Select,
  type SelectChangeEvent,
} from "../src/index";
import { optionLabels, optionOf, pickOption } from "./support/select";

/**
 * The form Select (spec §6.2): a `combobox` button opening the design system's anchored listbox
 * (§6.16.3) instead of the browser's popup.
 */
const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

const MODELS = [
  { value: "fast", label: "快速" },
  { value: "balanced", label: "均衡" },
  { value: "deep", label: "深度" },
];
const MANY = Array.from({ length: 40 }, (_, i) => ({ value: `m${i}`, label: `model-${i}` }));

function Controlled({
  options = MODELS,
  initial = "balanced",
  onChange,
}: {
  options?: { value: string; label: string; disabled?: boolean }[];
  initial?: string;
  onChange?: (e: SelectChangeEvent) => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <Field label="模型" help="选一个">
      <Select
        options={options}
        value={v}
        onChange={(e) => {
          onChange?.(e);
          setV(e.target.value);
        }}
      />
    </Field>
  );
}

afterEach(cleanup);

describe("Select: the closed field", () => {
  it("is a combobox button named by its Field label, showing the current option", () => {
    zh(<Controlled />);
    const box = screen.getByLabelText("模型");
    expect(box).toBe(screen.getByRole("combobox", { name: "模型" }));
    expect(box.tagName).toBe("BUTTON");
    expect(box.getAttribute("aria-haspopup")).toBe("listbox");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect((box as HTMLButtonElement).value).toBe("balanced");
    expect(box.getAttribute("aria-describedby")).toBeTruthy();
    expect(box.getAttribute("data-part")).toBe("select");
    expect(box.getAttribute("data-density")).toBe("default");
    // every label sits in the field (its width is the widest option's); only the current one shows
    const shown = box.querySelector('[data-current="true"]');
    expect(shown?.textContent).toBe("均衡");
    expect(box.querySelectorAll('[aria-hidden="true"].cb-select-label')).toHaveLength(2);
    // nothing is a listbox or an option until it opens
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("shows the placeholder, faint, while the value matches no option", () => {
    zh(<Select aria-label="渠道" value="" placeholder="选择渠道" options={MODELS} />);
    const shown = screen
      .getByRole("combobox", { name: "渠道" })
      .querySelector('[data-current="true"]');
    expect(shown?.textContent).toBe("选择渠道");
    expect(shown?.getAttribute("data-placeholder")).toBe("true");
  });

  it("disabled: a disabled button that never opens; invalid: the error state", async () => {
    zh(
      <>
        <Select aria-label="甲" value="fast" options={MODELS} disabled />
        <Field label="乙" error="必须选择">
          <Select options={MODELS} value="fast" />
        </Field>
      </>,
    );
    const a = screen.getByRole("combobox", { name: "甲" }) as HTMLButtonElement;
    expect(a.disabled).toBe(true);
    expect(a.getAttribute("data-state")).toBe("disabled");
    await userEvent.setup().click(a);
    expect(screen.queryByRole("listbox")).toBeNull();
    const b = screen.getByRole("combobox", { name: "乙" });
    expect(b.getAttribute("aria-invalid")).toBe("true");
    expect(b.getAttribute("data-state")).toBe("error");
  });
});

describe("Select: disabled while a save runs", () => {
  it("toggling disabled keeps the same button (no remount, the focus and references stay)", () => {
    const ui = (disabled: boolean) => (
      <DesignProvider locale="zh">
        <Select aria-label="策略" value="fast" options={MODELS} disabled={disabled} />
      </DesignProvider>
    );
    const { rerender } = render(ui(false));
    const before = screen.getByRole("combobox", { name: "策略" });
    rerender(ui(true));
    expect(screen.getByRole("combobox", { name: "策略" })).toBe(before);
    rerender(ui(false));
    expect(screen.getByRole("combobox", { name: "策略" })).toBe(before);
  });
});

describe("Select: a pick that disables the field while it saves", () => {
  it("closes for good: the list does not reopen when the save settles", async () => {
    function Saving() {
      const [v, setV] = useState("fast");
      const [busy, setBusy] = useState(false);
      return (
        <>
          <Select
            aria-label="策略"
            value={v}
            disabled={busy}
            options={MODELS}
            onChange={(e) => {
              setV(e.target.value);
              setBusy(true);
            }}
          />
          <button type="button" onClick={() => setBusy(false)}>
            保存完成
          </button>
        </>
      );
    }
    zh(<Saving />);
    const user = userEvent.setup();
    await pickOption(screen.getByRole("combobox", { name: "策略" }), "deep", user);
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "保存完成" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox", { name: "策略" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });
});

describe("Select: the list", () => {
  it("opens the anchored listbox named like the field, the selected option checked and focused", async () => {
    zh(<Controlled />);
    const user = userEvent.setup();
    const box = screen.getByRole("combobox", { name: "模型" });
    await user.click(box);
    const list = await screen.findByRole("listbox", { name: "模型" });
    expect(list.getAttribute("data-anchored")).toBe("true");
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(box.getAttribute("aria-controls")).toBe(list.id);
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["快速", "均衡", "深度"]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    // the check sits on the selected option only
    expect(options[1]?.querySelector("svg.cb-icon")).toBeTruthy();
    expect(options[0]?.querySelector("svg.cb-icon")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(options[1]));
  });

  it("a click picks: onChange gets a change-like event, the list closes, focus returns", async () => {
    const onChange = vi.fn();
    zh(<Controlled onChange={onChange} />);
    const user = userEvent.setup();
    const box = screen.getByRole("combobox", { name: "模型" });
    await pickOption(box, "deep", user);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({ target: { value: "deep" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((box as HTMLButtonElement).value).toBe("deep");
    expect(document.activeElement).toBe(box);
    // the current option again: no change
    await pickOption(box, "深度", user);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keyboard: ↓ opens, arrows move, Enter picks; Escape closes without a change; Space picks", async () => {
    const onChange = vi.fn();
    zh(<Controlled onChange={onChange} />);
    const user = userEvent.setup();
    const box = screen.getByRole("combobox", { name: "模型" });
    box.focus();
    await user.keyboard("{ArrowDown}");
    const list = await screen.findByRole("listbox");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("均衡"));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ value: "deep" }) }),
    );
    expect(list.isConnected).toBe(false);
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(box);
    // ↑ opens too; Space picks the focused option
    await user.keyboard("{ArrowUp}");
    await screen.findByRole("listbox");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("深度"));
    await user.keyboard("{ArrowUp} ");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ value: "balanced" }) }),
    );
  });

  it("typeahead without a filter: typing moves to the option it starts", async () => {
    zh(
      <Controlled
        initial="a"
        options={[
          { value: "a", label: "alpha" },
          { value: "b", label: "bravo" },
          { value: "c", label: "charlie" },
        ]}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const list = await screen.findByRole("listbox");
    expect(within(list).queryByRole("textbox")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("alpha"));
    await user.keyboard("c");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("charlie"));
  });

  it("a disabled option cannot be picked", async () => {
    const onChange = vi.fn();
    zh(
      <Controlled
        onChange={onChange}
        options={[MODELS[0], { ...MODELS[2], disabled: true }] as typeof MODELS}
        initial="fast"
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const off = optionOf(await screen.findByRole("listbox"), "deep");
    expect(off.getAttribute("data-disabled")).not.toBeNull();
    await user.click(off);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe(`Select: a long list (more than ${MENU_FILTER_THRESHOLD} options)`, () => {
  it("has the menu's filter: focus starts there, typing narrows, Enter picks the first match", async () => {
    const onChange = vi.fn();
    zh(<Controlled options={MANY} initial="m30" onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const list = await screen.findByRole("listbox");
    const filter = within(list).getByRole("textbox", { name: "筛选" });
    await vi.waitFor(() => expect(document.activeElement).toBe(filter));
    await user.keyboard("model-1");
    expect(within(list).getAllByRole("option")).toHaveLength(11);
    await user.keyboard("2{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ value: "m12" }) }),
    );
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("IME composition owns Enter; Space on a focused option picks it", async () => {
    const onChange = vi.fn();
    zh(<Controlled options={MANY} initial="m30" onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const list = await screen.findByRole("listbox");
    const filter = within(list).getByRole("textbox", { name: "筛选" });
    await vi.waitFor(() => expect(document.activeElement).toBe(filter));
    fireEvent.keyDown(filter, { key: "Enter", isComposing: true });
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard("model-3{ArrowDown}{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("model-30");
    await user.keyboard(" ");
    // m30 is the current value: picking it again changes nothing, but the list closes
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("Select in a form", () => {
  it("submits its value under its name and validates required; the copy is hidden from roles", () => {
    const { container } = zh(
      <form>
        <Select
          aria-label="模型"
          name="model"
          required
          value=""
          placeholder="选择"
          options={MODELS}
        />
        <Select aria-label="档位" name="effort" defaultValue="deep" options={MODELS} />
      </form>,
    );
    const form = container.querySelector("form") as HTMLFormElement;
    expect(form.checkValidity()).toBe(false);
    const data = new FormData(form);
    expect(data.get("model")).toBe("");
    expect(data.get("effort")).toBe("deep");
    // the hidden copies are no comboboxes or options, and no field to start on
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(form.querySelector(FIELDS)).toBe(screen.getByRole("combobox", { name: "模型" }));
    expect(screen.getByRole("combobox", { name: "模型" }).getAttribute("aria-required")).toBe(
      "true",
    );
  });

  it("an uncontrolled one keeps the pick; its form copy follows", async () => {
    const { container } = zh(
      <form>
        <Select aria-label="档位" name="effort" defaultValue="fast" options={MODELS} />
      </form>,
    );
    const box = screen.getByRole("combobox", { name: "档位" });
    await pickOption(box, "均衡");
    expect((box as HTMLButtonElement).value).toBe("balanced");
    expect(new FormData(container.querySelector("form") as HTMLFormElement).get("effort")).toBe(
      "balanced",
    );
    expect(await optionLabels(box)).toEqual(["快速", "均衡", "深度"]);
  });
});

describe("Select styles", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../src/styles/controls.css"), "utf8");
  it("the field keeps the input look and shows its focus ring while the list is open", () => {
    expect(css).toMatch(/\.cb-select\[aria-expanded="true"\]/);
    expect(css).toMatch(/\.cb-select-label\[data-current="true"\]\s*\{\s*visibility: visible;/);
  });
});
