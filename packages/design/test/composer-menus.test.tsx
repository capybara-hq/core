import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { $getSelection } from "lexical";
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messages } from "../src/i18n";
import {
  ComposerBox,
  ComposerMenu,
  type ComposerMenuGroup,
  type ComposerMenuProps,
  type ComposerSegment,
  DesignProvider,
  OVERLAY_HISTORY_MARKER,
  rankComposerMenu,
  useComposerMenu,
} from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";
import { draftText, editorOf, focusEnd, select, typeText } from "./composer-editor-helpers";
import { matchMediaFor } from "./width";

// The composer's menus (spec §6.16.30): +, / and @ share one shell anchored above the composer
// (a bottom sheet on compact); the composer's editor is the combobox, the list a listbox, and the
// query is the composer text after the trigger.

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const wrap = (ui: ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

type Picks = Record<string, ReturnType<typeof vi.fn>>;

function slashGroups(picks: Picks = {}): ComposerMenuGroup[] {
  const pick = (id: string) => {
    picks[id] ??= vi.fn();
    return picks[id] as () => void;
  };
  return [
    {
      id: "skills",
      label: "技能",
      items: [
        {
          id: "brainstorming",
          label: "brainstorming",
          icon: "skills",
          description: "动手之前先梳理需求和方案",
          keywords: ["superpowers:brainstorming"],
          onSelect: pick("brainstorming"),
        },
        {
          id: "fix-issue",
          label: "fix-issue",
          icon: "skills",
          hint: "[issue-number]",
          description: "按团队规范修复一个 GitHub issue",
          onSelect: pick("fix-issue"),
        },
        {
          id: "release-check",
          label: "release-check",
          icon: "skills",
          description: "运行发布前的检查脚本",
          disabled: true,
          onSelect: pick("release-check"),
        },
      ],
    },
    {
      id: "commands",
      label: "命令",
      items: [
        {
          id: "compact",
          label: "compact",
          icon: "terminal",
          description: "压缩上下文",
          onSelect: pick("compact"),
        },
      ],
    },
  ];
}

/** A composer whose `/` menu is open while the text starts with "/" (the caller's own rule). */
function Harness({
  groups,
  initial = "/",
  onClose,
  onSwitch,
  filter,
  loading,
  kind = "slash",
  onSend,
  attachOpen,
}: {
  onSend?: () => void;
  attachOpen?: boolean;
  groups: ComposerMenuGroup[];
  initial?: string;
  onClose?: () => void;
  onSwitch?: (k: "slash" | "at") => void;
  filter?: boolean;
  loading?: boolean;
  kind?: ComposerMenuProps["kind"];
}) {
  const [segments, setSegments] = useState<ComposerSegment[]>(initial === "" ? [] : [initial]);
  const text = segments.filter((x) => typeof x === "string").join("");
  const [closed, setClosed] = useState(false);
  const open = !closed && (kind === "plus" || text.startsWith(kind === "at" ? "@" : "/"));
  const props: ComposerMenuProps | null = open
    ? {
        kind,
        groups,
        query: kind === "plus" ? "" : text.slice(1),
        empty: "没有匹配",
        onClose: () => {
          setClosed(true);
          onClose?.();
        },
        ...(onSwitch ? { onSwitch } : {}),
        ...(filter === undefined ? {} : { filter }),
        ...(loading ? { loading } : {}),
      }
    : null;
  const menu = useComposerMenu(props);
  return (
    <ComposerBox
      segments={segments}
      onChange={setSegments}
      // the page's send: the editor's ↵ without Shift, never while an IME composes
      onSubmit={() => onSend?.()}
      placeholder="输入消息"
      onAttach={() => {}}
      {...(attachOpen !== undefined ? { attachOpen } : {})}
      pickers={{ model: { label: "切换模型", value: "m", groups: [], onPick: () => {} } }}
      send={{ mode: "send", onClick: () => {} }}
      menu={
        props
          ? {
              node: <ComposerMenu {...props} controller={menu} />,
              combobox: menu.combobox,
              onKeyDown: menu.onKeyDown,
            }
          : { combobox: menu.combobox, onKeyDown: menu.onKeyDown }
      }
    />
  );
}

/** The composer's editor; a key reaches it with a caret (at the end unless a test placed one). */
const textarea = () => {
  const box = screen.getByRole("combobox", { name: "消息" });
  if (
    editorOf(box)
      .getEditorState()
      .read(() => $getSelection()) === null
  )
    focusEnd(box);
  return box;
};
const options = () => screen.getAllByRole("option");
const active = () => {
  const id = textarea().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};
const key = (k: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(textarea(), { key: k, ...init });

describe("rankComposerMenu", () => {
  it("keeps everything in order for an empty query", () => {
    const shown = rankComposerMenu(slashGroups(), "", true);
    expect(shown.map((g) => g.items.map((i) => i.id))).toEqual([
      ["brainstorming", "fix-issue", "release-check"],
      ["compact"],
    ]);
  });

  it("ranks items with commandScore inside each group and hides non-matches", () => {
    // "fi": a label prefix (fix-issue) before a description substring (none here)
    const shown = rankComposerMenu(slashGroups(), "fi", true);
    expect(shown.map((g) => g.items.map((i) => i.id))).toEqual([["fix-issue"]]);
    // a keyword prefix after "<plugin>:" matches too
    expect(rankComposerMenu(slashGroups(), "brain", true)[0]?.items[0]?.id).toBe("brainstorming");
  });

  it("keeps the groups in the caller's order: commands never move before skills", () => {
    // "c": compact is a label prefix (1), the skills only match in descriptions or not at all
    const shown = rankComposerMenu(slashGroups(), "c", true);
    expect(shown.at(-1)?.id).toBe("commands");
  });

  it("keeps the caller's order and every item when filtering is off", () => {
    const shown = rankComposerMenu(slashGroups(), "zzz", false);
    expect(shown.flatMap((g) => g.items).length).toBe(4);
  });
});

describe("ComposerMenu (anchored)", () => {
  it("makes the textarea a combobox controlling the listbox", () => {
    wrap(<Harness groups={slashGroups()} />);
    const ta = textarea();
    expect(ta.getAttribute("aria-expanded")).toBe("true");
    expect(ta.getAttribute("aria-autocomplete")).toBe("list");
    const list = screen.getByRole("listbox");
    expect(ta.getAttribute("aria-controls")).toBe(list.id);
    expect(active()?.textContent).toContain("brainstorming");
    expect(active()?.getAttribute("aria-selected")).toBe("true");
  });

  it("closed: the textarea stays a collapsed combobox without an active row", () => {
    wrap(<Harness groups={slashGroups()} initial="" />);
    const ta = textarea();
    expect(ta.getAttribute("aria-expanded")).toBe("false");
    expect(ta.hasAttribute("aria-activedescendant")).toBe(false);
    expect(ta.hasAttribute("aria-controls")).toBe(false);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("↑↓ move the active row, skipping disabled rows and wrapping", () => {
    wrap(<Harness groups={slashGroups()} />);
    key("ArrowDown");
    expect(active()?.textContent).toContain("fix-issue");
    // release-check is disabled: skipped
    key("ArrowDown");
    expect(active()?.textContent).toContain("compact");
    key("ArrowDown");
    expect(active()?.textContent).toContain("brainstorming");
    key("ArrowUp");
    expect(active()?.textContent).toContain("compact");
  });

  it("↵ picks the active row; ↵ while an IME composes does nothing", () => {
    const picks: Picks = {};
    wrap(<Harness groups={slashGroups(picks)} />);
    key("ArrowDown");
    key("Enter", { isComposing: true });
    expect(picks["fix-issue"]).not.toHaveBeenCalled();
    key("Enter");
    expect(picks["fix-issue"]).toHaveBeenCalledTimes(1);
  });

  it("↵ is the menu's: the composer's send never sees it", () => {
    const onSubmit = vi.fn();
    function WithEnter() {
      const props: ComposerMenuProps = {
        kind: "slash",
        groups: slashGroups(),
        query: "",
        empty: "没有匹配",
        onClose: () => {},
      };
      const menu = useComposerMenu(props);
      return (
        <ComposerBox
          segments={["/"]}
          onChange={() => {}}
          onSubmit={onSubmit}
          placeholder="输入消息"
          onAttach={() => {}}
          pickers={{ model: { label: "切换模型", value: "m", groups: [], onPick: () => {} } }}
          send={{ mode: "send", onClick: () => {} }}
          menu={{
            node: <ComposerMenu {...props} controller={menu} />,
            combobox: menu.combobox,
            onKeyDown: menu.onKeyDown,
          }}
        />
      );
    }
    wrap(<WithEnter />);
    expect(key("Enter")).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    // a key the menu does not handle stays the editor's
    expect(key("a")).toBe(true);
  });

  it("Esc closes and keeps the text", () => {
    const onClose = vi.fn();
    wrap(<Harness groups={slashGroups()} initial="/fi" onClose={onClose} />);
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(draftText()).toBe("/fi");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Backspace through the trigger closes the menu", () => {
    const onClose = vi.fn();
    wrap(<Harness groups={slashGroups()} initial="/" onClose={onClose} />);
    key("Backspace");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Backspace inside the query does not close it", () => {
    const onClose = vi.fn();
    wrap(<Harness groups={slashGroups()} initial="/fi" onClose={onClose} />);
    key("Backspace");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a space after @ with no match closes; with matches it is just typing", () => {
    const onClose = vi.fn();
    const at: ComposerMenuGroup[] = [
      {
        id: "github",
        label: "GitHub",
        items: [
          {
            id: "r1",
            label: "report.md",
            mark: { text: "GitHub" },
            onSelect: () => {},
          },
        ],
      },
    ];
    const { unmount } = wrap(<Harness kind="at" groups={at} initial="@rep" onClose={onClose} />);
    key(" ");
    expect(onClose).not.toHaveBeenCalled();
    unmount();
    wrap(<Harness kind="at" groups={at} initial="@zzz" onClose={onClose} />);
    key(" ");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not handle the keys it does not own", () => {
    let handled: boolean[] = [];
    function Probe() {
      const menu = useComposerMenu({
        kind: "slash",
        groups: slashGroups(),
        query: "",
        empty: "没有匹配",
        onClose: () => {},
      });
      return (
        <textarea
          aria-label="probe"
          onKeyDown={(e) => {
            handled.push(menu.onKeyDown(e));
          }}
        />
      );
    }
    wrap(<Probe />);
    const ta = screen.getByLabelText("probe");
    fireEvent.keyDown(ta, { key: "a" });
    fireEvent.keyDown(ta, { key: "ArrowLeft" });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(handled).toEqual([false, false, false]);
    handled = [];
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(handled).toEqual([true]);
  });

  it("filters by the query, ranked with commandScore", () => {
    wrap(<Harness groups={slashGroups()} initial="/fix" />);
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining("fix-issue")]);
  });

  it("filter={false} keeps the caller's order and items (results searched by the caller)", () => {
    wrap(<Harness groups={slashGroups()} initial="/zzz" filter={false} />);
    expect(options()).toHaveLength(4);
  });

  it("draws group labels, icons, hints, descriptions and no leading slash", () => {
    wrap(<Harness groups={slashGroups()} />);
    const list = screen.getByRole("listbox");
    expect(within(list).getByRole("group", { name: "技能" })).toBeTruthy();
    expect(within(list).getByRole("group", { name: "命令" })).toBeTruthy();
    const fix = options()[1] as HTMLElement;
    expect(fix.querySelector('[data-icon="skills"]')).not.toBeNull();
    expect(fix.querySelector('[data-part="composer-menu-hint"]')?.textContent).toBe(
      "[issue-number]",
    );
    expect(fix.querySelector('[data-part="composer-menu-desc"]')?.textContent).toBe(
      "按团队规范修复一个 GitHub issue",
    );
    const compact = options()[3] as HTMLElement;
    expect(compact.querySelector('[data-icon="terminal"]')).not.toBeNull();
    for (const o of options()) expect(o.textContent?.startsWith("/")).toBe(false);
    // a disabled row is announced as such
    expect(options()[2]?.getAttribute("aria-disabled")).toBe("true");
  });

  it("an item with a mark image draws ObjectMark with the image; a file draws its type", () => {
    const groups: ComposerMenuGroup[] = [
      {
        id: "connectors",
        label: "连接器",
        items: [
          {
            id: "github",
            label: "GitHub",
            mark: { text: "GitHub", image: "/api/v1/orgs/o/connectors/c/icon" },
            badge: "待配置",
            disabled: true,
            onSelect: () => {},
          },
          { id: "lark", label: "飞书", mark: { text: "飞书" }, onSelect: () => {} },
          { id: "f", label: "季度报告.xlsx", file: { name: "季度报告.xlsx" }, onSelect: () => {} },
        ],
      },
    ];
    wrap(<Harness kind="plus" groups={groups} />);
    const [gh, lark, file] = options() as HTMLElement[];
    expect(gh?.querySelector('[data-part="object-mark"][data-kind="image"] img')).not.toBeNull();
    expect(gh?.querySelector('[data-part="composer-menu-badge"]')?.textContent).toBe("待配置");
    expect(lark?.querySelector('[data-part="object-mark"]')?.textContent).toBe("飞");
    expect(file?.querySelector('[data-part="type-badge"]')?.textContent).toBe("XLSX");
  });

  it("a click picks without moving focus out of the textarea; a disabled row is not picked", () => {
    const picks: Picks = {};
    wrap(<Harness groups={slashGroups(picks)} />);
    focusEnd();
    const fix = options()[1] as HTMLElement;
    // the mousedown keeps the focus in the composer
    expect(fireEvent.mouseDown(fix)).toBe(false);
    fireEvent.click(fix);
    expect(picks["fix-issue"]).toHaveBeenCalledTimes(1);
    fireEvent.click(options()[2] as HTMLElement);
    expect(picks["release-check"]).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea());
  });

  it("the pointer moves the active row", () => {
    wrap(<Harness groups={slashGroups()} />);
    fireEvent.mouseMove(options()[3] as HTMLElement);
    expect(active()?.textContent).toContain("compact");
  });

  it("shows the empty line when nothing matches", () => {
    wrap(<Harness groups={slashGroups()} initial="/zzz" />);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("没有匹配")).toBeTruthy();
    expect(textarea().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("loading shows the loading row (and no empty line)", () => {
    wrap(<Harness groups={[]} initial="@rep" kind="at" loading />);
    const row = document.querySelector('[data-part="composer-menu-loading"]');
    expect(row?.textContent).toContain("正在加载");
    expect(screen.queryByText("没有匹配")).toBeNull();
  });

  it("a notice under the list carries the next step as a link that closes the menu", () => {
    const onClose = vi.fn();
    function WithNotice() {
      const props: ComposerMenuProps = {
        kind: "slash",
        groups: [],
        query: "",
        empty: "这个智能体还没有可调用的技能",
        notice: { action: { label: "去选择技能", href: "/agents/a1#skills" } },
        onClose,
      };
      const menu = useComposerMenu(props);
      return <ComposerMenu {...props} controller={menu} />;
    }
    wrap(<WithNotice />);
    expect(screen.getByText("这个智能体还没有可调用的技能")).toBeTruthy();
    const link = screen.getByRole("link", { name: "去选择技能" });
    expect(link.getAttribute("href")).toBe("/agents/a1#skills");
    fireEvent.click(link);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the footer's key hints switch menus through onSwitch", () => {
    const onSwitch = vi.fn();
    wrap(<Harness groups={slashGroups()} onSwitch={onSwitch} />);
    const foot = document.querySelector('[data-part="composer-menu-foot"]') as HTMLElement;
    expect(foot.textContent).toContain("↑↓ 选择");
    expect(foot.textContent).toContain("↵ 使用");
    expect(foot.textContent).toContain("esc 关闭");
    expect(foot.textContent).toContain("输入以搜索");
    const at = within(foot).getByRole("button", { name: "@ 连接器、文件与会话" });
    // a click on a hint keeps the focus in the composer
    expect(fireEvent.mouseDown(at)).toBe(false);
    fireEvent.click(at);
    expect(onSwitch).toHaveBeenCalledWith("at");
    fireEvent.click(within(foot).getByRole("button", { name: "/ 技能与命令" }));
    expect(onSwitch).toHaveBeenCalledWith("slash");
  });

  it("speaks English with the en locale", () => {
    wrap(<Harness groups={slashGroups()} onSwitch={() => {}} />, "en");
    const foot = document.querySelector('[data-part="composer-menu-foot"]') as HTMLElement;
    expect(
      within(foot).getByRole("button", { name: "@ Connectors, files and conversations" }),
    ).toBeTruthy();
    expect(foot.textContent).toContain("esc Close");
  });

  it("draws no box inside a box", () => {
    const { container } = wrap(<Harness groups={slashGroups()} onSwitch={() => {}} />);
    expect(findNestedBoxes(container).map(describeNestedBox)).toEqual([]);
  });
});

describe("ComposerMenu (anchored) outside close", () => {
  it("a press outside the composer closes it; a press inside does not", () => {
    const onClose = vi.fn();
    wrap(
      <>
        <Harness groups={slashGroups()} onClose={onClose} />
        <p>elsewhere</p>
      </>,
    );
    fireEvent.pointerDown(textarea());
    fireEvent.pointerDown(options()[0] as HTMLElement);
    fireEvent.pointerDown(screen.getByRole("button", { name: "添加附件" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("the focus leaving for an element outside closes it; leaving the window does not", () => {
    const onClose = vi.fn();
    wrap(
      <>
        <Harness groups={slashGroups()} onClose={onClose} />
        <button type="button">outside</button>
      </>,
    );
    const field = textarea();
    field.focus();
    // another tab or app: no element receives the focus
    fireEvent.focusOut(field, { relatedTarget: null });
    // a control inside the composer frame
    fireEvent.focusOut(field, { relatedTarget: screen.getByRole("button", { name: "添加附件" }) });
    expect(onClose).not.toHaveBeenCalled();
    act(() => screen.getByRole("button", { name: "outside" }).focus());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("the ＋ button", () => {
  it("names the open + menu's listbox in aria-controls", () => {
    wrap(<Harness kind="plus" groups={slashGroups()} attachOpen />);
    const plus = screen.getByRole("button", { name: "添加附件" });
    expect(plus.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  });

  it("keeps aria-haspopup=menu and reports attachOpen as aria-expanded", () => {
    const base = {
      segments: [],
      onChange: () => {},
      onSubmit: () => {},
      placeholder: "输入消息",
      onAttach: () => {},
      pickers: { model: { label: "切换模型", value: "m", groups: [], onPick: () => {} } },
      send: { mode: "send" as const, onClick: () => {} },
    };
    const { rerender } = wrap(<ComposerBox {...base} attachOpen={false} />);
    const plus = screen.getByRole("button", { name: "添加附件" });
    expect(plus.getAttribute("aria-haspopup")).toBe("menu");
    expect(plus.getAttribute("aria-expanded")).toBe("false");
    rerender(
      <DesignProvider locale="zh">
        <ComposerBox {...base} attachOpen />
      </DesignProvider>,
    );
    expect(plus.getAttribute("aria-expanded")).toBe("true");
  });

  it("without attachOpen it stays a plain button (the file picker)", () => {
    wrap(
      <ComposerBox
        segments={[]}
        onSubmit={() => {}}
        onChange={() => {}}
        placeholder="输入消息"
        onAttach={() => {}}
        pickers={{ model: { label: "切换模型", value: "m", groups: [], onPick: () => {} } }}
        send={{ mode: "send", onClick: () => {} }}
      />,
    );
    const plus = screen.getByRole("button", { name: "添加附件" });
    expect(plus.hasAttribute("aria-haspopup")).toBe(false);
    expect(plus.hasAttribute("aria-expanded")).toBe(false);
  });
});

describe("ComposerMenu (compact)", () => {
  it("is a bottom sheet with a search field bound to onQueryChange, rows and no footer", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const onQueryChange = vi.fn();
    const onClose = vi.fn();
    function Compact() {
      const props: ComposerMenuProps = {
        kind: "slash",
        groups: slashGroups(),
        query: "",
        empty: "没有匹配",
        onClose,
        onQueryChange,
        onSwitch: () => {},
      };
      const menu = useComposerMenu(props);
      return <ComposerMenu {...props} controller={menu} />;
    }
    wrap(<Compact />);
    const sheet = screen.getByRole("dialog", { name: "技能与命令" });
    const search = within(sheet).getByRole("searchbox", { name: "搜索" });
    fireEvent.change(search, { target: { value: "fix" } });
    expect(onQueryChange).toHaveBeenCalledWith("fix");
    expect(within(sheet).getAllByRole("option")).toHaveLength(4);
    expect(sheet.querySelector('[data-part="composer-menu-foot"]')).toBeNull();
    // ↓ and ↵ in the search field drive the list too
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe(
      within(sheet).getAllByRole("option")[1]?.id,
    );
    // the sheet's close ends the menu
    act(() => {
      fireEvent.click(within(sheet).getByRole("button", { name: "关闭" }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("a tap on a row picks it", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const picks: Picks = {};
    function Compact() {
      const props: ComposerMenuProps = {
        kind: "slash",
        groups: slashGroups(picks),
        query: "",
        empty: "没有匹配",
        onClose: () => {},
      };
      const menu = useComposerMenu(props);
      return <ComposerMenu {...props} controller={menu} />;
    }
    wrap(<Compact />);
    fireEvent.click(screen.getAllByRole("option")[1] as HTMLElement);
    expect(picks["fix-issue"]).toHaveBeenCalledTimes(1);
  });

  it("referenceAnchored keeps the anchored form in a phone window (no portaled sheet)", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    function Anchored() {
      const props: ComposerMenuProps = {
        kind: "slash",
        groups: slashGroups(),
        query: "",
        empty: "没有匹配",
        onClose: () => {},
      };
      const menu = useComposerMenu(props);
      return (
        <div data-testid="cell">
          <ComposerMenu {...props} controller={menu} referenceAnchored />
        </div>
      );
    }
    wrap(<Anchored />);
    expect(screen.queryByRole("dialog")).toBeNull();
    const menu = screen.getByTestId("cell").querySelector('[data-part="composer-menu"]');
    expect(menu?.getAttribute("data-form")).toBeNull();
    expect(menu?.querySelector('[data-part="composer-menu-foot"]')).not.toBeNull();
  });
});

describe("ComposerMenu keyboard edges", () => {
  it("↵ with no choosable row closes the menu and never sends; the next ↵ sends", () => {
    const onClose = vi.fn();
    const onSend = vi.fn();
    wrap(<Harness groups={slashGroups()} initial="/zzz" onClose={onClose} onSend={onSend} />);
    key("Enter");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    key("Enter");
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("↵ with only disabled rows closes and does not send", () => {
    const onClose = vi.fn();
    const onSend = vi.fn();
    const groups: ComposerMenuGroup[] = [
      {
        id: "skills",
        items: [{ id: "x", label: "release-check", disabled: true, onSelect: () => {} }],
      },
    ];
    wrap(<Harness groups={groups} onClose={onClose} onSend={onSend} />);
    key("Enter");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("↵ while results load waits: it neither closes nor sends", () => {
    const onClose = vi.fn();
    const onSend = vi.fn();
    wrap(
      <Harness kind="at" groups={[]} initial="@rep" loading onClose={onClose} onSend={onSend} />,
    );
    key("Enter");
    expect(onClose).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("an IME composition's ↵ neither picks, closes nor sends", () => {
    const picks: Picks = {};
    const onClose = vi.fn();
    const onSend = vi.fn();
    wrap(<Harness groups={slashGroups(picks)} onClose={onClose} onSend={onSend} />);
    key("Enter", { isComposing: true });
    key("Enter", { keyCode: 229 });
    expect(Object.values(picks).some((f) => f.mock.calls.length > 0)).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("closed (`a@b` mid-word opens nothing): the keys are the composer's, nothing is picked", () => {
    const handled: boolean[] = [];
    function Probe() {
      const menu = useComposerMenu(null);
      return (
        <textarea
          aria-label="probe"
          defaultValue="a@b"
          onKeyDown={(e) => {
            handled.push(menu.onKeyDown(e));
          }}
        />
      );
    }
    wrap(<Probe />);
    const ta = screen.getByLabelText("probe");
    for (const k of ["Enter", "ArrowDown", "Escape", "Backspace", " "]) {
      fireEvent.keyDown(ta, { key: k });
    }
    expect(handled).toEqual([false, false, false, false, false]);
  });

  it("a space right after @ closes even with rows listed (the key still types)", () => {
    const onClose = vi.fn();
    const at: ComposerMenuGroup[] = [
      { id: "github", items: [{ id: "r1", label: "report.md", onSelect: () => {} }] },
    ];
    wrap(<Harness kind="at" groups={at} initial="@" onClose={onClose} />);
    expect(options()).toHaveLength(1);
    const ev = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    textarea().dispatchEvent(ev);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("Backspace with a selection is plain editing: the menu does not close on the key", () => {
    const onClose = vi.fn();
    wrap(<Harness groups={slashGroups()} initial="/" onClose={onClose} />);
    select(0, 1);
    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("only key moves scroll the active row into view; the pointer never scrolls", () => {
    const scroll = vi.fn();
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      wrap(<Harness groups={slashGroups()} />);
      fireEvent.mouseMove(options()[3] as HTMLElement);
      expect(active()?.textContent).toContain("compact");
      expect(scroll).not.toHaveBeenCalled();
      key("ArrowDown");
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toBe(active());
    } finally {
      Element.prototype.scrollIntoView = real;
    }
  });

  it("↑ from the first row wraps to the last choosable row", () => {
    wrap(<Harness groups={slashGroups()} />);
    expect(active()?.textContent).toContain("brainstorming");
    key("ArrowUp");
    expect(active()?.textContent).toContain("compact");
  });

  it("aria-activedescendant names an existing option after the query re-ranks the rows", () => {
    wrap(<Harness groups={slashGroups()} />);
    key("ArrowDown");
    key("ArrowDown");
    expect(active()?.textContent).toContain("compact");
    focusEnd();
    typeText("brain");
    const el = active();
    expect(el?.getAttribute("role")).toBe("option");
    expect(el?.textContent).toContain("brainstorming");
    expect(options()).toContain(el);
  });

  it("the footer's switch hints are not tab stops", () => {
    wrap(<Harness groups={slashGroups()} onSwitch={() => {}} />);
    const foot = document.querySelector('[data-part="composer-menu-foot"]') as HTMLElement;
    const buttons = within(foot).getAllByRole("button");
    expect(buttons.length).toBe(2);
    for (const b of buttons) expect(b.getAttribute("tabindex")).toBe("-1");
  });
});

/** A 390 wide window, with a coarse pointer when `touch`. */
function compactWindow(touch: boolean): typeof window.matchMedia {
  const base = matchMediaFor(390).matchMedia;
  return ((q: string) => {
    const coarse = q === "(pointer: coarse)" || q === "(any-pointer: coarse)";
    if (touch && (coarse || q === "(any-pointer: fine)")) {
      return { ...base(q), matches: coarse, media: q };
    }
    return base(q);
  }) as typeof window.matchMedia;
}

describe("ComposerMenu (compact) focus and Esc", () => {
  /** The page's `/` sheet; a pick runs the row's action and closes it (the caller's rule). */
  function Page({ onClose, picks }: { onClose?: () => void; picks?: Picks }) {
    const [open, setOpen] = useState(false);
    const close = () => {
      onClose?.();
      setOpen(false);
    };
    const props: ComposerMenuProps | null = open
      ? {
          kind: "slash",
          groups: slashGroups(picks).map((g) => ({
            ...g,
            items: g.items.map((it) => ({
              ...it,
              onSelect: () => {
                it.onSelect();
                close();
              },
            })),
          })),
          query: "",
          empty: "没有匹配",
          onClose: close,
          onQueryChange: () => {},
        }
      : null;
    const menu = useComposerMenu(props);
    return (
      <>
        <textarea aria-label="composer" />
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
        {props ? <ComposerMenu {...props} controller={menu} /> : null}
      </>
    );
  }
  const openFromComposer = () => {
    const ta = screen.getByLabelText("composer");
    ta.focus();
    // fireEvent.click moves no focus: the sheet opens with the composer focused
    fireEvent.click(screen.getByText("open"));
    return ta;
  };
  const sheet = () => screen.queryByRole("dialog", { name: "技能与命令" });

  it("with a fine pointer closing hands focus back to the composer", async () => {
    window.matchMedia = compactWindow(false);
    wrap(<Page />);
    const ta = openFromComposer();
    await waitFor(() => expect(document.activeElement).not.toBe(ta));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    });
    await waitFor(() => expect(sheet()).toBeNull());
    expect(document.activeElement).toBe(ta);
  });

  it("on touch closing never focuses the composer (it would pop the keyboard)", async () => {
    window.matchMedia = compactWindow(true);
    wrap(<Page />);
    const ta = openFromComposer();
    await waitFor(() => expect(document.activeElement).not.toBe(ta));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    });
    await waitFor(() => expect(sheet()).toBeNull());
    expect(document.activeElement).not.toBe(ta);
  });

  it("on touch a pick never focuses the composer either", async () => {
    window.matchMedia = compactWindow(true);
    const picks: Picks = {};
    wrap(<Page picks={picks} />);
    const ta = openFromComposer();
    await waitFor(() => expect(document.activeElement).not.toBe(ta));
    act(() => {
      fireEvent.click(within(sheet() as HTMLElement).getAllByRole("option")[1] as HTMLElement);
    });
    await waitFor(() => expect(sheet()).toBeNull());
    expect(picks["fix-issue"]).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(ta);
  });

  it("↵ in the search field picks the active row", () => {
    window.matchMedia = compactWindow(false);
    const picks: Picks = {};
    wrap(<Page picks={picks} />);
    openFromComposer();
    const search = within(sheet() as HTMLElement).getByRole("searchbox", { name: "搜索" });
    act(() => {
      fireEvent.keyDown(search, { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(search, { key: "Enter" });
    });
    expect(picks["fix-issue"]).toHaveBeenCalledTimes(1);
  });

  it("the system back closes the sheet (its one history entry)", async () => {
    window.matchMedia = compactWindow(true);
    const onClose = vi.fn();
    wrap(<Page onClose={onClose} />);
    openFromComposer();
    expect(sheet()).not.toBeNull();
    // the entry is pushed once an earlier test's own pop has landed
    await waitFor(() =>
      expect(
        (history.state as Record<string, unknown> | null)?.[OVERLAY_HISTORY_MARKER],
      ).toBeTruthy(),
    );
    act(() => {
      history.back();
    });
    await waitFor(() => expect(sheet()).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
    history.replaceState(null, "", "/");
  });

  it("Esc in the search field closes once", async () => {
    window.matchMedia = compactWindow(false);
    const onClose = vi.fn();
    wrap(<Page onClose={onClose} />);
    openFromComposer();
    const search = within(sheet() as HTMLElement).getByRole("searchbox", { name: "搜索" });
    act(() => {
      fireEvent.keyDown(search, { key: "Escape" });
    });
    await waitFor(() => expect(sheet()).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── Drill-in, connector rows and the one-skill line (inline tokens spec §4) ──

function connectorGroups(
  picks: Picks = {},
  drills: Record<string, ReturnType<typeof vi.fn>> = {},
): ComposerMenuGroup[] {
  const drill = (id: string, label: string) => {
    drills[id] ??= vi.fn();
    return { label, onDrill: drills[id] as () => void };
  };
  const pick = (id: string) => {
    picks[id] ??= vi.fn();
    return picks[id] as () => void;
  };
  return [
    {
      id: "connectors",
      label: "连接器",
      items: [
        {
          id: "slack",
          label: "Slack",
          mark: { text: "Slack" },
          description: "团队消息",
          drill: drill("slack", "查看 Slack 的资源"),
          onSelect: pick("slack"),
        },
        {
          id: "jira",
          label: "Jira",
          mark: { text: "Jira" },
          description: "项目和工单",
          badge: "待配置",
          disabled: true,
          onSelect: pick("jira"),
        },
      ],
    },
  ];
}

function LevelHarness({
  onBack,
  initial = "@",
  withLevel = true,
  drills,
}: {
  onBack: () => void;
  initial?: string;
  withLevel?: boolean;
  drills?: Record<string, ReturnType<typeof vi.fn>>;
}) {
  const [segments, setSegments] = useState<ComposerSegment[]>(initial === "" ? [] : [initial]);
  const text = segments.filter((x) => typeof x === "string").join("");
  const props: ComposerMenuProps = {
    kind: "at",
    groups: connectorGroups({}, drills),
    query: text.slice(1),
    filter: false,
    empty: "没有匹配",
    onClose: () => {},
    ...(withLevel ? { level: { title: "Slack · 资源", onBack } } : {}),
  };
  const menu = useComposerMenu(props);
  return (
    <ComposerBox
      segments={segments}
      onChange={setSegments}
      onSubmit={() => {}}
      placeholder="输入消息"
      onAttach={() => {}}
      pickers={{ model: { label: "切换模型", value: "m", groups: [], onPick: () => {} } }}
      send={{ mode: "send", onClick: () => {} }}
      menu={{
        node: <ComposerMenu {...props} controller={menu} />,
        combobox: menu.combobox,
        onKeyDown: menu.onKeyDown,
      }}
    />
  );
}

describe("ComposerMenu drill-in", () => {
  it("drill button opens the second level", () => {
    const drills: Record<string, ReturnType<typeof vi.fn>> = {};
    const picks: Picks = {};
    function H() {
      const props: ComposerMenuProps = {
        kind: "at",
        groups: connectorGroups(picks, drills),
        query: "",
        filter: false,
        empty: "没有匹配",
        onClose: () => {},
      };
      const menu = useComposerMenu(props);
      return <ComposerMenu {...props} controller={menu} referenceAnchored />;
    }
    wrap(<H />);
    const rows = screen.getAllByRole("option");
    // the connector row: name, description line, a drill button named for the connector
    expect(rows[0]?.textContent).toContain("团队消息");
    fireEvent.click(
      within(rows[0] as HTMLElement).getByRole("button", { name: "查看 Slack 的资源" }),
    );
    expect(drills.slack).toHaveBeenCalledTimes(1);
    // the button is not a pick
    expect(picks.slack).not.toHaveBeenCalled();
    // a connector waiting for setup: the badge, disabled, no drill
    expect(rows[1]?.getAttribute("aria-disabled")).toBe("true");
    expect(rows[1]?.querySelector('[data-part="composer-menu-badge"]')?.textContent).toBe("待配置");
    expect(rows[1]?.querySelector('[data-part="composer-menu-drill"]')).toBeNull();
    // the footer hints the key
    expect(document.querySelector('[data-part="composer-menu-foot"]')?.textContent).toContain(
      "→ 资源",
    );
  });

  it("ArrowRight on a drillable row drills", () => {
    const drills: Record<string, ReturnType<typeof vi.fn>> = {};
    wrap(<LevelHarness onBack={() => {}} withLevel={false} drills={drills} />);
    // the caret mid-text: → moves it, it does not drill
    select(0);
    key("ArrowRight");
    expect(drills.slack).not.toHaveBeenCalled();
    // the caret at the end (where typing the query leaves it): → drills
    select(1);
    const ev = createEvent.keyDown(textarea(), { key: "ArrowRight" });
    fireEvent(textarea(), ev);
    expect(drills.slack).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("shows the head with a back button at a level, and none for a flat menu", () => {
    const onBack = vi.fn();
    wrap(<LevelHarness onBack={onBack} />);
    const head = document.querySelector('[data-part="composer-menu-level"]') as HTMLElement;
    expect(head.textContent).toContain("Slack · 资源");
    fireEvent.click(within(head).getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    // the level's own footer carries no → hint
    expect(document.querySelector('[data-part="composer-menu-drill-hint"]')).toBeNull();
    cleanup();
    wrap(<LevelHarness onBack={onBack} withLevel={false} />);
    expect(document.querySelector('[data-part="composer-menu-level"]')).toBeNull();
  });

  it("ArrowLeft and Backspace on empty query go back", () => {
    const onBack = vi.fn();
    wrap(<LevelHarness onBack={onBack} />);
    const left = createEvent.keyDown(textarea(), { key: "ArrowLeft" });
    fireEvent(textarea(), left);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(left.defaultPrevented).toBe(true);
    const back = createEvent.keyDown(textarea(), { key: "Backspace" });
    fireEvent(textarea(), back);
    expect(onBack).toHaveBeenCalledTimes(2);
    // handled: the composer does not delete the "@"
    expect(back.defaultPrevented).toBe(true);
  });

  it("Backspace with a query does not go back", () => {
    const onBack = vi.fn();
    wrap(<LevelHarness onBack={onBack} initial="@sl" />);
    // the key stays the editor's (it deletes the query's last character)
    fireEvent.keyDown(textarea(), { key: "Backspace" });
    expect(onBack).not.toHaveBeenCalled();
  });

  it("compact renders the drill-in in the sheet", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const onBack = vi.fn();
    const drills: Record<string, ReturnType<typeof vi.fn>> = {};
    function Compact({ level }: { level: boolean }) {
      const props: ComposerMenuProps = {
        kind: "at",
        groups: connectorGroups({}, drills),
        query: "",
        filter: false,
        empty: "没有匹配",
        onClose: () => {},
        onQueryChange: () => {},
        ...(level ? { level: { title: "Slack · 资源", onBack } } : {}),
      };
      const menu = useComposerMenu(props);
      return <ComposerMenu {...props} controller={menu} />;
    }
    wrap(<Compact level={false} />);
    const sheet = screen.getByRole("dialog");
    // the drill button is a button of the row's trailing end
    fireEvent.click(within(sheet).getByRole("button", { name: "查看 Slack 的资源" }));
    expect(drills.slack).toHaveBeenCalledTimes(1);
    cleanup();
    wrap(<Compact level />);
    const level = screen.getByRole("dialog", { name: "Slack · 资源" });
    // the sheet's own drill-in: the level's title as the sheet title, its back control, no own head
    expect(within(level).getByRole("heading", { name: "Slack · 资源" })).toBeTruthy();
    expect(level.querySelector('[data-part="composer-menu-level"]')).toBeNull();
    fireEvent.click(within(level).getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    // Esc in the sheet goes back instead of closing
    fireEvent.keyDown(within(level).getByRole("searchbox"), { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(2);
    // Backspace on the empty search field goes back too
    fireEvent.keyDown(within(level).getByRole("searchbox"), { key: "Backspace" });
    expect(onBack).toHaveBeenCalledTimes(3);
  });

  it("the sheet search field drills only with the caret at the end of the query", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const drills: Record<string, ReturnType<typeof vi.fn>> = {};
    function Compact() {
      const props: ComposerMenuProps = {
        kind: "at",
        groups: connectorGroups({}, drills),
        query: "sl",
        filter: false,
        empty: "没有匹配",
        onClose: () => {},
        onQueryChange: () => {},
      };
      const menu = useComposerMenu(props);
      return <ComposerMenu {...props} controller={menu} />;
    }
    wrap(<Compact />);
    const search = screen.getByRole("searchbox") as HTMLInputElement;
    search.setSelectionRange(1, 1);
    fireEvent.keyDown(search, { key: "ArrowRight" });
    expect(drills.slack).not.toHaveBeenCalled();
    search.setSelectionRange(0, 2);
    fireEvent.keyDown(search, { key: "ArrowRight" });
    expect(drills.slack).not.toHaveBeenCalled();
    search.setSelectionRange(2, 2);
    fireEvent.keyDown(search, { key: "ArrowRight" });
    expect(drills.slack).toHaveBeenCalledTimes(1);
  });

  it("takes the caret facts from the caller when given (a contenteditable has none)", () => {
    const drills: Record<string, ReturnType<typeof vi.fn>> = {};
    const onBack = vi.fn();
    let ctl: ReturnType<typeof useComposerMenu> | undefined;
    function H({ level }: { level: boolean }) {
      const props: ComposerMenuProps = {
        kind: "at",
        groups: connectorGroups({}, drills),
        query: "",
        filter: false,
        empty: "没有匹配",
        onClose: () => {},
        ...(level ? { level: { title: "Slack · 资源", onBack } } : {}),
      };
      ctl = useComposerMenu(props);
      return <ComposerMenu {...props} controller={ctl} referenceAnchored />;
    }
    const div = document.createElement("div");
    const ev = (k: string) =>
      ({
        key: k,
        keyCode: 0,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        currentTarget: div,
        nativeEvent: {},
        preventDefault: () => {},
      }) as unknown as React.KeyboardEvent<HTMLElement>;
    wrap(<H level={false} />);
    const mid = { collapsed: true, atStart: false, atEnd: false };
    act(() => {
      expect(ctl?.onKeyDown(ev("ArrowRight"), mid)).toBe(false);
    });
    expect(drills.slack).not.toHaveBeenCalled();
    act(() => {
      expect(ctl?.onKeyDown(ev("ArrowRight"), { ...mid, atEnd: true })).toBe(true);
    });
    expect(drills.slack).toHaveBeenCalledTimes(1);
    cleanup();
    wrap(<H level />);
    act(() => {
      expect(
        ctl?.onKeyDown(ev("Backspace"), { collapsed: false, atStart: false, atEnd: true }),
      ).toBe(false);
    });
    expect(onBack).not.toHaveBeenCalled();
    act(() => {
      expect(
        ctl?.onKeyDown(ev("Backspace"), { collapsed: true, atStart: false, atEnd: true }),
      ).toBe(true);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("a key from a target without caret facts never drills", () => {
    const drills: Record<string, ReturnType<typeof vi.fn>> = {};
    let ctl: ReturnType<typeof useComposerMenu> | undefined;
    function H() {
      const props: ComposerMenuProps = {
        kind: "at",
        groups: connectorGroups({}, drills),
        query: "",
        filter: false,
        empty: "没有匹配",
        onClose: () => {},
      };
      ctl = useComposerMenu(props);
      return <ComposerMenu {...props} controller={ctl} referenceAnchored />;
    }
    wrap(<H />);
    const div = document.createElement("div");
    const ev = {
      key: "ArrowRight",
      keyCode: 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      currentTarget: div,
      nativeEvent: {},
      preventDefault: () => {},
    } as unknown as React.KeyboardEvent<HTMLElement>;
    act(() => {
      expect(ctl?.onKeyDown(ev)).toBe(false);
    });
    expect(drills.slack).not.toHaveBeenCalled();
  });

  it("compact keeps the search field focused through drill and back", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    function Compact() {
      const [level, setLevel] = useState(false);
      const props: ComposerMenuProps = {
        kind: "at",
        groups: connectorGroups({}, {}).map((g) => ({
          ...g,
          items: g.items.map((it) =>
            it.drill ? { ...it, drill: { ...it.drill, onDrill: () => setLevel(true) } } : it,
          ),
        })),
        query: "",
        filter: false,
        empty: "没有匹配",
        onClose: () => {},
        onQueryChange: () => {},
        ...(level ? { level: { title: "Slack · 资源", onBack: () => setLevel(false) } } : {}),
      };
      const menu = useComposerMenu(props);
      return <ComposerMenu {...props} controller={menu} />;
    }
    wrap(<Compact />);
    const field = () => screen.getByRole("searchbox");
    field().focus();
    fireEvent.keyDown(field(), { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Slack · 资源" })).toBeTruthy();
    expect(document.activeElement).toBe(field());
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(document.activeElement).toBe(field());
  });

  it("→ on a disabled drill row does nothing; ← with a query does not go back", () => {
    const onBack = vi.fn();
    const drill = vi.fn();
    function H({ query }: { query: string }) {
      const props: ComposerMenuProps = {
        kind: "at",
        groups: [
          {
            id: "g",
            items: [
              {
                id: "x",
                label: "X",
                disabled: true,
                drill: { label: "查看 X 的资源", onDrill: drill },
                onSelect: () => {},
              },
            ],
          },
        ],
        query,
        filter: false,
        empty: "没有匹配",
        onClose: () => {},
        level: { title: "t", onBack },
      };
      const menu = useComposerMenu(props);
      return <ComposerMenu {...props} controller={menu} referenceAnchored />;
    }
    const div = document.createElement("div");
    wrap(<H query="" />);
    expect(document.querySelector('[data-part="composer-menu-drill"]')).toBeNull();
    expect(document.querySelector("[aria-keyshortcuts]")).toBeNull();
    cleanup();
    // the full composer path: the textarea of a harness with a level and a query
    function L() {
      const [text] = useState("@sl");
      const props: ComposerMenuProps = {
        kind: "at",
        groups: connectorGroups(),
        query: text.slice(1),
        filter: false,
        empty: "没有匹配",
        onClose: () => {},
        level: { title: "t", onBack },
      };
      const menu = useComposerMenu(props);
      return (
        <ComposerBox
          segments={[text]}
          onChange={() => {}}
          onSubmit={() => {}}
          placeholder="输入消息"
          onAttach={() => {}}
          pickers={{ model: { label: "切换模型", value: "m", groups: [], onPick: () => {} } }}
          send={{ mode: "send", onClick: () => {} }}
          menu={{
            node: <ComposerMenu {...props} controller={menu} />,
            combobox: menu.combobox,
            onKeyDown: menu.onKeyDown,
          }}
        />
      );
    }
    wrap(<L />);
    const left = createEvent.keyDown(textarea(), { key: "ArrowLeft" });
    fireEvent(textarea(), left);
    expect(onBack).not.toHaveBeenCalled();
    expect(left.defaultPrevented).toBe(false);
    expect(drill).not.toHaveBeenCalled();
    void div;
  });

  it("the drill button names the connector, never picks the row, and the row advertises →", () => {
    const picks: Picks = {};
    const drills: Record<string, ReturnType<typeof vi.fn>> = {};
    function H() {
      const props: ComposerMenuProps = {
        kind: "at",
        groups: connectorGroups(picks, drills),
        query: "",
        filter: false,
        empty: "没有匹配",
        onClose: () => {},
      };
      const menu = useComposerMenu(props);
      return <ComposerMenu {...props} controller={menu} referenceAnchored />;
    }
    wrap(<H />);
    const row = screen.getAllByRole("option")[0] as HTMLElement;
    expect(row.getAttribute("aria-keyshortcuts")).toBe("ArrowRight");
    const btn = within(row).getByRole("button", { name: "查看 Slack 的资源" });
    expect(btn.getAttribute("aria-label")).toBe("查看 Slack 的资源");
    fireEvent.click(btn);
    expect(drills.slack).toHaveBeenCalledTimes(1);
    expect(picks.slack).not.toHaveBeenCalled();
  });

  it("the active row starts over when the level changes", () => {
    function H({ level }: { level: boolean }) {
      const props: ComposerMenuProps = {
        kind: "at",
        groups: [
          {
            id: "g",
            items: [
              { id: "a", label: "A", onSelect: () => {} },
              { id: "b", label: "B", onSelect: () => {} },
            ],
          },
        ],
        query: "",
        filter: false,
        empty: "没有匹配",
        onClose: () => {},
        ...(level ? { level: { title: "L", onBack: () => {} } } : {}),
      };
      const menu = useComposerMenu(props);
      return <ComposerMenu {...props} controller={menu} referenceAnchored />;
    }
    const { rerender } = wrap(<H level={false} />);
    fireEvent.mouseMove(screen.getAllByRole("option")[1] as HTMLElement);
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    rerender(
      <DesignProvider locale="zh">
        <H level />
      </DesignProvider>,
    );
    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("disabled skill rows show the one-skill line", () => {
    const groups: ComposerMenuGroup[] = [
      {
        id: "skills",
        label: "技能",
        items: [
          {
            id: "fix-issue",
            label: "fix-issue",
            icon: "skills",
            description: messages.zh["composerMenu.oneSkill"],
            disabled: true,
            onSelect: () => {},
          },
        ],
      },
    ];
    wrap(<Harness groups={groups} />);
    const row = options()[0] as HTMLElement;
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector('[data-part="composer-menu-desc"]')?.textContent).toBe(
      "一条消息只能使用一个技能",
    );
    expect(messages.en["composerMenu.oneSkill"]).toBe("One skill per message");
  });
});
