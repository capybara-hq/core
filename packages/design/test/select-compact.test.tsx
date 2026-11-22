// Select on the compact class (interaction spec §2.5 Pickers): the field opens a bottom sheet
// with a radio list instead of the anchored dropdown.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, Field, MENU_FILTER_THRESHOLD, Select } from "../src/index";
import { matchMediaFor, renderAtClass } from "./width";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const MODELS = [
  { value: "fast", label: "快速" },
  { value: "balanced", label: "均衡" },
  { value: "deep", label: "深度" },
];
const MANY = Array.from({ length: MENU_FILTER_THRESHOLD + 5 }, (_, i) => ({
  value: `m${i}`,
  label: `model-${i}`,
}));

describe("Select on compact", () => {
  it("opens a sheet with radio rows", async () => {
    const user = userEvent.setup();
    renderAtClass(
      390,
      <Field label="模型">
        <Select options={MODELS} defaultValue="balanced" />
      </Field>,
    );
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const sheet = await screen.findByRole("dialog", { name: "模型" });
    expect(screen.queryByRole("listbox")).toBeNull();
    const radios = within(sheet).getAllByRole("radio");
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(["fast", "balanced", "deep"]);
    expect(within(sheet).getByRole("radio", { name: "均衡" })).toHaveProperty("checked", true);
    expect(within(sheet).queryByRole("searchbox")).toBeNull();
  });

  it("over 10 options shows a search field that filters", async () => {
    const user = userEvent.setup();
    renderAtClass(390, <Select aria-label="模型" options={MANY} />);
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const sheet = await screen.findByRole("dialog", { name: "模型" });
    const search = within(sheet).getByRole("searchbox");
    await user.type(search, "model-1");
    const names = within(sheet)
      .getAllByRole("radio")
      .map((r) => (r as HTMLInputElement).value);
    expect(names).toContain("m1");
    expect(names).toContain("m10");
    expect(names).not.toContain("m2");
  });

  it("a pick closes the sheet and calls onChange with the selection haptic", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const haptics = vi.fn();
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(
      <DesignProvider locale="zh" native={{ haptics }}>
        <Select aria-label="模型" options={MODELS} defaultValue="balanced" onChange={onChange} />
      </DesignProvider>,
    );
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const sheet = await screen.findByRole("dialog", { name: "模型" });
    fireEvent.click(within(sheet).getByRole("radio", { name: "深度" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].target.value).toBe("deep");
    expect(haptics).toHaveBeenCalledWith("selection");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the anchored listbox at 1440", async () => {
    const user = userEvent.setup();
    renderAtClass(1440, <Select aria-label="模型" options={MODELS} />);
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    expect(await screen.findByRole("listbox")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("tapping the current option closes the sheet without onChange or haptic", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const haptics = vi.fn();
    window.matchMedia = matchMediaFor(390).matchMedia;
    render(
      <DesignProvider locale="zh" native={{ haptics }}>
        <Select aria-label="模型" options={MODELS} defaultValue="balanced" onChange={onChange} />
      </DesignProvider>,
    );
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const sheet = await screen.findByRole("dialog", { name: "模型" });
    await user.click(within(sheet).getByRole("radio", { name: "均衡" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(haptics).not.toHaveBeenCalled();
  });

  it("returns focus to the trigger on close", async () => {
    const user = userEvent.setup();
    renderAtClass(390, <Select aria-label="模型" options={MODELS} />);
    const trigger = screen.getByRole("combobox", { name: "模型" });
    await user.click(trigger);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("back closes the sheet", async () => {
    const user = userEvent.setup();
    const mm = matchMediaFor(390).matchMedia;
    // the overlay history only runs on a touch window
    window.matchMedia = ((q: string) =>
      q.includes("pointer: coarse") || q.includes("not (any-pointer: fine)")
        ? ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} } as never)
        : mm(q)) as typeof window.matchMedia;
    render(
      <DesignProvider locale="zh">
        <Select aria-label="模型" options={MODELS} />
      </DesignProvider>,
    );
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    await screen.findByRole("dialog");
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("ArrowUp opens the sheet, not the listbox", async () => {
    const user = userEvent.setup();
    renderAtClass(390, <Select aria-label="模型" options={MODELS} />);
    screen.getByRole("combobox", { name: "模型" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("arrow keys move the radio choice in the group", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderAtClass(
      390,
      <Select aria-label="模型" options={MODELS} defaultValue="fast" onChange={onChange} />,
    );
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const sheet = await screen.findByRole("dialog");
    within(sheet).getByRole("radio", { name: "快速" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(onChange.mock.calls[0]?.[0].target.value).toBe("balanced");
  });

  it("shows an empty state when the search matches nothing", async () => {
    const user = userEvent.setup();
    renderAtClass(390, <Select aria-label="模型" options={MANY} />);
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const sheet = await screen.findByRole("dialog");
    await user.type(within(sheet).getByRole("searchbox"), "zzz");
    expect(within(sheet).queryAllByRole("radio")).toHaveLength(0);
    expect(within(sheet).getByText("没有匹配项")).toBeTruthy();
  });

  it("an unlabelled select still names its sheet", async () => {
    const user = userEvent.setup();
    renderAtClass(390, <Select options={MODELS} />);
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByRole("dialog", { name: "快速" })).toBeTruthy();
  });

  it("keeps the trigger mounted across the hydration class change", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { container } = render(
      <DesignProvider locale="zh">
        <Select aria-label="模型" options={MODELS} />
      </DesignProvider>,
    );
    const first = container.querySelector("button.cb-select");
    await Promise.resolve();
    expect(container.querySelector("button.cb-select")).toBe(first);
  });
});
