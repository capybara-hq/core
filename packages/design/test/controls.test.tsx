import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
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
} from "../src/index";

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
    await userEvent.click(screen.getByRole("button", { name: "增加" }));
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
  it("极小步长（指数写法 1e-8）按键不被取整为 0", () => {
    const onChange = vi.fn();
    zh(<Slider label="eps" min={0} max={1e-6} step={1e-8} value={0} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "eps" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(1e-8);
  });
  it("Stepper 极小步长不被取整", async () => {
    const onChange = vi.fn();
    zh(<Stepper label="eps" value={0} step={1e-7} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "增加" }));
    expect(onChange).toHaveBeenCalledWith(1e-7);
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
  it("withInput 的 placeholder：未设置时数值框留空并显示占位", () => {
    zh(
      <Slider
        label="温度"
        min={0}
        max={2}
        step={0.01}
        value={undefined}
        placeholder="默认（1）"
        onChange={() => {}}
        withInput
      />,
    );
    const box = screen.getByRole("spinbutton", { name: "温度" }) as HTMLInputElement;
    expect(box.value).toBe("");
    expect(box.placeholder).toBe("默认（1）");
  });
});
afterEach(cleanup);

describe("修复轮 1", () => {
  it("Field 把 id / 描述 / invalid 转发到 Slider、Stepper、Checkbox、Switch、RadioGroup", () => {
    zh(
      <>
        <Field label="温度" error="太高">
          <Slider min={0} max={1} step={0.1} value={0.3} onChange={() => {}} label="温度" />
        </Field>
        <Field label="次数" error="太多">
          <Stepper value={1} onChange={() => {}} label="次数" />
        </Field>
        <Field label="同意" error="必选">
          <Checkbox checked={false} onChange={() => {}} />
        </Field>
        <Field label="开关" error="不可">
          <Switch checked={false} onChange={() => {}} label="开关" />
        </Field>
        <Field label="模式" error="错误">
          <RadioGroup
            value="a"
            onChange={() => {}}
            label="模式"
            options={[{ value: "a", label: "A" }]}
          />
        </Field>
      </>,
    );
    const s = screen.getByRole("slider");
    expect(s.getAttribute("aria-invalid")).toBe("true");
    expect(s.getAttribute("aria-describedby")?.split(" ")).toContain(screen.getByText("✗ 太高").id);
    expect(screen.getByLabelText("温度", { selector: "[role=slider]" })).toBe(s);
    for (const [role, msg] of [
      ["spinbutton", "✗ 太多"],
      ["checkbox", "✗ 必选"],
      ["switch", "✗ 不可"],
      ["radiogroup", "✗ 错误"],
    ] as const) {
      const el = screen.getByRole(role);
      expect(el.getAttribute("aria-invalid")).toBe("true");
      expect(el.getAttribute("aria-describedby")?.split(" ")).toContain(screen.getByText(msg).id);
    }
    expect(screen.getByLabelText("同意")).toBe(screen.getByRole("checkbox"));
  });

  it("Slider 指针按下按位置取最近步长", () => {
    const onChange = vi.fn();
    zh(<Slider label="温度" min={0} max={1} step={0.1} value={0.3} onChange={onChange} />);
    const s = screen.getByRole("slider");
    s.getBoundingClientRect = () => ({
      left: 100,
      width: 200,
      top: 0,
      right: 300,
      bottom: 16,
      height: 16,
      x: 100,
      y: 0,
      toJSON() {},
    });
    fireEvent.pointerDown(s, { clientX: 220, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(0.6);
    fireEvent.pointerMove(s, { clientX: 300, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.pointerUp(s, { pointerId: 1 });
    onChange.mockClear();
    fireEvent.pointerMove(s, { clientX: 100, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled：Switch / RadioGroup / Slider / Stepper 不响应", async () => {
    const onChange = vi.fn();
    zh(
      <>
        <Switch checked={false} onChange={onChange} label="s" disabled />
        <RadioGroup
          value="a"
          onChange={onChange}
          label="r"
          disabled
          options={[
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ]}
        />
        <Slider label="sl" min={0} max={1} step={0.1} value={0.3} onChange={onChange} disabled />
        <Stepper label="st" value={1} onChange={onChange} disabled />
      </>,
    );
    await userEvent.click(screen.getByRole("switch"));
    await userEvent.click(screen.getByRole("radio", { name: "B" }));
    const sl = screen.getByRole("slider");
    fireEvent.keyDown(sl, { key: "ArrowRight" });
    fireEvent.pointerDown(sl, { clientX: 10 });
    await userEvent.click(screen.getByRole("button", { name: "增加" }));
    expect(onChange).not.toHaveBeenCalled();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect(sl.getAttribute("aria-disabled")).toBe("true");
    expect((screen.getByRole("button", { name: "减少" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("按钮 hover / active 规则都带 :not(:disabled)，禁用态优先", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles/controls.css"), "utf8");
    const rules = css.match(/^\.cb-btn\[data-variant[^{]*:(hover|active)[^{]*\{/gm) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r).toContain(":not(:disabled)");
    zh(
      <Button variant="primary" disabled>
        x
      </Button>,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("清理：数值框输入中不夹取", () => {
  function StepperHarness({ onChange }: { onChange(n: number): void }) {
    const [v, setV] = useState(10);
    return (
      <Stepper
        label="次数"
        value={v}
        min={10}
        max={20}
        onChange={(n) => {
          setV(n);
          onChange(n);
        }}
      />
    );
  }
  function SliderHarness() {
    const [v, setV] = useState<number | undefined>(12);
    return <Slider label="温度" min={10} max={20} step={0.5} value={v} onChange={setV} withInput />;
  }

  it("Stepper min=10：输入「15」最终为 15（中间的「1」不被夹成 10）", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    zh(<StepperHarness onChange={onChange} />);
    const box = screen.getByRole("spinbutton", { name: "次数" }) as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "15");
    expect(box.value).toBe("15");
    await user.tab();
    expect(box.value).toBe("15");
    expect(onChange).toHaveBeenLastCalledWith(15);
    expect(onChange).not.toHaveBeenCalledWith(10);
  });

  it("Stepper 超出范围在失焦时夹取；回车同样提交", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    zh(<StepperHarness onChange={onChange} />);
    const box = screen.getByRole("spinbutton", { name: "次数" }) as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "99");
    expect(box.value).toBe("99");
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(20);
    expect(box.value).toBe("20");
  });

  it("Stepper 清空后失焦恢复为上一次有效值", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    zh(<StepperHarness onChange={onChange} />);
    const box = screen.getByRole("spinbutton", { name: "次数" }) as HTMLInputElement;
    await user.clear(box);
    expect(box.value).toBe("");
    await user.tab();
    expect(box.value).toBe("10");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Slider withInput：输入「15」得 15；失焦按步长小数位取整、越界夹取、非法恢复", async () => {
    const user = userEvent.setup();
    zh(<SliderHarness />);
    const box = screen.getByRole("spinbutton", { name: "温度" }) as HTMLInputElement;
    const slider = screen.getByRole("slider", { name: "温度" });
    await user.clear(box);
    await user.type(box, "15");
    await user.tab();
    expect(slider.getAttribute("aria-valuenow")).toBe("15");
    await user.clear(box);
    await user.type(box, "25");
    expect(slider.getAttribute("aria-valuenow")).toBe("15");
    await user.tab();
    expect(slider.getAttribute("aria-valuenow")).toBe("20");
    expect(box.value).toBe("20");
    await user.clear(box);
    await user.type(box, "15.33");
    await user.tab();
    expect(box.value).toBe("15.3");
    await user.clear(box);
    await user.type(box, "abc");
    await user.tab();
    expect(box.value).toBe("15.3");
  });
});

describe("清理：Textarea code 行号随滚动", () => {
  it("textarea 滚动时行号栏同步平移，且仍透传 onScroll", () => {
    const onScroll = vi.fn();
    const value = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    zh(<Textarea code aria-label="代码" value={value} readOnly rows={3} onScroll={onScroll} />);
    const ta = screen.getByRole("textbox", { name: "代码" });
    const lines = document.querySelector(".cb-textarea-gutter-lines") as HTMLElement;
    expect(lines.children).toHaveLength(30);
    ta.scrollTop = 120;
    fireEvent.scroll(ta);
    expect(lines.style.transform).toBe("translateY(-120px)");
    expect(onScroll).toHaveBeenCalledTimes(1);
    ta.scrollTop = 0;
    fireEvent.scroll(ta);
    expect(lines.style.transform).toBe("translateY(0px)");
  });
  it("行号栏不参与撑高：行号绝对定位，宽度由最大行号占位决定", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/controls.css"), "utf8");
    expect(css).toMatch(/\.cb-textarea-gutter-lines \{[^}]*position: absolute;/);
    expect(css).toMatch(/\.cb-textarea-gutter \{[^}]*overflow: hidden;/);
    zh(<Textarea code aria-label="代码" defaultValue={"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk"} />);
    expect(document.querySelector(".cb-textarea-gutter-size")?.textContent).toBe("11");
  });
});

describe("清理：Button 加载态保持宽度", () => {
  it("⠿ 在内容容器内且绝对定位（不占流内宽度），内容整体平移居中", () => {
    zh(
      <>
        <Button>保存</Button>
        <Button loading>保存</Button>
      </>,
    );
    const [idle, busy] = screen.getAllByRole("button");
    const idleBody = idle?.querySelector(":scope > .cb-btn-body");
    const busyBody = busy?.querySelector(":scope > .cb-btn-body");
    expect(idleBody?.textContent).toBe("保存");
    expect(busyBody?.firstElementChild?.className).toBe("cb-btn-spin");
    // 两者流内子节点相同（⠿ 不在流内），宽度由 CSS 保证一致
    expect(busy?.children).toHaveLength(1);
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/controls.css"), "utf8");
    expect(css).toMatch(/\.cb-btn-spin \{[^}]*position: absolute;/);
    expect(css).toMatch(/\.cb-btn\[data-state="loading"\] \.cb-btn-body \{[^}]*transform:/);
  });
  it("作为 Radix 触发器时保留传入的 data-state", () => {
    zh(<Button {...({ "data-state": "open" } as object)}>更多</Button>);
    expect(screen.getByRole("button").getAttribute("data-state")).toBe("open");
  });
});

describe("清理：数值框草稿与外部值", () => {
  it("输入后（未失焦）外部把值改掉，数值框显示新值而不是旧草稿", () => {
    function H() {
      const [v, setV] = useState<number | undefined>(undefined);
      return (
        <>
          <Slider label="k" min={1} max={50} value={v} onChange={setV} withInput />
          <button type="button" onClick={() => setV(undefined)}>
            重置
          </button>
        </>
      );
    }
    zh(<H />);
    const box = screen.getByRole("spinbutton", { name: "k" }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "10" } });
    expect(box.value).toBe("10");
    act(() => screen.getByRole("button", { name: "重置" }).click());
    expect(box.value).toBe("");
  });
});
