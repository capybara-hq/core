import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, FileBrowser, FileTree } from "../src/index";

afterEach(cleanup);

const files = [
  { path: "SKILL.md", size: "1.2 KB" },
  { path: "scripts/helper.js", size: "300 B" },
  { path: "scripts/run.sh", size: "80 B" },
  { path: "assets/logo.png", size: "12 KB" },
];

function Harness({ onSelect }: { onSelect?: (p: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <DesignProvider locale="en">
      <FileTree
        label="Files"
        files={files}
        selected={selected}
        onSelect={(p) => {
          setSelected(p);
          onSelect?.(p);
        }}
      />
    </DesignProvider>
  );
}

const names = () => screen.getAllByRole("treeitem").map((e) => e.getAttribute("data-path"));

describe("FileTree", () => {
  it("builds folders from paths, folders first, then files, alphabetical", () => {
    render(<Harness />);
    expect(screen.getByRole("tree", { name: "Files" })).toBeTruthy();
    expect(names()).toEqual([
      "assets",
      "assets/logo.png",
      "scripts",
      "scripts/helper.js",
      "scripts/run.sh",
      "SKILL.md",
    ]);
    expect(screen.getByRole("treeitem", { name: /assets/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("collapses and expands a folder on click", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("treeitem", { name: /scripts/ }));
    expect(names()).not.toContain("scripts/helper.js");
    expect(screen.getByRole("treeitem", { name: /scripts/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    await userEvent.click(screen.getByRole("treeitem", { name: /scripts/ }));
    expect(names()).toContain("scripts/helper.js");
  });

  it("marks the selected file and shows muted sizes", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("treeitem", { name: /helper\.js/ }));
    expect(onSelect).toHaveBeenCalledWith("scripts/helper.js");
    const row = screen.getByRole("treeitem", { name: /helper\.js/ });
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("treeitem", { name: /run\.sh/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(row.querySelector("[data-part='file-size']")?.textContent).toBe("300 B");
  });

  it("moves with arrows, expands and collapses, selects with Enter and Space", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    screen.getAllByRole("treeitem")[0]?.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBe("assets/logo.png");
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement?.getAttribute("data-path")).toBe("assets");
    await userEvent.keyboard("{ArrowLeft}");
    expect(names()).not.toContain("assets/logo.png");
    await userEvent.keyboard("{ArrowRight}");
    expect(names()).toContain("assets/logo.png");
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement?.getAttribute("data-path")).toBe("assets/logo.png");
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("assets/logo.png");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
    expect(document.activeElement?.getAttribute("data-path")).toBe("scripts");
    await userEvent.keyboard("{ArrowDown} ");
    expect(onSelect).toHaveBeenLastCalledWith("scripts/helper.js");
  });

  it("draws pinned paths first, before folders", () => {
    render(
      <DesignProvider locale="en">
        <FileTree
          label="Files"
          files={files}
          selected={null}
          onSelect={() => {}}
          pinned={["SKILL.md"]}
        />
      </DesignProvider>,
    );
    expect(names()[0]).toBe("SKILL.md");
    expect(names().slice(1, 3)).toEqual(["assets", "assets/logo.png"]);
  });

  it("builds deep and wide trees, each path once", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ path: `a/b/f${i}.txt` }));
    render(
      <DesignProvider locale="en">
        <FileTree label="Files" files={many} selected={null} onSelect={() => {}} />
      </DesignProvider>,
    );
    expect(names()).toHaveLength(302);
    expect(names().slice(0, 4)).toEqual(["a", "a/b", "a/b/f0.txt", "a/b/f1.txt"]);
  });

  it("keeps one tab stop", () => {
    render(<Harness />);
    const stops = screen.getAllByRole("treeitem").filter((e) => e.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });
});

describe("FileBrowser", () => {
  const browser = (open: boolean, selected: string | null) => (
    <DesignProvider locale="en">
      <FileBrowser
        label="Skill files"
        tree={
          <FileTree
            label="Files"
            files={files}
            selected={selected ?? "SKILL.md"}
            onSelect={() => {}}
          />
        }
        open={open}
        onBack={() => {}}
        selected={selected}
      >
        <p>preview of {selected}</p>
      </FileBrowser>
    </DesignProvider>
  );

  it("brings the preview into view when it opens or the file changes, and the tree row on back", () => {
    const calls: { el: Element; opts: unknown }[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
      calls.push({ el: this, opts });
    };
    try {
      const { rerender } = render(browser(false, null));
      expect(calls).toHaveLength(0);
      rerender(browser(true, "scripts/run.sh"));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.el.getAttribute("data-part")).toBe("file-preview-pane");
      expect(calls[0]?.opts).toMatchObject({ block: "nearest" });
      rerender(browser(true, "scripts/helper.js"));
      expect(calls).toHaveLength(2);
      expect(calls[1]?.el.getAttribute("data-part")).toBe("file-preview-pane");
      rerender(browser(false, null));
      expect(calls).toHaveLength(3);
      expect(calls[2]?.el.getAttribute("data-path")).toBe("SKILL.md");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("scrolls without motion when reduced motion is asked for", () => {
    const opts: unknown[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = (o?: unknown) => {
      opts.push(o);
    };
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    try {
      const { rerender } = render(browser(false, null));
      rerender(browser(true, "scripts/run.sh"));
      expect(opts).toEqual([{ block: "nearest", behavior: "auto" }]);
    } finally {
      Element.prototype.scrollIntoView = original;
      vi.unstubAllGlobals();
    }
  });

  it("shows the tree and the preview; a selected file opens the preview with a back control", async () => {
    const onBack = vi.fn();
    const { rerender } = render(
      <DesignProvider locale="en">
        <FileBrowser label="Skill files" tree={<p>tree</p>} open={false} onBack={onBack}>
          <p>preview</p>
        </FileBrowser>
      </DesignProvider>,
    );
    const region = screen.getByRole("region", { name: "Skill files" });
    expect(region.getAttribute("data-open")).toBe("false");
    rerender(
      <DesignProvider locale="en">
        <FileBrowser label="Skill files" tree={<p>tree</p>} open onBack={onBack}>
          <p>preview</p>
        </FileBrowser>
      </DesignProvider>,
    );
    expect(region.getAttribute("data-open")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
    expect(screen.getByText("preview")).toBeTruthy();
    expect(screen.getByText("tree")).toBeTruthy();
  });
});
