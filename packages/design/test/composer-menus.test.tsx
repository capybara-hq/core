import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerBox,
  ComposerMenu,
  type ComposerMenuGroup,
  type ComposerMenuProps,
  DesignProvider,
  rankComposerMenu,
  useComposerMenu,
} from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";
import { matchMediaFor } from "./width";

// The composer's menus (spec §6.16.30): ＋, / and @ share one shell anchored above the composer
// (a bottom sheet on compact); the textarea is the combobox, the list a listbox, and the query is
// the composer text after the trigger.

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
}: {
  groups: ComposerMenuGroup[];
  initial?: string;
  onClose?: () => void;
  onSwitch?: (k: "slash" | "at") => void;
  filter?: boolean;
  loading?: boolean;
  kind?: ComposerMenuProps["kind"];
}) {
  const [text, setText] = useState(initial);
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
      value={text}
      onChange={setText}
      placeholder="输入消息"
      onAttach={() => {}}
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

const textarea = () => screen.getByRole("combobox", { name: "消息" }) as HTMLTextAreaElement;
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

  it("↵ is the menu's: the composer's own Enter handler never sees it", () => {
    const onKeyDown = vi.fn();
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
          value="/"
          onChange={() => {}}
          onKeyDown={onKeyDown}
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
    key("Enter");
    expect(onKeyDown).not.toHaveBeenCalled();
    // a key the menu does not handle reaches the composer's handler
    key("a");
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("Esc closes and keeps the text", () => {
    const onClose = vi.fn();
    wrap(<Harness groups={slashGroups()} initial="/fi" onClose={onClose} />);
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe("/fi");
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
    textarea().focus();
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
    const at = within(foot).getByRole("button", { name: "@ 文件与资源" });
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
    expect(within(foot).getByRole("button", { name: "@ Files and resources" })).toBeTruthy();
    expect(foot.textContent).toContain("esc Close");
  });

  it("draws no box inside a box", () => {
    const { container } = wrap(<Harness groups={slashGroups()} onSwitch={() => {}} />);
    expect(findNestedBoxes(container).map(describeNestedBox)).toEqual([]);
  });
});

describe("the ＋ button", () => {
  it("keeps aria-haspopup=menu and reports attachOpen as aria-expanded", () => {
    const base = {
      value: "",
      onChange: () => {},
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
        value=""
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
});
