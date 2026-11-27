import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Card,
  DesignProvider,
  type LibraryAction,
  LibraryPage,
  type LibraryPageProps,
  ListDetailList,
  Select,
} from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";
import { type ShellPage, ShellPageContext } from "../src/shell/shell-page";
import { renderAtClass } from "./width";

// LibraryPage (spec §5.13): the Files page's template in its three size-class forms. Expanded and
// medium draw two panes while the region fits a 320 list and a 360 preview, else the list alone
// and the open file in a side Sheet; compact is a pushed page with the origin views as a
// full-width Segmented, a search icon that expands, one 筛选 sheet and the open file on a screen
// of its own.

const real = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = real;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const ACTIONS: LibraryAction[] = [
  { id: "share", label: "分享", icon: "share", onSelect: () => {} },
  { id: "download", label: "下载", icon: "download", href: "/files/f1/download", download: true },
  { id: "delete", label: "删除", icon: "x", onSelect: () => {}, menu: true, danger: true },
];

function props(over: Partial<LibraryPageProps> = {}): LibraryPageProps {
  return {
    header: {
      path: [{ label: "capybara", href: "/" }, { label: "文件" }],
      title: "文件",
      tabs: [
        { id: "all", label: "全部", onSelect: () => {} },
        { id: "agent", label: "智能体交付", onSelect: () => {} },
        { id: "upload", label: "我上传的", onSelect: () => {} },
      ],
      activeTab: "all",
      search: { label: "搜索文件", value: "", onChange: () => {} },
    },
    actions: [{ label: "上传", icon: "upload", variant: "primary", onSelect: () => {} }],
    filters: (
      <Select
        aria-label="智能体"
        value=""
        onChange={() => {}}
        options={[{ value: "", label: "全部智能体" }]}
      />
    ),
    usage: "已用 12.4 MB",
    list: (
      <ListDetailList
        label="文件"
        current="f1"
        onOpen={() => {}}
        groups={[
          {
            id: "today",
            label: "今天",
            items: [{ id: "f1", title: "季度报告.pdf", meta: "智能体交付 · 1.2 MB", icon: "file" }],
          },
          { id: "week", label: "本周", items: [] },
          {
            id: "older",
            label: "更早",
            items: [{ id: "f2", title: "logo.png", meta: "我上传的 · 88 KB", icon: "image" }],
          },
        ]}
      />
    ),
    detail: <p>THE PREVIEW</p>,
    detailTitle: "季度报告.pdf",
    detailActions: ACTIONS,
    onBack: () => {},
    ...over,
  };
}

const part = (p: string, root: ParentNode = document) =>
  root.querySelector<HTMLElement>(`[data-part="${p}"]`);

/** Gives the panes region a width (jsdom lays nothing out): the template's fit reads it. */
function regionWidth(width: number) {
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("cb-library-split")) {
      return {
        width,
        height: 600,
        top: 0,
        left: 0,
        right: width,
        bottom: 600,
        x: 0,
        y: 0,
      } as DOMRect;
    }
    return real.call(this);
  });
}

function shellStub() {
  const pages = new Map<symbol, ShellPage>();
  const register = vi.fn((id: symbol, page: ShellPage | null) => {
    if (page === null) pages.delete(id);
    else pages.set(id, { ...pages.get(id), ...page });
  });
  const onBack = () => [...pages.values()].find((p) => p.onBack)?.onBack;
  return { register, onBack };
}

const inShell = (register: ReturnType<typeof shellStub>["register"], ui: ReactElement) => (
  <ShellPageContext.Provider value={register}>{ui}</ShellPageContext.Provider>
);

describe("ListDetailList groups", () => {
  it("heads each group's rows with its label and leaves an empty group out", () => {
    render(
      <DesignProvider locale="zh">
        <ListDetailList
          label="文件"
          onOpen={() => {}}
          groups={[
            { id: "today", label: "今天", items: [{ id: "a", title: "a.txt", icon: "file-text" }] },
            { id: "week", label: "本周", items: [] },
          ]}
        />
      </DesignProvider>,
    );
    expect(screen.getByRole("group", { name: "文件" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "今天" })).toBeTruthy();
    expect(screen.queryByText("本周")).toBeNull();
    expect(within(screen.getByRole("list", { name: "今天" })).getByText("a.txt")).toBeTruthy();
    expect(part("list-icon")).toBeTruthy();
    expect(part("list-dot")).toBeNull();
  });
});

describe("LibraryPage expanded (two panes)", () => {
  it("draws the head's views and search, the filter row, the grouped list and the preview card", () => {
    const { container } = renderAtClass(1280, <LibraryPage {...props()} />);
    const root = container.querySelector('[data-template="LibraryPage"]');
    expect(root).toBeTruthy();
    expect(part("page-header-tabs")).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "搜索文件" })).toBeTruthy();
    expect(part("library-filters")).toBeTruthy();
    expect(part("library-compact-bar")).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "今天" })).toBeTruthy();
    expect(part("library-usage")?.textContent).toBe("已用 12.4 MB");
    // nothing open: two panes still show the selected file beside the list
    expect(part("list-detail")?.getAttribute("data-open")).toBe("false");
    expect(screen.getByText("THE PREVIEW")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "季度报告.pdf" })).toBeTruthy();
    // the actions are labelled buttons, a link for the download, delete in the menu
    expect(screen.getByRole("button", { name: "分享" }).textContent).toContain("分享");
    expect(screen.getByRole("link", { name: "下载" }).getAttribute("download")).toBe("");
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(screen.getByRole("button", { name: "更多操作" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("puts the upload in the head and shows the preview empty state with nothing selected", () => {
    renderAtClass(
      1280,
      <LibraryPage
        {...props({ detail: null, detailTitle: undefined, detailEmpty: { text: "选择一个文件" } })}
      />,
    );
    expect(screen.getByRole("button", { name: "上传" })).toBeTruthy();
    expect(screen.getByText("选择一个文件")).toBeTruthy();
    expect(screen.queryByText("THE PREVIEW")).toBeNull();
  });

  it("draws one box per pane: no box inside a box", () => {
    const { container } = renderAtClass(1280, <LibraryPage {...props()} />);
    expect(findNestedBoxes(container).map(describeNestedBox)).toEqual([]);
  });

  it("counts a Card passed in the preview as a box inside the preview pane", () => {
    const { container } = renderAtClass(
      1280,
      <LibraryPage {...props({ detail: <Card>NESTED</Card> })} />,
    );
    expect(findNestedBoxes(container).map((f) => `${f.inner} in ${f.outer}`)).toEqual([
      "Card in LibraryPage detail",
    ]);
  });

  it("an empty library draws one EmptyState in place of the panes and keeps the filters", () => {
    renderAtClass(1280, <LibraryPage {...props({ empty: { text: "还没有文件" } })} />);
    expect(screen.getByText("还没有文件")).toBeTruthy();
    expect(part("library-split")).toBeNull();
    expect(part("library-filters")).toBeTruthy();
  });

  it("loading keeps the head and filters, draws placeholder rows and no preview", () => {
    const { container } = renderAtClass(1280, <LibraryPage {...props({ loading: { rows: 3 } })} />);
    expect(container.querySelectorAll('[data-part="loading-row"]')).toHaveLength(3);
    expect(screen.queryByText("THE PREVIEW")).toBeNull();
    expect(screen.queryByText("季度报告.pdf")).toBeNull();
    expect(part("library-filters")).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });
});

describe("LibraryPage medium (side sheet when two panes do not fit)", () => {
  it("opens the file in a side Sheet whose close calls onBack; the list stays", () => {
    regionWidth(520);
    const onBack = vi.fn();
    renderAtClass(700, <LibraryPage {...props({ open: true, onBack })} />);
    const sheet = screen.getByRole("dialog", { name: "季度报告.pdf" });
    expect(within(sheet).getByText("THE PREVIEW")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "分享" })).toBeTruthy();
    // the region stays on the list, its row still the current one
    expect(part("list-detail")?.getAttribute("data-open")).toBe("false");
    expect(screen.getByText("季度报告.pdf", { selector: ".cb-ld-title" })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "关闭" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("keeps two panes and no sheet while the region fits both", () => {
    regionWidth(760);
    renderAtClass(800, <LibraryPage {...props({ open: true })} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(part("list-detail")?.getAttribute("data-open")).toBe("true");
    expect(screen.getByText("THE PREVIEW")).toBeTruthy();
  });
});

describe("LibraryPage compact", () => {
  it("moves the views into a full-width Segmented and the filters behind one 筛选 sheet", () => {
    renderAtClass(390, <LibraryPage {...props()} />);
    expect(part("page-header-tabs")).toBeNull();
    expect(part("library-filters")).toBeNull();
    const seg = part("segmented");
    expect(seg?.getAttribute("data-fill")).toBe("true");
    expect(
      within(seg as HTMLElement)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["全部", "智能体交付", "我上传的"]);
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    const sheet = screen.getByRole("dialog", { name: "筛选" });
    expect(within(sheet).getByRole("combobox", { name: "智能体" })).toBeTruthy();
  });

  it("calls the view's onSelect from the Segmented", () => {
    const onSelect = vi.fn();
    const p = props();
    const tabs = (p.header.tabs ?? []).map((x) => (x.id === "upload" ? { ...x, onSelect } : x));
    renderAtClass(390, <LibraryPage {...p} header={{ ...p.header, tabs }} />);
    fireEvent.click(screen.getByRole("radio", { name: "我上传的" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("draws the search as an icon that expands into the field and collapses again", () => {
    const onChange = vi.fn();
    const p = props();
    renderAtClass(
      390,
      <LibraryPage
        {...p}
        header={{ ...p.header, search: { label: "搜索文件", value: "", onChange } }}
      />,
    );
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "搜索文件" }));
    const field = screen.getByRole("searchbox", { name: "搜索文件" });
    expect(document.activeElement).toBe(field);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("an open file is its own screen: the head gives way, icon actions, the shell's back", () => {
    const shell = shellStub();
    const onBack = vi.fn();
    const { container } = renderAtClass(
      390,
      inShell(shell.register, <LibraryPage {...props({ open: true, onBack })} />),
    );
    const root = container.querySelector('[data-template="LibraryPage"]');
    expect(root?.getAttribute("data-open")).toBe("true");
    expect(part("list-detail")?.getAttribute("data-open")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
    // share and download as icon buttons in the top bar, delete in the menu
    const head = part("library-detail-head") as HTMLElement;
    expect(within(head).getByRole("button", { name: "分享" }).textContent).toBe("");
    expect(within(head).getByRole("link", { name: "下载" })).toBeTruthy();
    expect(within(head).getByRole("button", { name: "更多操作" })).toBeTruthy();
    act(() => shell.onBack()?.());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("registers the upload as the shell's primary", () => {
    const shell = shellStub();
    renderAtClass(390, inShell(shell.register, <LibraryPage {...props()} />));
    const pages = shell.register.mock.calls.map((c) => c[1]).filter(Boolean) as ShellPage[];
    expect(pages.some((p) => p.primary?.label === "上传")).toBe(true);
  });
});
