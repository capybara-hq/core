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

  it("keeps one tab stop", () => {
    render(<Harness />);
    const stops = screen.getAllByRole("treeitem").filter((e) => e.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });
});

describe("FileBrowser", () => {
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
