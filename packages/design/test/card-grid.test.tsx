import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Card,
  CardGrid,
  DesignProvider,
  type LinkComponent,
  ListPage,
  ObjectCard,
  type ObjectCardProps,
} from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

// CardGrid and ObjectCard (spec §6.34, ruling P4-15): one box per card on the page ground, one
// link per card with the primary and the menu beside it (never inside it), roving focus by row.

afterEach(cleanup);

/** A design link that records navigations instead of letting jsdom follow them. */
function withNav(ui: ReactElement) {
  const nav = vi.fn();
  const Link: LinkComponent = ({ href, children, ...rest }) => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        e.preventDefault();
        nav(href);
      }}
    >
      {children}
    </a>
  );
  const view = render(
    <DesignProvider locale="zh" link={Link}>
      {ui}
    </DesignProvider>,
  );
  return { nav, ...view };
}

const card = (
  over: Partial<Extract<ObjectCardProps, { title: string }>> = {},
): ObjectCardProps => ({
  avatar: { kind: "preset", id: "capybara" },
  title: "研究助手",
  href: "/agents/a",
  description: "帮你检索资料、整理笔记，并按需生成摘要。",
  meta: ["grant", "仅自己"],
  primary: { label: "开始会话", onSelect: () => {} },
  menu: [
    { label: "设置", href: "/agents/a/settings" },
    { label: "运行记录", href: "/agents/a/runs" },
  ],
  ...over,
});

const NAMES = ["研究助手", "周报助手", "客服助手", "翻译助手", "代码助手"];

function grid(cards: ObjectCardProps[] = NAMES.map((n, i) => card({ title: n, href: `/a/${i}` }))) {
  return (
    <CardGrid label="智能体">
      {cards.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed test cards
        <ObjectCard key={i} {...c} />
      ))}
    </CardGrid>
  );
}

describe("ObjectCard", () => {
  it("draws the avatar, the name as the one link, the description, the meta, the primary and the menu", () => {
    withNav(grid([card()]));
    const list = screen.getByRole("list", { name: "智能体" });
    const item = within(list).getByRole("listitem");
    expect(item.getAttribute("data-part")).toBe("object-card");
    const links = within(item).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/agents/a");
    expect(links[0]?.textContent).toBe("研究助手");
    const avatar = item.querySelector('[data-part="object-card-avatar"]');
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.querySelector('[data-part="avatar"]')?.getAttribute("data-size")).toBe("40");
    expect(within(item).getByText("帮你检索资料、整理笔记，并按需生成摘要。")).toBeTruthy();
    expect(within(item).getByText("grant · 仅自己")).toBeTruthy();
    expect(within(item).getByRole("button", { name: "开始会话" })).toBeTruthy();
    expect(within(item).getByRole("button", { name: "更多操作" })).toBeTruthy();
  });

  it("nests nothing interactive: the link holds only the name, the buttons sit beside it", () => {
    withNav(grid([card()]));
    const link = screen.getByRole("link", { name: "研究助手" });
    expect(link.querySelector("a, button, input, [tabindex]")).toBeNull();
    for (const b of screen.getAllByRole("button")) expect(b.closest("a")).toBeNull();
  });

  it("the whole card opens href: the name and the description navigate, the primary and the menu do not", async () => {
    const onStart = vi.fn();
    const { nav } = withNav(grid([card({ primary: { label: "开始会话", onSelect: onStart } })]));
    await userEvent.click(screen.getByRole("button", { name: "开始会话" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(nav).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(nav).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("link", { name: "研究助手" }));
    expect(nav).toHaveBeenLastCalledWith("/agents/a");
    nav.mockClear();
    // The description sits over the stretched link (for its tooltip) and passes a click on.
    await userEvent.click(screen.getByText("帮你检索资料、整理笔记，并按需生成摘要。"));
    expect(nav).toHaveBeenCalledWith("/agents/a");
  });

  /** Lays the name and the description out as cut off (or not): jsdom measures nothing. */
  function measured(cut: boolean) {
    const part = (el: HTMLElement) => el.getAttribute("data-part");
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return part(this) === "object-card-name" && cut ? 600 : 200;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return part(this) === "object-card-description" && cut ? 120 : 40;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
  }

  it("the description is clamped to two lines and the name to one; the full text is their title only when cut off", () => {
    const long = "很长的描述".repeat(40);
    measured(true);
    withNav(grid([card({ description: long, title: "名字很长".repeat(12) })]));
    const desc = document.querySelector('[data-part="object-card-description"]');
    expect(desc?.getAttribute("title")).toBe(long);
    const name = document.querySelector('[data-part="object-card-name"]');
    expect(name?.getAttribute("title")).toBe("名字很长".repeat(12));
    cleanup();
    vi.restoreAllMocks();
    measured(false);
    withNav(grid([card()]));
    expect(
      document.querySelector('[data-part="object-card-description"]')?.hasAttribute("title"),
    ).toBe(false);
    expect(document.querySelector('[data-part="object-card-name"]')?.hasAttribute("title")).toBe(
      false,
    );
    vi.restoreAllMocks();
    const css = readFileSync(resolve(__dirname, "../src/styles/card-grid.css"), "utf8");
    const rule = /\.cb-object-card-desc\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/-webkit-line-clamp:\s*2/);
    const nameRule = /\.cb-object-card-name\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(nameRule).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("a click on the description: a selection inside it stays one, Ctrl / Cmd or the middle button open a new tab", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { nav } = withNav(
      <>
        <p>别处的文字</p>
        {grid([card()])}
      </>,
    );
    const desc = screen.getByText("帮你检索资料、整理笔记，并按需生成摘要。");
    // a selection elsewhere on the page does not stop the card from opening
    const sel = window.getSelection() as Selection;
    sel.selectAllChildren(screen.getByText("别处的文字"));
    fireEvent.click(desc);
    expect(nav).toHaveBeenCalledTimes(1);
    // a selection inside the description keeps the click a selection
    sel.selectAllChildren(desc);
    fireEvent.click(desc);
    expect(nav).toHaveBeenCalledTimes(1);
    sel.removeAllRanges();
    fireEvent.click(desc, { ctrlKey: true });
    fireEvent.click(desc, { metaKey: true });
    fireEvent(desc, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(nav).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(3);
    expect(open).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/agents\/a$/),
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("the primary, the lone item and the menu are described by the card's name", () => {
    withNav(
      grid([
        card(),
        card({ title: "周报模板", href: "/t", menu: [{ label: "查看", href: "/t/v" }] }),
      ]),
    );
    const [first, second] = screen.getAllByRole("listitem") as HTMLElement[];
    const nameOf = (el: HTMLElement) =>
      document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent;
    const one = within(first as HTMLElement);
    expect(nameOf(one.getByRole("button", { name: "开始会话" }))).toBe("研究助手");
    expect(nameOf(one.getByRole("button", { name: "更多操作" }))).toBe("研究助手");
    expect(nameOf(within(second as HTMLElement).getByRole("link", { name: "查看" }))).toBe(
      "周报模板",
    );
  });

  it("without a description draws no description line", () => {
    const { description: _omit, ...rest } = card() as Extract<ObjectCardProps, { title: string }>;
    withNav(grid([rest]));
    expect(document.querySelector('[data-part="object-card-description"]')).toBeNull();
  });

  it("without href (a read-only list) the name is plain text: no link, the description opens nothing", async () => {
    const {
      href: _h,
      primary: _p,
      menu: _m,
      ...rest
    } = card({ avatar: { image: null } }) as Extract<ObjectCardProps, { title: string }>;
    const { nav } = withNav(grid([rest]));
    expect(screen.queryByRole("link")).toBeNull();
    const name = document.querySelector('[data-part="object-card-name"]');
    expect(name?.getAttribute("data-static")).toBe("true");
    expect(name?.textContent).toBe("研究助手");
    await userEvent
      .setup()
      .click(document.querySelector('[data-part="object-card-description"]') as HTMLElement);
    expect(nav).not.toHaveBeenCalled();
    // the plugin icon slot falls back to the initial
    expect(document.querySelector('[data-part="object-card-avatar"]')?.textContent).toBe("研");
  });

  it("an icon in place of the avatar, or the initial square when there is no avatar", () => {
    withNav(
      grid([
        card({ title: "周报模板", avatar: { icon: "file-text" }, href: "/t/1" }),
        card({ title: "客服助手", avatar: null, href: "/t/2" }),
      ]),
    );
    const [first, second] = screen.getAllByRole("listitem");
    const icon = first?.querySelector('[data-part="object-card-avatar"]');
    expect(icon?.getAttribute("data-kind")).toBe("icon");
    expect(icon?.querySelector("svg")).not.toBeNull();
    expect(second?.querySelector('[data-part="avatar"]')?.textContent).toBe("客");
  });

  it("no menu of one: a lone safe item is a second button, none draws no menu", () => {
    withNav(
      grid([
        card({ title: "a", href: "/a", menu: [{ label: "查看", href: "/a/view" }] }),
        card({ title: "b", href: "/b", menu: [] }),
      ]),
    );
    const [first, second] = screen.getAllByRole("listitem");
    expect(within(first as HTMLElement).getByRole("link", { name: "查看" })).toBeTruthy();
    expect(within(first as HTMLElement).queryByRole("button", { name: "更多操作" })).toBeNull();
    expect(within(second as HTMLElement).queryByRole("button", { name: "更多操作" })).toBeNull();
  });

  it("oneButton: beside a primary a lone safe item stays in the menu; without one it is the button", async () => {
    withNav(
      grid([
        card({
          title: "a",
          href: "/a",
          id: "connector-a",
          oneButton: true,
          primary: { label: "连接", onSelect: () => {} },
          menu: [{ label: "如何连接", onSelect: () => {} }],
        }),
        (({ primary: _p, ...rest }) => rest)(
          card({
            title: "b",
            href: "/b",
            oneButton: true,
            menu: [{ label: "修改配置", href: "/b?tab=settings" }],
          }) as Extract<ObjectCardProps, { title: string }>,
        ),
      ]),
    );
    const [first, second] = screen.getAllByRole("listitem");
    expect(first?.id).toBe("connector-a");
    expect(
      within(first as HTMLElement)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["连接", ""]);
    expect(within(first as HTMLElement).queryByRole("button", { name: "如何连接" })).toBeNull();
    expect(within(first as HTMLElement).getByRole("button", { name: "更多操作" })).toBeTruthy();
    expect(within(second as HTMLElement).getByRole("link", { name: "修改配置" })).toBeTruthy();
    expect(within(second as HTMLElement).queryByRole("button", { name: "更多操作" })).toBeNull();
  });

  it("a primary that is a link is a second link beside the name, never inside it", () => {
    withNav(grid([card({ primary: { label: "查看", href: "/t/1" } })]));
    const item = screen.getByRole("listitem");
    const view = within(item).getByRole("link", { name: "查看" });
    expect(view.getAttribute("href")).toBe("/t/1");
    expect(view.closest('[data-part="object-card-link"]')).toBeNull();
  });

  it("a running primary shows its loading state and the card's buttons wait", () => {
    withNav(grid([card({ primary: { label: "开始会话", onSelect: () => {}, loading: true } })]));
    expect(screen.getByRole("button", { name: "开始会话" }).getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "更多操作" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("CardGrid keyboard (roving focus by row)", () => {
  /** Lays the cards out in rows of `cols` (jsdom has no layout). */
  function layout(cols: number) {
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-part="object-card"]'));
    items.forEach((el, i) => {
      const top = Math.floor(i / cols) * 172;
      const left = (i % cols) * 356;
      el.getBoundingClientRect = () =>
        ({ top, left, bottom: top + 160, right: left + 344, width: 344, height: 160 }) as DOMRect;
    });
  }
  const link = (name: string) => screen.getByRole("link", { name });

  it("one tab stop for the grid: Tab reaches the card's link, its primary, its menu, then leaves", async () => {
    withNav(
      <>
        <button type="button">之前</button>
        {grid()}
        <button type="button">之后</button>
      </>,
    );
    screen.getByRole("button", { name: "之前" }).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(link("研究助手"));
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe("开始会话");
    await userEvent.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("更多操作");
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "之后" }));
  });

  it("← → move between cards in reading order, ↑ ↓ by a row, Home / End to the ends", async () => {
    withNav(grid());
    layout(3);
    link("研究助手").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(link("周报助手"));
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    // past the row's end: the next row's first card
    expect(document.activeElement).toBe(link("翻译助手"));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(link("研究助手"));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(link("翻译助手"));
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(link("客服助手"));
    // nothing below the third column of a short last row: the last card
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(link("代码助手"));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(link("代码助手"));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(link("研究助手"));
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(link("研究助手"));
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(link("代码助手"));
  });

  it("the card last reached holds the tab stop, its buttons included; the others leave the tab order", async () => {
    withNav(
      <>
        {grid()}
        <button type="button">之后</button>
      </>,
    );
    layout(3);
    link("研究助手").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(link("周报助手").tabIndex).toBe(0);
    expect(link("研究助手").tabIndex).toBe(-1);
    const [first, second] = screen.getAllByRole("listitem") as HTMLElement[];
    for (const b of within(first as HTMLElement).getAllByRole("button"))
      expect(b.tabIndex).toBe(-1);
    for (const b of within(second as HTMLElement).getAllByRole("button"))
      expect(b.tabIndex).toBe(0);
    await userEvent.tab();
    expect(document.activeElement?.closest("li")).toBe(second);
    expect(document.activeElement?.textContent).toBe("开始会话");
    // leaving and coming back lands on the same card
    screen.getByRole("button", { name: "之后" }).focus();
    await userEvent.tab({ shift: true });
    expect(document.activeElement?.closest("li")).toBe(second);
  });

  it("arrows on the primary or the menu belong to them (the menu opens on ↓)", async () => {
    withNav(grid());
    layout(3);
    const primary = within(screen.getAllByRole("listitem")[0] as HTMLElement).getByRole("button", {
      name: "开始会话",
    });
    primary.focus();
    fireEvent.keyDown(primary, { key: "ArrowRight" });
    expect(document.activeElement).toBe(primary);
  });

  it("a click on a card's button moves the tab stop to that card", async () => {
    withNav(grid());
    const third = screen.getAllByRole("listitem")[2] as HTMLElement;
    await userEvent.click(within(third).getByRole("button", { name: "开始会话" }));
    expect(link("客服助手").tabIndex).toBe(0);
    expect(link("研究助手").tabIndex).toBe(-1);
  });

  it("the ⋯ menu opens from the keyboard (↵ or ↓ on its trigger)", async () => {
    withNav(grid());
    const first = screen.getAllByRole("listitem")[0] as HTMLElement;
    const trigger = within(first).getByRole("button", { name: "更多操作" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "设置" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "设置" })).toBeNull();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menuitem", { name: "设置" })).toBeTruthy();
  });

  it("↑ ↓ follow a re-layout: two columns, then three", async () => {
    withNav(grid());
    layout(2);
    link("研究助手").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(link("客服助手"));
    layout(3);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(link("代码助手"));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(link("周报助手"));
  });

  it("Tab from the last card's menu leaves the grid", async () => {
    withNav(
      <>
        {grid()}
        <button type="button">之后</button>
      </>,
    );
    layout(3);
    link("研究助手").focus();
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(link("代码助手"));
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("更多操作");
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "之后" }));
  });

  it("arrows skip skeleton cards; fragments in the children are opened", async () => {
    withNav(
      <CardGrid label="智能体">
        <>
          <ObjectCard key="a" {...card({ title: "研究助手", href: "/a" })} />
          <ObjectCard key="b" {...card({ title: "周报助手", href: "/b" })} />
        </>
        <ObjectCard key="s" loading />
      </CardGrid>,
    );
    layout(3);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    link("研究助手").focus();
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(link("周报助手"));
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(link("周报助手"));
  });

  it("an ObjectCard outside a CardGrid keeps every control in the tab order", () => {
    withNav(
      <ul>
        <ObjectCard {...card()} />
      </ul>,
    );
    expect(link("研究助手").tabIndex).toBe(0);
    for (const b of screen.getAllByRole("button")) expect(b.tabIndex).toBe(0);
  });
});

describe("CardGrid keeps the stop on its card", () => {
  const link = (name: string) => screen.getByRole("link", { name });

  /** A grid whose cards can be deleted from their ⋯ menu, and added or removed from outside. */
  function Deletable({ initial }: { initial: string[] }) {
    const [names, setNames] = useState(initial);
    return (
      <>
        <button type="button" onClick={() => setNames((n) => n.slice(1))}>
          删第一个
        </button>
        <button type="button" onClick={() => setNames((n) => [...n, `新助手${n.length}`])}>
          加一个
        </button>
        <CardGrid label="智能体">
          {names.map((n) => (
            <ObjectCard
              key={n}
              title={n}
              href={`/a/${n}`}
              primary={{ label: "开始会话", onSelect: () => {} }}
              menu={[
                { label: "设置", onSelect: () => {} },
                {
                  label: "删除",
                  danger: true,
                  onSelect: () => setNames((all) => all.filter((x) => x !== n)),
                },
              ]}
            />
          ))}
        </CardGrid>
      </>
    );
  }
  const menuOf = (name: string) =>
    within(link(name).closest("li") as HTMLElement).getByRole("button", { name: "更多操作" });

  it("the held card deleted from its own ⋯ menu: the stop and focus move to its neighbour's link", async () => {
    withNav(<Deletable initial={["甲", "乙", "丙"]} />);
    link("甲").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(link("乙"));
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(menuOf("乙"));
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    expect(screen.queryByRole("link", { name: "乙" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(link("丙")));
    expect(link("丙").tabIndex).toBe(0);
    expect(link("甲").tabIndex).toBe(-1);
    // and it stays there once the menu has finished closing
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(link("丙"));
  });

  it("the last card deleted: the stop and focus go to the new last card", async () => {
    withNav(<Deletable initial={["甲", "乙"]} />);
    link("甲").focus();
    await userEvent.keyboard("{End}");
    menuOf("乙").focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    await waitFor(() => expect(document.activeElement).toBe(link("甲")));
    expect(link("甲").tabIndex).toBe(0);
  });

  it("a card removed before the stop, or cards added: the stop stays on its card", async () => {
    withNav(<Deletable initial={["甲", "乙", "丙"]} />);
    link("甲").focus();
    await userEvent.keyboard("{End}");
    expect(link("丙").tabIndex).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "删第一个" }));
    expect(link("丙").tabIndex).toBe(0);
    expect(link("乙").tabIndex).toBe(-1);
    // focus was outside the grid: nothing moves it back in
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "删第一个" }));
    await userEvent.click(screen.getByRole("button", { name: "加一个" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(link("丙").tabIndex).toBe(0);
    expect(link("新助手2").tabIndex).toBe(-1);
  });

  it("the held card filtered out while focus is elsewhere: the stop moves to its neighbour, focus stays", async () => {
    const keyed = (names: string[]) => (
      <DesignProvider locale="zh">
        <CardGrid label="智能体">
          {names.map((n) => (
            <ObjectCard key={n} {...card({ title: n, href: `/a/${n}` })} />
          ))}
        </CardGrid>
      </DesignProvider>
    );
    const { rerender } = render(keyed(NAMES));
    link("研究助手").focus();
    await userEvent.keyboard("{ArrowRight}");
    link("周报助手").blur();
    rerender(keyed(NAMES.filter((n) => n !== "周报助手")));
    expect(link("客服助手").tabIndex).toBe(0);
    expect(link("研究助手").tabIndex).toBe(-1);
    expect(document.activeElement).toBe(document.body);
  });

  it("the held card filtered out while its link has focus: focus goes to the neighbour's link", async () => {
    const keyed = (names: string[]) => (
      <DesignProvider locale="zh">
        <CardGrid label="智能体">
          {names.map((n) => (
            <ObjectCard key={n} {...card({ title: n, href: `/a/${n}` })} />
          ))}
        </CardGrid>
      </DesignProvider>
    );
    const { rerender } = render(keyed(NAMES));
    link("研究助手").focus();
    await userEvent.keyboard("{ArrowRight}");
    rerender(keyed(NAMES.filter((n) => n !== "周报助手")));
    expect(document.activeElement).toBe(link("客服助手"));
    expect(link("客服助手").tabIndex).toBe(0);
  });
});

describe("CardGrid states", () => {
  it("loading: skeleton cards in the real card's anatomy, busy, announced once", () => {
    withNav(<CardGrid label="智能体" loading />);
    const list = screen.getByRole("list", { name: "智能体" });
    expect(list.getAttribute("aria-busy")).toBe("true");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    for (const item of items) {
      expect(item.getAttribute("data-part")).toBe("object-card");
      expect(item.getAttribute("data-skeleton")).toBe("true");
      const avatar = item.querySelector(
        '[data-part="object-card-avatar"] [data-part="skeleton-box"]',
      );
      expect(avatar?.getAttribute("data-box")).toBe("block");
      expect(
        item.querySelectorAll('[data-part="object-card-description"] [data-part="skeleton-text"]'),
      ).toHaveLength(2);
      expect(
        item.querySelector('[data-part="object-card-name"] [data-part="skeleton-text"]'),
      ).not.toBeNull();
      expect(
        item.querySelector('[data-part="object-card-meta"] [data-part="skeleton-text"]'),
      ).not.toBeNull();
      expect(
        item.querySelector('[data-part="object-card-foot"] [data-box="dense"]'),
      ).not.toBeNull();
      expect(item.querySelector("a, button")).toBeNull();
    }
    expect(within(list).getAllByText("正在加载")).toHaveLength(1);
  });

  it("loading takes a card count and wins over empty", () => {
    withNav(<CardGrid label="智能体" loading={2} empty={{ text: "还没有智能体" }} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("还没有智能体")).toBeNull();
  });

  it("empty: the design's empty state instead of the grid", () => {
    withNav(<CardGrid label="智能体" empty={{ text: "还没有智能体", hint: "从模板创建一个" }} />);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("还没有智能体")).toBeTruthy();
    expect(document.querySelector('[data-part="empty-state"]')?.getAttribute("data-size")).toBe(
      "page",
    );
  });

  it("the grid is responsive from tokens: auto-fill at layout.card-min, space.3 gaps, one column on phones", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles/card-grid.css"), "utf8");
    const rule = /\.cb-card-grid\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(
      /repeat\(\s*auto-fill,\s*minmax\(\s*min\(100%,\s*var\(--cb-layout-card-min\)\)/,
    );
    expect(rule).toMatch(/gap:\s*var\(--cb-space-3\)/);
    expect(css).toMatch(
      /@media \(max-width: 639px\)\s*\{[^@]*\.cb-card-grid\s*\{\s*grid-template-columns:\s*1fr;/,
    );
  });
});

describe("one box per card", () => {
  it("cards on the page ground: no box around the grid, nothing boxed inside a card", () => {
    withNav(grid());
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    const list = screen.getByRole("list", { name: "智能体" });
    expect(list.className).toBe("cb-card-grid");
  });

  it("a card inside a box is a nested box", () => {
    withNav(<Card title="外框">{grid([card()])}</Card>);
    expect(findNestedBoxes(document.body).map((n) => `${n.inner} in ${n.outer}`)).toEqual([
      "ObjectCard in Card",
    ]);
  });
});

describe("ListPage variant=cards", () => {
  const header = {
    path: [{ label: "capybara" }, { label: "智能体" }],
    title: "智能体",
    tabs: [
      { id: "agents", label: "智能体", count: 5 },
      { id: "templates", label: "模板", count: 2 },
    ],
    activeTab: "agents",
  };
  const page = (props: Partial<Parameters<typeof ListPage>[0]> = {}, children?: ReactNode) => (
    <ListPage header={header} variant="cards" {...props}>
      {children}
    </ListPage>
  );

  it("draws the cards in one CardGrid named by the list label, under the one head, with the filters above", () => {
    withNav(
      page(
        { listLabel: "智能体列表", filters: <div>筛选</div> },
        NAMES.map((n, i) => <ObjectCard key={n} {...card({ title: n, href: `/a/${i}` })} />),
      ),
    );
    const list = screen.getByRole("list", { name: "智能体列表" });
    expect(list.className).toBe("cb-card-grid");
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(document.querySelectorAll('[data-part="template-head"]')).toHaveLength(1);
    const filters = screen.getByText("筛选");
    expect(filters.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("loading: skeleton cards (rows sets the count) in the page's one busy region, the tabs kept", () => {
    withNav(page({ loading: { rows: 3 } }));
    const list = screen.getByRole("list", { name: "智能体" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    // the page's group announces; the grid adds none of its own
    expect(screen.getAllByText("正在加载")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: /模板/ })).toBeTruthy();
  });

  it("empty: the page's empty state instead of the grid", () => {
    withNav(page({ empty: { text: "还没有智能体" } }));
    expect(screen.queryByRole("list", { name: "智能体" })).toBeNull();
    expect(screen.getByText("还没有智能体")).toBeTruthy();
  });
});
