import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRINCIPAL_PICKER_FIXTURE as F } from "../src/fixtures/index";
import {
  DesignProvider,
  type PrincipalOption,
  PrincipalPicker,
  type PrincipalPickerProps,
} from "../src/index";
import { renderAtClass } from "./width";

// PrincipalPicker (spec §6.70; plugin full pages design §7): a combobox that picks people and
// agents, with search, groups, hints, one or many, and a bottom sheet on compact.

const real = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = real;
});

const OPTIONS: PrincipalOption[] = F.options.map((o) => ({ ...o }));

function props(over: Partial<PrincipalPickerProps> = {}): PrincipalPickerProps {
  return {
    options: OPTIONS,
    value: [],
    onChange: vi.fn(),
    "aria-label": F.label,
    ...over,
  };
}

/** A picker that keeps its own value, so a multi pick shows its checks. */
function Held(p: Partial<PrincipalPickerProps> & { start?: string[] }) {
  const [value, setValue] = useState<string[]>(p.start ?? []);
  const { start: _, onChange, ...rest } = p;
  return (
    <PrincipalPicker
      {...props(rest)}
      value={value}
      onChange={(ids) => {
        setValue(ids);
        onChange?.(ids);
      }}
    />
  );
}

const trigger = () => screen.getByRole("combobox", { name: F.label });
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return screen.findByRole("listbox");
}
const search = () => screen.getByRole("combobox", { name: "搜索人员或智能体" });
const names = (list: HTMLElement) =>
  within(list)
    .getAllByRole("option")
    .map((o) => o.querySelector('[data-part="principal-picker-name"]')?.textContent);

function mount(p: Partial<PrincipalPickerProps> = {}) {
  const all = props(p);
  render(
    <DesignProvider locale="zh">
      <PrincipalPicker {...all} />
    </DesignProvider>,
  );
  return all;
}

describe("PrincipalPicker", () => {
  it("shows the placeholder, then the chosen name, closed", () => {
    mount({ placeholder: F.placeholder });
    expect(trigger().textContent).toContain(F.placeholder);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    cleanup();
    mount({ value: ["u-zhou", "a-support"], multiple: true });
    expect(trigger().textContent).toContain("周宁");
    expect(trigger().textContent).toContain("+1");
  });

  it("typing filters by name and calls onSearch", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    mount({ onSearch });
    const list = await open(user);
    expect(names(list)).toHaveLength(5);
    await user.type(search(), "grace");
    expect(names(screen.getByRole("listbox"))).toEqual(["Grace Chen"]);
    expect(onSearch).toHaveBeenLastCalledWith("grace");
    await user.clear(search());
    expect(names(screen.getByRole("listbox"))).toHaveLength(5);
    await user.type(search(), "没有这个人");
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByText("没有匹配项")).toBeTruthy();
  });

  it("groups people and agents under headings when groups", async () => {
    const user = userEvent.setup();
    mount({ groups: true });
    const list = await open(user);
    const people = within(list).getByRole("group", { name: "人员" });
    const agents = within(list).getByRole("group", { name: "智能体" });
    expect(names(people)).toEqual(["林远", "周宁", "Grace Chen"]);
    expect(names(agents)).toEqual(["客服助手", "发票核对"]);
    // a search that leaves only people drops the agents' group with its heading
    await user.type(search(), "周");
    expect(screen.queryByRole("group", { name: "智能体" })).toBeNull();
    expect(screen.getByRole("group", { name: "人员" })).toBeTruthy();
  });

  it("does not draw headings without groups", async () => {
    const user = userEvent.setup();
    mount();
    const list = await open(user);
    expect(within(list).queryByRole("group")).toBeNull();
  });

  it("a single choice calls onChange with the id and closes", async () => {
    const user = userEvent.setup();
    const p = mount();
    await open(user);
    await user.click(screen.getByRole("option", { name: /周宁/ }));
    expect(p.onChange).toHaveBeenCalledWith(["u-zhou"]);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("multiple keeps the popover open and toggles ids", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DesignProvider locale="zh">
        <Held multiple onChange={onChange} />
      </DesignProvider>,
    );
    await open(user);
    expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBe("true");
    await user.click(screen.getByRole("option", { name: /周宁/ }));
    await user.click(screen.getByRole("option", { name: /客服助手/ }));
    expect(onChange).toHaveBeenNthCalledWith(1, ["u-zhou"]);
    expect(onChange).toHaveBeenNthCalledWith(2, ["u-zhou", "a-support"]);
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByRole("option", { name: /周宁/ }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("option", { name: /周宁/ }));
    expect(onChange).toHaveBeenNthCalledWith(3, ["a-support"]);
    expect(screen.getByRole("option", { name: /周宁/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("disabled option cannot be chosen", async () => {
    const user = userEvent.setup();
    const p = mount();
    await open(user);
    const option = screen.getByRole("option", { name: /发票核对/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    await user.click(option);
    expect(p.onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
    // the keyboard skips it
    const input = search();
    for (let i = 0; i < 5; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onChange).not.toHaveBeenCalledWith(["a-invoice"]);
  });

  it("Enter chooses the active option", async () => {
    const user = userEvent.setup();
    const p = mount();
    await open(user);
    const input = search();
    expect(input.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: /林远/ }).id,
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: /Grace Chen/ }).id,
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onChange).toHaveBeenCalledWith(["u-grace"]);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ArrowUp wraps, Home and End jump, Escape closes", async () => {
    const user = userEvent.setup();
    mount();
    await open(user);
    const input = search();
    const active = () => document.getElementById(input.getAttribute("aria-activedescendant") ?? "");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    // the last enabled option: the invoice-check agent is disabled
    expect(active()?.textContent).toContain("客服助手");
    fireEvent.keyDown(input, { key: "Home" });
    expect(active()?.textContent).toContain("林远");
    fireEvent.keyDown(input, { key: "End" });
    expect(active()?.textContent).toContain("客服助手");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("a closed field opens on ArrowDown", () => {
    mount();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("shows a hint under the name and the loading line after the known options", async () => {
    const user = userEvent.setup();
    mount({ loading: true });
    await open(user);
    expect(screen.getByRole("option", { name: /周宁/ }).textContent).toContain("产品经理");
    expect(screen.getByRole("status").textContent).toBe("正在加载");
    expect(screen.getAllByRole("option")).toHaveLength(5);
  });

  it("shows only the loading line when nothing is known yet", async () => {
    const user = userEvent.setup();
    mount({ options: [], loading: true });
    await open(user);
    expect(screen.getByRole("status").textContent).toBe("正在加载");
    expect(screen.queryByText("没有匹配项")).toBeNull();
  });

  it("shows the empty line with no options", async () => {
    const user = userEvent.setup();
    mount({ options: [] });
    await open(user);
    expect(screen.getByText("没有匹配项")).toBeTruthy();
  });

  it("a disabled picker never opens", async () => {
    const user = userEvent.setup();
    mount({ disabled: true });
    await user.click(trigger());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("compact opens a bottom sheet", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderAtClass(390, <PrincipalPicker {...props({ onChange, groups: true })} />);
    await user.click(trigger());
    const sheet = await screen.findByRole("dialog", { name: F.label });
    expect(within(sheet).getByRole("listbox")).toBeTruthy();
    expect(within(sheet).getByRole("group", { name: "智能体" })).toBeTruthy();
    await user.type(within(sheet).getByRole("combobox"), "grace");
    await user.click(within(sheet).getByRole("option", { name: /Grace Chen/ }));
    expect(onChange).toHaveBeenCalledWith(["u-grace"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("compact multiple keeps the sheet open", async () => {
    const user = userEvent.setup();
    renderAtClass(390, <Held multiple />);
    await user.click(trigger());
    const sheet = await screen.findByRole("dialog", { name: F.label });
    await user.click(within(sheet).getByRole("option", { name: /周宁/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(sheet).getByRole("option", { name: /周宁/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("calls onSearch with an empty query when it closes with text typed", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    mount({ onSearch });
    await open(user);
    await user.type(search(), "gr");
    fireEvent.keyDown(search(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onSearch).toHaveBeenLastCalledWith("");
    await open(user);
    expect((search() as HTMLInputElement).value).toBe("");
  });

  it("disabling an open picker closes it and resets the search", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    const ui = (disabled: boolean) => (
      <DesignProvider locale="zh">
        <PrincipalPicker {...props({ onSearch, disabled })} />
      </DesignProvider>
    );
    const { rerender } = render(ui(false));
    await open(user);
    await user.type(search(), "gr");
    rerender(ui(true));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSearch).toHaveBeenLastCalledWith("");
    rerender(ui(false));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Escape closes the compact sheet", async () => {
    const user = userEvent.setup();
    renderAtClass(390, <PrincipalPicker {...props()} />);
    await user.click(trigger());
    const sheet = await screen.findByRole("dialog", { name: F.label });
    fireEvent.keyDown(within(sheet).getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
