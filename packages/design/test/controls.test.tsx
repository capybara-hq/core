import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  Checkbox,
  DesignProvider,
  Field,
  IconButton,
  Input,
  RadioGroup,
  Select,
  Slider,
  Stepper,
  Switch,
  Textarea,
} from "../src/index.js";

const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

describe("Button", () => {
  it("variant / size 暴露为 data 属性", () => {
    zh(<Button variant="primary">保存</Button>);
    const b = screen.getByRole("button", { name: "保存" });
    expect(b.getAttribute("data-variant")).toBe("primary");
    expect(b.getAttribute("data-size")).toBe("28");
  });
  it("loading 禁用、aria-busy、前缀 ⠿", () => {
    zh(<Button loading>保存</Button>);
    const b = screen.getByRole("button");
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.textContent?.startsWith("⠿")).toBe(true);
  });
  it("shortcut 显示", () => {
    zh(<Button shortcut="⌘S">保存</Button>);
    expect(screen.getByRole("button").textContent).toContain("⌘S");
  });
  it("IconButton 以 label 命名", () => {
    zh(<IconButton label="更多" icon={<span aria-hidden>…</span>} />);
    expect(screen.getByRole("button", { name: "更多" })).toBeTruthy();
  });
});

describe("Field + Input", () => {
  it("错误 / 必填 / 计数", () => {
    zh(
      <Field label="名称" required error="名称已存在" count={{ value: 18, max: 200 }}>
        <Input />
      </Field>,
    );
    const input = screen.getByRole("textbox");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-required")).toBe("true");
    const err = screen.getByText("✗ 名称已存在");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(err.id);
    expect(screen.getByText(/^名称/, { selector: "label" }).textContent).toContain("*");
    expect(screen.getByText("18 / 200")).toBeTruthy();
    expect(screen.getByLabelText(/名称/)).toBe(input);
  });
  it("onReset：显示并只调用一次；不传不显示", async () => {
    const onReset = vi.fn();
    const { unmount } = zh(
      <Field label="温度" onReset={onReset}>
        <Input />
      </Field>,
    );
    await userEvent.click(screen.getByRole("button", { name: "↺ 恢复默认" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    unmount();
    zh(
      <Field label="温度">
        <Input />
      </Field>,
    );
    expect(screen.queryByText("↺ 恢复默认")).toBeNull();
  });
});

describe("其他输入", () => {
  it("Textarea code 显示行号，Select 渲染选项，Stepper 增减", async () => {
    const onChange = vi.fn();
    zh(
      <>
        <Textarea code defaultValue={"a\nb\nc"} aria-label="提示词" />
        <Select aria-label="模型" options={[{ value: "x", label: "X 模型" }]} />
        <Stepper label="次数" value={2} min={0} max={3} onChange={onChange} />
      </>,
    );
    expect(document.querySelector("[data-code]")?.textContent).toContain("3");
    expect(screen.getByRole("option", { name: "X 模型" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "+" }));
    expect(onChange).toHaveBeenCalledWith(3);
  });
});

describe("Checkbox / Radio / Switch", () => {
  it("Checkbox 半选与点击", async () => {
    const onChange = vi.fn();
    zh(<Checkbox checked="indeterminate" onChange={onChange} label="全选" />);
    const cb = screen.getByRole("checkbox", { name: "全选" });
    expect(cb.getAttribute("aria-checked")).toBe("mixed");
    await userEvent.click(cb);
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it("RadioGroup card 方向键切换", async () => {
    const onChange = vi.fn();
    zh(
      <RadioGroup
        variant="card"
        label="模式"
        value="a"
        onChange={onChange}
        options={[
          { value: "a", label: "A", description: "说明 A" },
          { value: "b", label: "B" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "模式" })).toBeTruthy();
    const a = screen.getByRole("radio", { name: /A/ });
    a.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenCalledWith("b");
  });
  it("Switch 空格切换", async () => {
    const onChange = vi.fn();
    zh(<Switch checked={false} onChange={onChange} label="启用" />);
    const sw = screen.getByRole("switch", { name: "启用" });
    sw.focus();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Slider", () => {
  it("aria-valuenow 与按键", () => {
    const onChange = vi.fn();
    zh(<Slider label="温度" min={0} max={1} step={0.1} value={0.3} onChange={onChange} />);
    const s = screen.getByRole("slider", { name: "温度" });
    expect(s.getAttribute("aria-valuenow")).toBe("0.3");
    fireEvent.keyDown(s, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(0.4);
    fireEvent.keyDown(s, { key: "PageUp" });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
  it("未设置值时无 aria-valuenow", () => {
    zh(<Slider label="温度" min={0} max={1} step={0.1} value={undefined} onChange={() => {}} />);
    expect(screen.getByRole("slider").hasAttribute("aria-valuenow")).toBe(false);
  });
  it("withInput 数值框联动", () => {
    const onChange = vi.fn();
    zh(
      <Slider label="温度" min={0} max={1} step={0.1} value={0.3} onChange={onChange} withInput />,
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "温度" }), {
      target: { value: "0.7" },
    });
    expect(onChange).toHaveBeenCalledWith(0.7);
  });
});
afterEach(cleanup);
