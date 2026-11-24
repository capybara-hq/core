import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { Icon } from "../icons/icon";
import { ListDetail } from "../layout/list-detail";

export type FileTreeFile = { path: string; size?: string };

export type FileTreeProps = {
  /** The tree's accessible name. */
  label: string;
  files: FileTreeFile[];
  /** The selected file's path; `null` = none. */
  selected: string | null;
  onSelect(path: string): void;
};

type Node = {
  path: string;
  name: string;
  depth: number;
  folder: boolean;
  size?: string | undefined;
  children: Node[];
};

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Builds the tree of folders from paths: folders first, then files, each alphabetical. */
function buildTree(files: FileTreeFile[]): Node[] {
  const root: Node = { path: "", name: "", depth: -1, folder: true, children: [] };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let at = root;
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const last = i === parts.length - 1;
      let next = at.children.find((c) => c.path === path);
      if (!next) {
        next = { path, name, depth: i, folder: !last, children: [] };
        at.children.push(next);
      }
      if (last) next.size = f.size;
      at = next;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) =>
      a.folder !== b.folder ? (a.folder ? -1 : 1) : collator.compare(a.name, b.name),
    );
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function flatten(nodes: Node[], collapsed: ReadonlySet<string>, out: Node[] = []): Node[] {
  for (const n of nodes) {
    out.push(n);
    if (n.folder && !collapsed.has(n.path)) flatten(n.children, collapsed, out);
  }
  return out;
}

const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));

/**
 * A tree of file paths (spec §6.68): folders built from the paths, open by default and collapsible,
 * a file icon and the muted size at the row end, the selected file highlighted. A WAI-ARIA tree
 * with one tab stop: ArrowUp / ArrowDown move, ArrowRight opens a folder or steps into it,
 * ArrowLeft closes it or steps to the parent, Enter / Space select a file (or toggle a folder).
 */
export function FileTree({ label, files, selected, onSelect }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const rows = flatten(tree, collapsed);
  const stop =
    rows.find((r) => r.path === active) ?? rows.find((r) => r.path === selected) ?? rows[0];

  const toggle = (path: string, open: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(path);
      else next.add(path);
      return next;
    });
  const focus = (path: string) => {
    setActive(path);
    for (const el of host.current?.querySelectorAll<HTMLElement>("[role='treeitem']") ?? []) {
      if (el.dataset.path === path) el.focus();
    }
  };
  const activate = (n: Node) => {
    setActive(n.path);
    if (n.folder) toggle(n.path, collapsed.has(n.path));
    else onSelect(n.path);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, n: Node) => {
    const i = rows.indexOf(n);
    const go = (to: Node | undefined) => {
      e.preventDefault();
      if (to) focus(to.path);
    };
    switch (e.key) {
      case "ArrowDown":
        return go(rows[i + 1]);
      case "ArrowUp":
        return go(rows[i - 1]);
      case "Home":
        return go(rows[0]);
      case "End":
        return go(rows[rows.length - 1]);
      case "ArrowRight":
        if (!n.folder) return;
        if (collapsed.has(n.path)) {
          e.preventDefault();
          toggle(n.path, true);
          return;
        }
        return go(n.children[0]);
      case "ArrowLeft":
        if (n.folder && !collapsed.has(n.path)) {
          e.preventDefault();
          toggle(n.path, false);
          return;
        }
        return go(n.depth > 0 ? rows.find((r) => r.path === parentOf(n.path)) : undefined);
      case "Enter":
      case " ":
        e.preventDefault();
        return activate(n);
    }
  };

  return (
    <div ref={host} className="cb-filetree" data-part="file-tree" role="tree" aria-label={label}>
      {rows.map((n) => {
        const open = n.folder && !collapsed.has(n.path);
        const isSelected = !n.folder && n.path === selected;
        return (
          <div
            key={n.path}
            role="treeitem"
            className="cb-filetree-row"
            data-part={n.folder ? "folder-row" : "file-row"}
            data-path={n.path}
            aria-level={n.depth + 1}
            aria-expanded={n.folder ? open : undefined}
            aria-selected={n.folder ? undefined : isSelected}
            aria-current={isSelected ? "true" : undefined}
            tabIndex={n === stop ? 0 : -1}
            style={{
              paddingInlineStart: `calc(var(--cb-space-3) + ${n.depth} * var(--cb-space-4))`,
            }}
            onClick={() => activate(n)}
            onFocus={() => setActive(n.path)}
            onKeyDown={(e) => onKeyDown(e, n)}
          >
            <span className="cb-filetree-icon" aria-hidden="true">
              {n.folder ? (
                <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
              ) : (
                <Icon name="file" size={14} />
              )}
            </span>
            <span className="cb-filetree-name" data-part="file-name" title={n.name}>
              {n.name}
            </span>
            {n.size ? (
              <span className="cb-filetree-size" data-part="file-size">
                {n.size}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export type FileBrowserProps = {
  /** The region's accessible name. */
  label: string;
  /** The tree column, normally a `FileTree`. */
  tree: ReactNode;
  /** The selected file's preview. */
  children: ReactNode;
} & (
  | { open?: undefined; onBack?: undefined }
  | {
      /** A file is selected: the compact form shows the preview in place of the tree. */
      open: boolean;
      /** The compact form's back control (returns to the tree): required with `open`. */
      onBack(): void;
    }
);

/**
 * The two-pane layout of a file browser (spec §6.68): the tree column beside the preview when the
 * region is 580 wide or more, else the tree alone, with the preview pushed in its place and a back
 * control once a file is selected (a `ListDetail`, spec §6.47).
 */
export function FileBrowser({ label, tree, children, open = false, onBack }: FileBrowserProps) {
  return (
    <ListDetail
      list={tree}
      detail={open ? children : null}
      preview={children}
      onBack={() => onBack?.()}
      listMin={240}
      detailMin={340}
      label={label}
    />
  );
}
