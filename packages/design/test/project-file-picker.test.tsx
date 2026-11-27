import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesignProvider,
  type ProjectFileEntry,
  ProjectFilePicker,
  type ProjectFilePickerProps,
} from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";
import { matchMediaFor } from "./width";

// The project file picker (spec §6.16.31): one directory at a time, a path row, a filter, a
// multi-select the caller keeps across folders; a 640 dialog from 600 up, a bottom sheet below.

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const wrap = (ui: ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const ROOT: ProjectFileEntry[] = [
  { name: "src", path: "src", kind: "dir" },
  { name: "docs", path: "docs", kind: "dir" },
  { name: "README.md", path: "README.md", kind: "file", size: 2048 },
  { name: "package.json", path: "package.json", kind: "file", size: 512 },
];
const SRC: ProjectFileEntry[] = [
  { name: "app.ts", path: "src/app.ts", kind: "file", size: 4096 },
  { name: "util.ts", path: "src/util.ts", kind: "file", size: 100 },
];

type Overrides = Partial<ProjectFilePickerProps>;

/** A caller owning the path, the filter and the selection, listing from two fixed folders. */
type Spy = (...args: unknown[]) => void;
type Spied = "onOpenChange" | "onPathChange" | "onFilterChange" | "onSelectedChange" | "onConfirm";

function Harness({
  spy = {},
  ...over
}: Overrides & { spy?: Partial<Record<Spied, ReturnType<typeof vi.fn<Spy>>>> }) {
  const [path, setPath] = useState(over.path ?? "");
  const [filter, setFilter] = useState(over.filter ?? "");
  const [selected, setSelected] = useState<string[]>(over.selected ?? []);
  const listed = path === "src" ? SRC : ROOT;
  return (
    <ProjectFilePicker
      open
      onOpenChange={spy.onOpenChange ?? (() => {})}
      project="capybara"
      path={path}
      onPathChange={(p) => {
        spy.onPathChange?.(p);
        setPath(p);
      }}
      entries={over.entries ?? listed.filter((e) => e.name.includes(filter))}
      filter={filter}
      onFilterChange={(q) => {
        spy.onFilterChange?.(q);
        setFilter(q);
      }}
      selected={selected}
      onSelectedChange={(s) => {
        spy.onSelectedChange?.(s);
        setSelected(s);
      }}
      max={over.max ?? 10}
      onConfirm={spy.onConfirm ?? (() => {})}
      {...(over.truncated ? { truncated: true } : {})}
      {...(over.loading ? { loading: true } : {})}
      {...(over.error ? { error: over.error } : {})}
    />
  );
}

const option = (name: string | RegExp) => screen.getByRole("option", { name });
const listbox = () => screen.getByRole("listbox");
const confirm = () => screen.getByRole("button", { name: "引用" });

describe("ProjectFilePicker", () => {
  it("draws the root: the project as the path row, folders and files as options", () => {
    wrap(<Harness />);
    expect(screen.getByRole("dialog", { name: "引用项目文件" })).toBeTruthy();
    const path = screen.getByRole("navigation", { name: "位置" });
    expect(within(path).getByText("capybara").getAttribute("aria-current")).toBe("location");
    expect(listbox().getAttribute("aria-multiselectable")).toBe("true");
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual([
      "文件夹 src",
      "文件夹 docs",
      "README.md",
      "package.json",
    ]);
    expect(option("README.md").textContent).toContain("2 KB");
    expect(option("README.md").textContent).toContain("MD");
  });

  it("a folder row navigates into it; a path row segment goes back to the root", () => {
    const onPathChange = vi.fn();
    wrap(<Harness spy={{ onPathChange }} />);
    fireEvent.click(option("文件夹 src"));
    expect(onPathChange).toHaveBeenLastCalledWith("src");
    const path = screen.getByRole("navigation", { name: "位置" });
    expect(within(path).getByText("src").getAttribute("aria-current")).toBe("location");
    fireEvent.click(within(path).getByRole("button", { name: "capybara" }));
    expect(onPathChange).toHaveBeenLastCalledWith("");
  });

  it("builds a segment per folder of a deeper path", () => {
    const onPathChange = vi.fn();
    wrap(<Harness path="src/app/routes" entries={[]} spy={{ onPathChange }} />);
    const path = screen.getByRole("navigation", { name: "位置" });
    expect(
      within(path)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["capybara", "src", "app"]);
    fireEvent.click(within(path).getByRole("button", { name: "app" }));
    expect(onPathChange).toHaveBeenCalledWith("src/app");
  });

  it("a file row toggles its selection", () => {
    const onSelectedChange = vi.fn();
    wrap(<Harness spy={{ onSelectedChange }} />);
    fireEvent.click(option("README.md"));
    expect(onSelectedChange).toHaveBeenLastCalledWith(["README.md"]);
    expect(option("README.md").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(option("README.md"));
    expect(onSelectedChange).toHaveBeenLastCalledWith([]);
    expect(option("README.md").getAttribute("aria-selected")).toBe("false");
  });

  it("keeps the selection across folders (the caller owns it)", () => {
    wrap(<Harness />);
    fireEvent.click(option("README.md"));
    fireEvent.click(option("文件夹 src"));
    fireEvent.click(option("app.ts"));
    expect(screen.getByText("已选 2 个")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "capybara" }));
    expect(option("README.md").getAttribute("aria-selected")).toBe("true");
  });

  it("「引用」 is disabled with nothing chosen and confirms the chosen paths", () => {
    const onConfirm = vi.fn();
    wrap(<Harness spy={{ onConfirm }} />);
    expect((confirm() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("选择要引用的文件")).toBeTruthy();
    fireEvent.click(option("README.md"));
    fireEvent.click(option("package.json"));
    expect((confirm() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith(["README.md", "package.json"]);
  });

  it("Cancel closes it", () => {
    const onOpenChange = vi.fn();
    wrap(<Harness spy={{ onOpenChange }} />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("at max the other file rows are disabled, with the cap in the count", () => {
    const onSelectedChange = vi.fn();
    wrap(<Harness max={1} selected={["README.md"]} spy={{ onSelectedChange }} />);
    expect(option("package.json").getAttribute("aria-disabled")).toBe("true");
    expect(option("README.md").getAttribute("aria-disabled")).toBeNull();
    // folders stay open to navigate
    expect(option("文件夹 src").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(option("package.json"));
    expect(onSelectedChange).not.toHaveBeenCalled();
    expect(screen.getByText("已选 1 个，最多 1 个")).toBeTruthy();
  });

  it("the filter field calls onFilterChange; a navigation clears it", () => {
    const onFilterChange = vi.fn();
    wrap(<Harness spy={{ onFilterChange }} />);
    const field = screen.getByRole("searchbox", { name: "筛选此文件夹" });
    fireEvent.change(field, { target: { value: "sr" } });
    expect(onFilterChange).toHaveBeenLastCalledWith("sr");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(option("文件夹 src"));
    expect(onFilterChange).toHaveBeenLastCalledWith("");
  });

  it("a filter that matches nothing says so; an empty folder says it is empty", () => {
    wrap(<Harness filter="zzz" />);
    expect(screen.getByText("这里没有名称包含「zzz」的项")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    cleanup();
    wrap(<Harness entries={[]} />);
    expect(screen.getByText("这个文件夹是空的")).toBeTruthy();
  });

  it("truncated shows the hint to filter", () => {
    wrap(<Harness truncated />);
    expect(screen.getByText("未列出全部，用筛选缩小范围。")).toBeTruthy();
  });

  it("loading shows the loading row in place of the rows", () => {
    wrap(<Harness loading />);
    expect(screen.queryByRole("option")).toBeNull();
    // the listbox stays mounted (busy), so a focus inside it survives the listing
    expect(listbox().getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector('[data-part="project-file-loading"]')?.textContent).toContain(
      "正在加载",
    );
  });

  it("an error replaces the rows and turns the filter off", () => {
    wrap(<Harness error={<p>这台设备不支持列出文件。</p>} />);
    expect(screen.getByText("这台设备不支持列出文件。")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((screen.getByRole("searchbox") as HTMLInputElement).disabled).toBe(true);
  });

  it("keyboard: ↑↓ move the active row (wrapping, skipping disabled), Space / ↵ act on it", () => {
    const onSelectedChange = vi.fn();
    const onPathChange = vi.fn();
    wrap(<Harness max={1} selected={["package.json"]} spy={{ onSelectedChange, onPathChange }} />);
    const list = listbox();
    const active = () => list.getAttribute("aria-activedescendant");
    const idOf = (name: string) => option(name).id;
    expect(active()).toBe(idOf("文件夹 src"));
    fireEvent.keyDown(list, { key: "ArrowUp" });
    // README.md is disabled at the cap: the move wraps to package.json
    expect(active()).toBe(idOf("package.json"));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toBe(idOf("文件夹 src"));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toBe(idOf("文件夹 docs"));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toBe(idOf("package.json"));
    fireEvent.keyDown(list, { key: " " });
    expect(onSelectedChange).toHaveBeenLastCalledWith([]);
    fireEvent.keyDown(list, { key: "Home" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onPathChange).toHaveBeenLastCalledWith("src");
  });

  it("keyboard: opening a folder keeps the focus on the list, while loading too", () => {
    function Loading() {
      const [path, setPath] = useState("");
      const [loaded, setLoaded] = useState(true);
      return (
        <>
          <ProjectFilePicker
            open
            onOpenChange={() => {}}
            project="capybara"
            path={path}
            onPathChange={(p) => {
              setPath(p);
              setLoaded(false);
            }}
            entries={loaded ? (path === "src" ? SRC : ROOT) : []}
            loading={!loaded}
            filter=""
            onFilterChange={() => {}}
            selected={[]}
            onSelectedChange={() => {}}
            max={10}
            onConfirm={() => {}}
          />
          <button type="button" onClick={() => setLoaded(true)}>
            loaded
          </button>
        </>
      );
    }
    wrap(<Loading />);
    const list = listbox();
    list.focus();
    fireEvent.keyDown(list, { key: "Enter" });
    expect(screen.getByRole("navigation", { name: "位置" }).textContent).toContain("src");
    expect(listbox()).toBe(list);
    expect(list.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(list);
    fireEvent.click(screen.getByRole("button", { name: "loaded", hidden: true }));
    list.focus();
    expect(list.getAttribute("aria-activedescendant")).toBe(option("app.ts").id);
  });

  it("a path row segment that becomes the current one hands the focus to the list", () => {
    wrap(<Harness path="src" />);
    const root = screen.getByRole("button", { name: "capybara" });
    root.focus();
    fireEvent.click(root);
    expect(root.isConnected).toBe(false);
    expect(document.activeElement).toBe(listbox());
  });

  it("folder options carry no aria-selected (only files are chosen)", () => {
    wrap(<Harness />);
    expect(option("文件夹 src").hasAttribute("aria-selected")).toBe(false);
    expect(option("README.md").getAttribute("aria-selected")).toBe("false");
  });

  it("↓ in the filter moves into the rows", () => {
    wrap(<Harness />);
    const field = screen.getByRole("searchbox");
    field.focus();
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(document.activeElement).toBe(listbox());
  });

  it("reads in English", () => {
    wrap(<Harness />, "en");
    expect(screen.getByRole("dialog", { name: "Reference project files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reference" })).toBeTruthy();
    expect(option("Folder src")).toBeTruthy();
    expect(screen.getByText("Choose files to reference")).toBeTruthy();
  });

  it("draws no box inside the dialog", () => {
    wrap(<Harness truncated selected={["README.md"]} />);
    const dialog = screen.getByRole("dialog");
    expect(findNestedBoxes(dialog).map(describeNestedBox)).toEqual([]);
  });

  it("the reference forms draw in place with no nested box", () => {
    const props: ProjectFilePickerProps = {
      open: true,
      onOpenChange: () => {},
      project: "capybara",
      path: "",
      onPathChange: () => {},
      entries: ROOT,
      filter: "",
      onFilterChange: () => {},
      selected: [],
      onSelectedChange: () => {},
      max: 10,
      onConfirm: () => {},
    };
    for (const form of [{ referenceDialog: true }, { referenceSheet: {} }]) {
      const r = wrap(<ProjectFilePicker {...props} {...form} />);
      expect(r.container.querySelector('[data-part="project-file-picker"]')).toBeTruthy();
      expect(findNestedBoxes(r.container).map(describeNestedBox)).toEqual([]);
      cleanup();
    }
  });
});

describe("ProjectFilePicker (compact)", () => {
  it("is a bottom sheet holding the rows and the footer", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const onConfirm = vi.fn();
    wrap(<Harness spy={{ onConfirm }} />);
    const sheet = document.querySelector<HTMLElement>('[data-part="dialog-sheet"]');
    expect(sheet).toBeTruthy();
    expect(document.querySelector(".cb-dialog")).toBeNull();
    fireEvent.click(within(sheet as HTMLElement).getByRole("option", { name: "README.md" }));
    fireEvent.click(within(sheet as HTMLElement).getByRole("button", { name: "引用" }));
    expect(onConfirm).toHaveBeenCalledWith(["README.md"]);
    expect(findNestedBoxes(sheet as HTMLElement).map(describeNestedBox)).toEqual([]);
  });
});
