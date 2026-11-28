import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerBox,
  type ComposerBoxProps,
  type ComposerPlace,
  ComposerPlaceChip,
  DesignProvider,
  type ModeMenuProps,
  type PickerProps,
} from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";
import { matchMediaFor } from "./width";

// The composer's top strip (spec §6.16.2 "Top strip", composer menus spec §6, §7): device then
// project above the text, the control row's place layout, the medium and compact forms.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const css = readFileSync(resolve(__dirname, "../src/styles/conversation-page.css"), "utf8");

function devicePicker(over: Partial<PickerProps> = {}): PickerProps {
  return {
    label: "切换设备",
    value: "开发沙盒",
    groups: [
      {
        items: [
          { id: "dev", label: "开发沙盒", checked: true },
          { id: "cloud", label: "云端设备", tag: "未配置", disabled: true },
          { id: "laptop", label: "我的电脑" },
        ],
      },
    ],
    onPick: vi.fn(),
    ...over,
  };
}

function projectPicker(over: Partial<PickerProps> = {}): PickerProps {
  return {
    label: "切换项目",
    value: "billing-reconciliation-service",
    groups: [
      {
        items: [
          { id: "free", label: "自由模式" },
          { id: "core", label: "capybara-core" },
          {
            id: "billing",
            label: "billing-reconciliation-service",
            checked: true,
          },
        ],
      },
    ],
    onPick: vi.fn(),
    ...over,
  };
}

const mode: ModeMenuProps = {
  label: "权限",
  modes: [
    { id: "ask", label: "请求批准", icon: "hand", description: "每个审批都先问你。" },
    {
      id: "approve",
      label: "帮我批准",
      icon: "shield-check",
      description: "审查模型替你批准。",
      checked: true,
    },
  ],
  onPickMode: vi.fn(),
  effort: {
    label: "思考档位",
    items: [{ id: "high", label: "高", checked: true }],
    onPick: vi.fn(),
  },
};

function props(over: Partial<ComposerBoxProps> = {}): ComposerBoxProps {
  return {
    segments: [],
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    placeholder: "输入消息",
    onAttach: vi.fn(),
    pickers: {
      device: devicePicker({ label: "旧设备选择" }),
      permission: {
        label: "权限",
        value: "帮我批准",
        groups: [{ items: [{ id: "approve", label: "帮我批准", checked: true }] }],
        onPick: vi.fn(),
      },
      model: {
        label: "切换模型",
        value: "opus 5.5",
        groups: [{ items: [{ id: "opus", label: "opus 5.5", checked: true }] }],
        onPick: vi.fn(),
      },
      effort: {
        label: "思考档位",
        value: "高",
        groups: [{ items: [{ id: "high", label: "高", checked: true }] }],
        onPick: vi.fn(),
      },
    },
    mode,
    send: { mode: "send", disabled: true, onClick: vi.fn() },
    place: { device: devicePicker(), project: projectPicker() },
    ...over,
  };
}

const strip = () => document.querySelector('[data-part="composer-place"]') as HTMLElement;
const full = () => document.querySelector('[data-part="composer-place-full"]') as HTMLElement;

describe("the top strip", () => {
  it("draws the device, a muted slash, then the project, above the text", () => {
    wrap(<ComposerBox {...props()} />);
    expect(strip().getAttribute("aria-label")).toBe("运行位置");
    const parts = [...full().children].map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(parts).toEqual(["切换设备: 开发沙盒", "/", "切换项目: billing-reconciliation-service"]);
    // the long project's whole name is its tooltip
    const project = within(full()).getByRole("button", { name: /切换项目/ });
    expect(project.getAttribute("title")).toBe("billing-reconciliation-service");
    // the strip comes before the text in the frame
    const frame = document.querySelector('[data-part="composer"]') as HTMLElement;
    expect(frame.getAttribute("data-place")).toBe("true");
    const input = screen.getByRole("textbox");
    expect(strip().compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens the device and project menus and calls their onPick", async () => {
    const user = userEvent.setup();
    const place: ComposerPlace = { device: devicePicker(), project: projectPicker() };
    wrap(<ComposerBox {...props({ place })} />);
    await user.click(within(full()).getByRole("button", { name: /切换项目/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "capybara-core" }));
    expect(place.project?.onPick).toHaveBeenCalledWith("core");
    await user.click(within(full()).getByRole("button", { name: /切换设备/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "我的电脑" }));
    expect(place.device.onPick).toHaveBeenCalledWith("laptop");
  });

  it("draws locked pickers as static text with the value and the hint as the tooltip", () => {
    wrap(
      <ComposerBox
        {...props({
          place: {
            device: devicePicker({ locked: { hint: "发送第一条消息后不能再换设备" } }),
            project: projectPicker({ locked: { hint: "发送第一条消息后不能再换项目" } }),
          },
        })}
      />,
    );
    expect(within(full()).queryAllByRole("button")).toEqual([]);
    const locked = [...full().querySelectorAll('[data-part="picker"][data-locked="true"]')];
    expect(locked.map((el) => el.getAttribute("title"))).toEqual([
      "开发沙盒: 发送第一条消息后不能再换设备",
      "billing-reconciliation-service: 发送第一条消息后不能再换项目",
    ]);
    // the compact chip is static text too: nothing in it can change
    const chip = strip().querySelector('[data-part="composer-place-chip"]') as HTMLElement;
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("data-locked")).toBe("true");
  });

  it("draws the device alone when it offers no project", () => {
    wrap(<ComposerBox {...props({ place: { device: devicePicker() } })} />);
    expect(full().textContent).toBe("开发沙盒");
    expect(full().querySelector('[data-part="composer-place-sep"]')).toBeNull();
  });

  it("holds no box inside the composer's box", () => {
    wrap(<ComposerBox {...props()} />);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});

describe("the control row with the top strip", () => {
  it("puts ＋ and the mode on the left, the model · effort before the meter and send", () => {
    wrap(<ComposerBox {...props({ context: { pct: 40, over: false } })} />);
    const bar = document.querySelector('[data-part="composer-bar"]') as HTMLElement;
    // the old control-row device picker is gone: the strip holds the device
    expect(within(bar).queryByRole("button", { name: /旧设备选择/ })).toBeNull();
    const shown = [...bar.querySelectorAll("button")]
      .filter((b) => !b.closest('[data-part="composer-options"]'))
      .filter((b) => b.getAttribute("data-part") !== "composer-options")
      .map((b) => b.getAttribute("aria-label"));
    expect(shown).toEqual(["权限: 帮我批准: 思考档位 高", "切换模型: opus 5.5 · 高"]);
    // the frame's line: + first (the text box), then the row, then the meter and send
    const box = document.querySelector('[data-part="composer-box"]') as HTMLElement;
    const attach = within(box).getByRole("button", { name: "添加附件" });
    const meter = screen.getByRole("meter");
    const send = within(box).getByRole("button", { name: "发送" });
    const mode = within(bar).getByRole("button", { name: /^权限/ });
    const model = within(bar).getByRole("button", { name: /^切换模型/ });
    expect(attach.compareDocumentPosition(meter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(meter.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mode.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("names the mode in its tooltip, so the icon alone on medium still says it", () => {
    wrap(<ComposerBox {...props()} />);
    const button = screen.getByRole("button", { name: /^权限/ });
    expect(button.getAttribute("title")).toBe("帮我批准: 审查模型替你批准。");
  });

  it("keeps the old row (the device picker, no strip) without place", () => {
    const { place: _place, ...rest } = props();
    wrap(<ComposerBox {...rest} />);
    expect(document.querySelector('[data-part="composer-place"]')).toBeNull();
    const bar = document.querySelector('[data-part="composer-bar"]') as HTMLElement;
    expect(within(bar).getByRole("button", { name: /旧设备选择/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^权限/ }).getAttribute("title")).toBe(
      "审查模型替你批准。",
    );
  });

  it("hands the settings chip the model and effort only, reading the model's name", async () => {
    const user = userEvent.setup();
    wrap(<ComposerBox {...props()} />);
    const chip = document.querySelector('[data-part="composer-options"]') as HTMLElement;
    expect(chip.closest('[data-part="composer-settings"]')).not.toBeNull();
    expect(chip.querySelector('[data-part="options-effort"]')).toBeNull();
    expect(chip.querySelector('[data-part="options-device"]')).toBeNull();
    await user.click(chip);
    const sheet = screen.getByRole("dialog", { name: "会话选项" });
    const groups = [...sheet.querySelectorAll('[data-part="options-group"]')].map((g) =>
      g.getAttribute("data-group"),
    );
    // the effort moves into the model's sheet; no device, no permission (the mode button holds it)
    expect(groups).toEqual(["model", "effort"]);
  });
});

describe("the medium and compact forms", () => {
  it("hides the mode's label from 600 to 840 and in the forced medium form", () => {
    expect(css).toMatch(
      /@media \(min-width: 600px\) and \(max-width: 840px\) \{\s*\.cb-composer\[data-place="true"\] \.cb-composer-mode \.cb-picker-value \{\s*display: none;/,
    );
    wrap(<ComposerBox {...props({ referenceForm: "medium" })} />);
    const frame = document.querySelector('[data-part="composer"]') as HTMLElement;
    expect(frame.getAttribute("data-form")).toBe("medium");
  });

  it("shows one chip below 600 instead of the two pickers", () => {
    const compact = [...css.matchAll(/@media not all and \(min-width: 600px\) \{([\s\S]*?)\n\}/g)]
      .map((m) => m[1])
      .join("\n");
    expect(compact).toMatch(/\.cb-composer-place-full \{\s*display: none;/);
    expect(compact).toMatch(/\.cb-composer-place-chip,\s*\.cb-composer-place-chip\.cb-btn \{/);
  });

  it("opens the place sheet from the chip: the device group, then the project group", async () => {
    const user = userEvent.setup();
    const place: ComposerPlace = { device: devicePicker(), project: projectPicker() };
    wrap(<ComposerBox {...props({ place })} />);
    const chip = within(strip()).getByRole("button", {
      name: "运行位置: 开发沙盒 / billing-reconciliation-service",
    });
    expect(chip.getAttribute("data-part")).toBe("composer-place-chip");
    await user.click(chip);
    const sheet = screen.getByRole("dialog", { name: "运行位置" });
    expect(sheet.getAttribute("data-part")).toBe("composer-place-sheet");
    const headings = [...sheet.querySelectorAll('[data-part="sheet-group-heading"]')].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["设备", "项目"]);
    const devices = within(sheet).getByRole("group", { name: "设备" });
    expect(
      (within(devices).getByRole("radio", { name: /云端设备/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    // a device pick keeps the sheet open: the project group follows the new device
    await user.click(within(devices).getByRole("radio", { name: "我的电脑" }));
    expect(place.device.onPick).toHaveBeenCalledWith("laptop");
    expect(screen.getByRole("dialog", { name: "运行位置" })).toBe(sheet);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    // a project pick closes it
    const projects = within(sheet).getByRole("group", { name: "项目" });
    await user.click(within(projects).getByRole("radio", { name: "capybara-core" }));
    expect(place.project?.onPick).toHaveBeenCalledWith("core");
    expect(screen.queryByRole("dialog", { name: "运行位置" })).toBeNull();
  });

  it("draws the sheet in place for the reference set, in English too", () => {
    wrap(
      <ComposerPlaceChip device={devicePicker()} project={projectPicker()} referenceSheet={{}} />,
      "en",
    );
    const sheet = screen.getByRole("dialog", { name: "Where it runs" });
    const headings = [...sheet.querySelectorAll('[data-part="sheet-group-heading"]')].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["Device", "Project"]);
  });
});

describe("review fixes", () => {
  it("moves through the projects with the arrow keys without picking or closing", async () => {
    const user = userEvent.setup();
    const place: ComposerPlace = { device: devicePicker(), project: projectPicker() };
    wrap(<ComposerBox {...props({ place })} />);
    await user.click(within(strip()).getByRole("button", { name: /^运行位置/ }));
    const sheet = screen.getByRole("dialog", { name: "运行位置" });
    const projects = within(sheet).getByRole("group", { name: "项目" });
    const free = within(projects).getByRole("radio", { name: "自由模式" });
    free.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      within(projects).getByRole("radio", { name: "capybara-core" }),
    );
    expect(place.project?.onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "运行位置" })).toBe(sheet);
    // Enter picks the focused project and closes the sheet
    await user.keyboard("{Enter}");
    expect(place.project?.onPick).toHaveBeenCalledWith("core");
    expect(screen.queryByRole("dialog", { name: "运行位置" })).toBeNull();
  });

  it("draws the chip as static text when the device is locked and the project disabled", () => {
    wrap(
      <ComposerBox
        {...props({
          place: {
            device: devicePicker({ locked: { hint: "发送第一条消息后不能再换设备" } }),
            project: projectPicker({ disabled: true }),
          },
        })}
      />,
    );
    const chip = strip().querySelector('[data-part="composer-place-chip"]') as HTMLElement;
    expect(chip.tagName).toBe("SPAN");
  });

  it("keeps the agent picker off the strip's row in the touch form", () => {
    expect(css).toMatch(
      /\.cb-composer\[data-place="true"\] \.cb-composer-bar > \.cb-picker\.cb-btn \{\s*grid-row: 7;/,
    );
    expect(css).toMatch(
      /\.cb-composer-settings > \.cb-composer-options\.cb-btn \{[^}]*max-width: 11em;/,
    );
  });

  it("moves the effort out of the mode menu below 600, into the model's sheet", async () => {
    vi.stubGlobal("matchMedia", matchMediaFor(390).matchMedia);
    const user = userEvent.setup();
    wrap(<ComposerBox {...props()} />);
    const button = screen.getByRole("button", { name: /^权限/ });
    expect(button.getAttribute("aria-label")).toBe("权限: 帮我批准");
    await user.click(button);
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByRole("group", { name: "思考档位" })).toBeNull();
  });

  it("keeps the effort in the mode menu from 600 up", async () => {
    vi.stubGlobal("matchMedia", matchMediaFor(1000).matchMedia);
    const user = userEvent.setup();
    wrap(<ComposerBox {...props()} />);
    await user.click(screen.getByRole("button", { name: /^权限/ }));
    expect(within(screen.getByRole("menu")).getByRole("group", { name: "思考档位" })).toBeTruthy();
  });

  it("joins both locked hints in the static chip's tooltip", () => {
    wrap(
      <ComposerBox
        {...props({
          place: {
            device: devicePicker({ locked: { hint: "不能换设备" } }),
            project: projectPicker({ locked: { hint: "不能换项目" } }),
          },
        })}
      />,
    );
    const chip = strip().querySelector('[data-part="composer-place-chip"]') as HTMLElement;
    expect(chip.getAttribute("title")).toBe(
      "开发沙盒 / billing-reconciliation-service: 不能换设备; 不能换项目",
    );
  });

  it("keeps a locked project's warning reachable on the compact chip", async () => {
    const user = userEvent.setup();
    const onInspect = vi.fn();
    wrap(
      <ComposerBox
        {...props({
          place: {
            device: devicePicker({ locked: { hint: "不能换设备" } }),
            project: projectPicker({
              locked: { hint: "不能换项目", warning: { label: "项目不可用", onInspect } },
            }),
          },
        })}
      />,
    );
    const chip = strip().querySelector('[data-part="composer-place-chip"]') as HTMLElement;
    expect(chip.tagName).toBe("BUTTON");
    expect(within(chip).getByText("项目不可用")).toBeTruthy();
    await user.click(chip);
    expect(onInspect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("announces the static chip's lock reasons", () => {
    wrap(
      <ComposerBox
        {...props({
          place: {
            device: devicePicker({ locked: { hint: "不能换设备" } }),
            project: projectPicker({ locked: { hint: "不能换项目" } }),
          },
        })}
      />,
    );
    const chip = strip().querySelector('[data-part="composer-place-chip"]') as HTMLElement;
    const hint = chip.querySelector('[data-part="place-hint"]') as HTMLElement;
    expect(hint.className).toBe("cb-sr-only");
    expect(hint.textContent).toBe("不能换设备; 不能换项目");
  });

  it("moves the effort out of the mode menu on a touch device at 800", async () => {
    const sized = matchMediaFor(800).matchMedia;
    vi.stubGlobal("matchMedia", (q: string) =>
      q === "(pointer: coarse)" || q === "(any-pointer: coarse)"
        ? { ...sized(q), matches: true }
        : sized(q),
    );
    const user = userEvent.setup();
    wrap(<ComposerBox {...props()} />);
    await user.click(screen.getByRole("button", { name: /^权限/ }));
    expect(within(screen.getByRole("menu")).queryByRole("group", { name: "思考档位" })).toBeNull();
  });

  it("keeps the project heading and its notice while the projects load", async () => {
    const user = userEvent.setup();
    wrap(
      <ComposerBox
        {...props({
          place: {
            device: devicePicker(),
            project: projectPicker({ disabled: true, groups: [], notice: "正在加载项目" }),
          },
        })}
      />,
    );
    await user.click(within(strip()).getByRole("button", { name: /^运行位置/ }));
    const sheet = screen.getByRole("dialog", { name: "运行位置" });
    const project = sheet.querySelector('[data-group="project"]') as HTMLElement;
    expect(project.querySelector('[data-part="sheet-group-heading"]')?.textContent).toBe("项目");
    expect(project.querySelector('[data-part="place-notice"]')?.textContent).toBe("正在加载项目");
  });

  it("draws a disabled sheet option in the disabled color and the disabled send icon faint", () => {
    expect(css).toMatch(
      /\.cb-sheet-option\[data-disabled="true"\] \{\s*color: var\(--cb-disabled\);/,
    );
    expect(css).toMatch(
      /\.cb-send\.cb-btn:disabled \{\s*border-color: transparent;\s*background: var\(--cb-selected\);\s*color: var\(--cb-faint\);/,
    );
  });
});
