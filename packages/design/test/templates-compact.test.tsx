// biome-ignore-all lint/correctness/useJsxKeyInIterable: the cases are [name, element] tuples, not a rendered list
import { act, cleanup, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  DetailPage,
  FormPage,
  InboxPage,
  ListDetailList,
  OnboardingPage,
  OverviewPage,
  type PageHeaderProps,
  SettingsPage,
  StatusPage,
  TracePage,
  WizardPage,
} from "../src/index";
import { type ShellPage, ShellPageContext } from "../src/shell/shell-page";
import { css, parseCss } from "./css-rules";
import { renderAtClass } from "./width";

// The other templates on compact (responsive system spec §2.6, §3.2–3.7, D2, D6, D7; design spec
// §6.65): every pushed template is one scroller, head included, and reports its scrolled title;
// Detail / Settings / Overview draw the primary as a full-width block (D2); in-page tabs are the
// segmented control; Status / Onboarding stack their actions; inbox rows have no long press (D6);
// the settings sub-nav and ActionRows stay sticky.

const real = window.matchMedia;
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  window.matchMedia = real;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function flushFrames() {
  const due = frames;
  frames = [];
  act(() => {
    for (const cb of due) cb(0);
  });
}

const header: PageHeaderProps = {
  path: [{ label: "capybara", href: "/" }, { label: "页面" }],
  title: "页面标题",
  actions: [
    { label: "导出", variant: "default", onSelect: () => {} },
    { label: "开始", variant: "primary", onSelect: () => {} },
  ],
};
const row = { primary: { label: "保存", onSelect: () => {} } };
const tabs = {
  items: [
    { id: "a", label: "概要" },
    { id: "b", label: "运行" },
  ],
  value: "a",
  label: "标签",
};
const nav = [{ group: "组织", items: [{ id: "general", label: "通用", href: "/s" }] }];

const TEMPLATES: [string, ReactElement][] = [
  [
    "DetailPage",
    <DetailPage header={header} tabs={tabs}>
      x
    </DetailPage>,
  ],
  [
    "SettingsPage",
    <SettingsPage header={header} nav={nav} activeNav="general">
      x
    </SettingsPage>,
  ],
  ["OverviewPage", <OverviewPage header={header}>x</OverviewPage>],
  ["TracePage", <TracePage header={header} waterfall="w" detail="d" />],
  [
    "FormPage",
    <FormPage header={header} actionRow={row}>
      x
    </FormPage>,
  ],
  [
    "WizardPage",
    <WizardPage header={header} steps={["一", "二"]} current={0} actionRow={row}>
      x
    </WizardPage>,
  ],
  ["StatusPage", <StatusPage header={header} kind="404" title="找不到" description="页面不存在" />],
  [
    "OnboardingPage",
    <OnboardingPage header={header} steps={[{ label: "一", description: "d", done: false }]} />,
  ],
];

/** A stand-in shell keeping the last `titleAway` each registration reported. */
function shellStub() {
  const pages = new Map<symbol, ShellPage>();
  const register = vi.fn((id: symbol, page: ShellPage | null) => {
    if (page === null) pages.delete(id);
    else pages.set(id, { ...pages.get(id), ...page });
  });
  const titleAway = () => [...pages.values()].some((p) => p.titleAway === true);
  return { register, titleAway };
}

const inShell = (register: ReturnType<typeof shellStub>["register"], ui: ReactElement) => (
  <ShellPageContext.Provider value={register}>{ui}</ShellPageContext.Provider>
);

/**
 * Makes the template's root the scroller under test: 600 high, 2000 of content, the title's
 * bottom 120 below its top; the rectangles follow `scrollTop`. Returns a person's scroll.
 */
function rig(container: HTMLElement) {
  const scroller = container.querySelector<HTMLElement>(".cb-template");
  const title = container.querySelector<HTMLElement>(".cb-pageheader-titleline");
  if (!scroller || !title) throw new Error("no scroller or title");
  let top = 0;
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 2000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 600 });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
  title.getBoundingClientRect = () => ({ top: 80 - top, bottom: 120 - top }) as DOMRect;
  return (v: number) => {
    scroller.dispatchEvent(new Event("wheel"));
    top = v;
    scroller.dispatchEvent(new Event("scroll"));
    flushFrames();
  };
}

describe.each(TEMPLATES)("%s on compact", (_name, ui) => {
  it("no path", () => {
    const { container } = renderAtClass(390, ui);
    expect(container.querySelector('[data-part="path"]')).toBeNull();
  });

  it("is one scroller, head included", () => {
    const { container } = renderAtClass(390, ui);
    const root = container.querySelector(".cb-template");
    expect(root?.getAttribute("data-scroll")).toBe("one");
    expect(root?.querySelector(".cb-template-head")).not.toBeNull();
  });

  it("title registered away after scroll", () => {
    const shell = shellStub();
    const { container } = renderAtClass(390, inShell(shell.register, ui));
    const scrollTo = rig(container);
    // jsdom lays nothing out: the first read saw a zero box, so read the rigged one first
    scrollTo(10);
    expect(shell.titleAway()).toBe(false);
    scrollTo(200);
    expect(shell.titleAway()).toBe(true);
    scrollTo(0);
    expect(shell.titleAway()).toBe(false);
  });

  it("at 1440 the title never goes away (the head stays fixed)", () => {
    const shell = shellStub();
    const { container } = renderAtClass(1440, inShell(shell.register, ui));
    const scrollTo = rig(container);
    scrollTo(200);
    expect(shell.titleAway()).toBe(false);
  });
});

describe("the primary under the title (D2)", () => {
  it.each([
    ["DetailPage", TEMPLATES[0]?.[1]],
    ["SettingsPage", TEMPLATES[1]?.[1]],
    ["OverviewPage", TEMPLATES[2]?.[1]],
  ])("%s: detail primary is a block button", (_name, ui) => {
    const { container } = renderAtClass(390, ui as ReactElement);
    const primary = container.querySelector('[data-head-primary="true"]');
    expect(primary?.getAttribute("data-form")).toBe("block");
  });

  it("a form keeps the head form (its primary is the ActionRow's)", () => {
    const { container } = renderAtClass(390, TEMPLATES[4]?.[1] as ReactElement);
    expect(container.querySelector('[data-head-primary="true"]')?.getAttribute("data-form")).toBe(
      "head",
    );
  });
});

describe("in-page tabs are the segmented control", () => {
  it("detail page tabs", () => {
    const { container } = renderAtClass(390, TEMPLATES[0]?.[1] as ReactElement);
    expect(
      container.querySelector('[data-part="page-tabs"] [data-look="segmented-compact"]'),
    ).not.toBeNull();
  });

  it("a band detail page's tabs", () => {
    const { container } = renderAtClass(
      390,
      <DetailPage header={{ ...header, titleHidden: true }} tabs={tabs}>
        x
      </DetailPage>,
    );
    expect(
      container.querySelector('[data-part="page-tabs"] [data-look="segmented-compact"]'),
    ).not.toBeNull();
  });

  it("settings section tabs", () => {
    const { container } = renderAtClass(
      390,
      <SettingsPage
        header={{
          ...header,
          tabs: [
            { id: "m", label: "模型" },
            { id: "p", label: "用途默认" },
          ],
        }}
        nav={nav}
        activeNav="general"
      >
        x
      </SettingsPage>,
    );
    expect(
      container.querySelector('[data-part="settings-tabs"] [data-look="segmented-compact"]'),
    ).not.toBeNull();
  });
});

describe("sticky parts inside the one scroller", () => {
  const compact = (f: string) =>
    parseCss(css(f)).filter((r) => r.at === "not all and (min-width: 600px)");

  it("settings sub-nav still sticky (data-sticky)", () => {
    const { container } = renderAtClass(390, TEMPLATES[1]?.[1] as ReactElement);
    expect(container.querySelector('[data-part="settings-nav"]')?.getAttribute("data-sticky")).toBe(
      "true",
    );
    const rule = compact("templates.css").find(
      (r) => r.selector === '.cb-settings-nav[data-sticky="true"]',
    );
    expect(rule?.decls.position).toBe("sticky");
    // under the floating row: the scroller starts at the row's top
    expect(rule?.decls.top).toBe("var(--cb-float-row, 0px)");
  });

  it("ActionRows stay sticky at the bottom", () => {
    const rule = parseCss(css("templates.css")).find(
      (r) => r.at === "(max-width: 599px)" && r.selector === ".cb-actionrow",
    );
    expect(rule?.decls.position).toBe("sticky");
    expect(rule?.decls.bottom).toBe("0");
  });
});

describe("the one scroller's CSS", () => {
  const compact = (f: string) =>
    parseCss(css(f)).filter((r) => r.at === "not all and (min-width: 600px)");

  it("the template root scrolls and nothing inside it does", () => {
    const rules = compact("templates.css");
    const root = rules.find((r) => r.selector === '.cb-template[data-scroll="one"]');
    expect(root?.decls["overflow-y"]).toBe("auto");
    const inner = rules.find((r) =>
      r.selector.startsWith('.cb-template[data-scroll="one"] .cb-body-content'),
    );
    expect(inner?.decls.overflow).toBe("visible");
  });

  it("in a pushed shell the scroller starts under the floating row and leaves it above the head", () => {
    const rule = compact("shell.css").find(
      (r) => r.selector === '.cb-shell[data-surface="pushed"] .cb-template[data-scroll="one"]',
    );
    expect(rule?.decls["margin-top"]).toBe("calc(-1 * var(--cb-float-row))");
    expect(rule?.decls["padding-top"]).toBe("var(--cb-float-row)");
  });
});

describe("Status and Onboarding stack their actions", () => {
  it("status actions stacked (data-stack)", () => {
    const { container } = renderAtClass(
      390,
      <StatusPage
        header={header}
        kind="404"
        title="找不到"
        description="页面不存在"
        action={<Button>返回</Button>}
      />,
    );
    expect(container.querySelector(".cb-status-page-action")?.getAttribute("data-stack")).toBe(
      "true",
    );
  });

  it("onboarding actions stacked (data-stack)", () => {
    const { container } = renderAtClass(390, TEMPLATES[7]?.[1] as ReactElement);
    expect(
      container.querySelector('[data-part="onboarding-steps"]')?.getAttribute("data-stack"),
    ).toBe("true");
  });

  it("a stacked action is full width on compact", () => {
    const rule = parseCss(css("templates.css")).find(
      (r) =>
        r.at === "not all and (min-width: 600px)" && r.selector === '[data-stack="true"] .cb-btn',
    );
    expect(rule?.decls.width).toBe("100%");
  });
});

describe("InboxPage rows (D6)", () => {
  it("inbox row has no contextmenu handler", () => {
    const { container } = renderAtClass(
      390,
      <InboxPage
        header={header}
        list={
          <ListDetailList
            label="待处理"
            items={[{ id: "1", title: "审批 1", meta: "工具" }]}
            onOpen={() => {}}
          />
        }
      />,
    );
    const rowEl = container.querySelector('[data-part="list-row"]');
    if (!rowEl) throw new Error("no row");
    // the system's own menu is left alone and no action sheet opens
    expect(fireEvent.contextMenu(rowEl)).toBe(true);
    expect(document.querySelector('[data-part="action-sheet-item"]')).toBeNull();
  });
});
