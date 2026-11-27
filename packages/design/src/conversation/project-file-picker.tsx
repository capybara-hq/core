import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "../controls/button";
import { Input } from "../controls/inputs";
import { formatBytes } from "../display/attachments";
import { EmptyState } from "../display/empty-state";
import { Icon } from "../icons/icon";
import { BoxScope } from "../layout/box";
import { BottomSheetFrame } from "../overlays/bottom-sheet";
import { Dialog } from "../overlays/dialog";
import { useDesignT } from "../provider";
import { TypeBadge, typeBadge } from "./files";
import { Spinner } from "./prose";

// The project file picker (spec §6.16.31; composer menus spec §5): a person references files of
// the device's project without uploading them. One directory at a time, a path row to go back up,
// a filter for the directory's names, a multi-select that the caller keeps across folders. It is a
// data-only component: the caller lists the directory (the kernel's listing route) and owns the
// path, the filter and the selection.

/** One entry of the listed directory. */
export type ProjectFileEntry = {
  name: string;
  /** Relative to the project root ("src/app.ts"). */
  path: string;
  kind: "file" | "dir";
  /** Bytes, for a file. */
  size?: number;
};

export type ProjectFilePickerProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The project's name: the path row's root. */
  project: string;
  /** The listed directory, relative to the project root ("" = the root). */
  path: string;
  /** Go to a directory (a folder row, a path row segment); the filter is cleared as it goes. */
  onPathChange(path: string): void;
  /** The directory's entries as the caller listed them (already filtered by `filter`). */
  entries: ProjectFileEntry[];
  /** The listing stopped at its cap: a hint to filter shows under the rows. */
  truncated?: boolean;
  /** The filter field's text (the caller lists the directory with it). */
  filter: string;
  onFilterChange(query: string): void;
  /** The listing is on its way: a loading row replaces the rows. */
  loading?: boolean;
  /** The listing failed (the caller's `ErrorDetail`): drawn in place of the rows. */
  error?: ReactNode;
  /** The chosen files' paths, kept by the caller across folders. */
  selected: string[];
  onSelectedChange(paths: string[]): void;
  /** At most this many files; past it the other file rows are disabled. */
  max: number;
  /** Reference: the chosen paths. The caller closes the picker. */
  onConfirm(paths: string[]): void;
  /**
   * The reference set and `/dev/ui` only: the centred dialog drawn in place, without a portal, a
   * scrim or a focus trap.
   */
  referenceDialog?: boolean;
  /** The reference set and `/dev/ui` only: the compact bottom sheet drawn in place over `page`. */
  referenceSheet?: { page?: ReactNode };
};

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text);

/** The path row's segments: the project, then each folder down to the listed one. */
function segments(project: string, path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter((p) => p !== "");
  return [
    { label: project, path: "" },
    ...parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join("/") })),
  ];
}

const noModifier = (e: KeyboardEvent<HTMLElement>) =>
  !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;

/** The picker's inside (both forms): the path row, the filter, the rows or their status. */
function PickerBody(p: ProjectFilePickerProps & { listRef: RefObject<HTMLDivElement | null> }) {
  const t = useDesignT();
  const listId = useId();
  const [chosen, setChosen] = useState<{ path: string; key: string } | null>(null);
  const atMax = p.selected.length >= p.max;
  const isDisabled = (e: ProjectFileEntry) =>
    e.kind === "file" && atMax && !p.selected.includes(e.path);
  const rows = p.loading || p.error ? [] : p.entries;
  const enabled = rows.filter((e) => !isDisabled(e));
  const activePath =
    chosen && chosen.path === p.path && enabled.some((e) => e.path === chosen.key)
      ? chosen.key
      : enabled[0]?.path;
  const domId = (i: number) => `${listId}-${i}`;
  const activeIndex = rows.findIndex((e) => e.path === activePath);

  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** A move to another directory started inside the picker: the focus stays in it. */
  const keepFocus = useRef(false);
  const go = (path: string) => {
    keepFocus.current = bodyRef.current?.contains(document.activeElement) === true;
    if (p.filter !== "") p.onFilterChange("");
    p.onPathChange(path);
  };
  // A new directory starts scrolled to its top. The listbox stays mounted, so a folder opened from
  // it keeps the focus; a path row segment that turned into the current one (and left the
  // document) hands the focus to the listbox.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each new path
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (!keepFocus.current) return;
    keepFocus.current = false;
    if (!bodyRef.current?.contains(document.activeElement)) p.listRef.current?.focus();
  }, [p.path]);
  const toggle = (e: ProjectFileEntry) => {
    if (p.selected.includes(e.path)) {
      p.onSelectedChange(p.selected.filter((s) => s !== e.path));
    } else if (!atMax) {
      p.onSelectedChange([...p.selected, e.path]);
    }
  };
  const activate = (e: ProjectFileEntry) => {
    if (isDisabled(e)) return;
    setChosen({ path: p.path, key: e.path });
    if (e.kind === "dir") go(e.path);
    else toggle(e);
  };
  const moveTo = (e: ProjectFileEntry | undefined) => {
    if (!e) return;
    setChosen({ path: p.path, key: e.path });
    // a key move keeps the new row in view
    const el = document.getElementById(domId(rows.indexOf(e)));
    if (typeof el?.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  };
  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!noModifier(e) || enabled.length === 0) return;
    const at = enabled.findIndex((r) => r.path === activePath);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      moveTo(enabled[(at + dir + enabled.length) % enabled.length]);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      moveTo(e.key === "Home" ? enabled[0] : enabled[enabled.length - 1]);
    } else if (e.key === "Enter" || e.key === " ") {
      const row = enabled[at];
      if (!row) return;
      e.preventDefault();
      activate(row);
    }
  };

  const crumbs = segments(p.project, p.path);
  const empty = !p.loading && !p.error && p.entries.length === 0;
  return (
    <div ref={bodyRef} className="cb-pfp" data-part="project-file-picker-body">
      <nav
        className="cb-pfp-path"
        data-part="project-file-path"
        aria-label={t("projectFiles.location")}
      >
        <ol className="cb-pfp-crumbs">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={c.path} className="cb-pfp-crumb">
                {i > 0 ? (
                  <span className="cb-pfp-sep" aria-hidden="true">
                    /
                  </span>
                ) : null}
                {last ? (
                  <span
                    className="cb-pfp-segment"
                    data-part="project-file-segment"
                    aria-current="location"
                    title={c.label}
                  >
                    {c.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="cb-pfp-segment"
                    data-part="project-file-segment"
                    title={c.label}
                    onClick={() => go(c.path)}
                  >
                    {c.label}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="cb-pfp-filter" data-part="project-file-filter">
        <Input
          type="search"
          prefix={<Icon name="search" size={14} />}
          aria-label={t("projectFiles.filter")}
          placeholder={t("projectFiles.filter")}
          value={p.filter}
          autoComplete="off"
          spellCheck={false}
          disabled={p.error !== undefined && p.error !== null}
          onChange={(e) => p.onFilterChange(e.target.value)}
          onKeyDown={(e) => {
            // ↓ from the filter goes on into the rows
            if (e.key === "ArrowDown" && noModifier(e) && rows.length > 0) {
              e.preventDefault();
              p.listRef.current?.focus();
            }
          }}
        />
      </div>
      {p.error ? (
        <div className="cb-pfp-error" data-part="project-file-error">
          {p.error}
        </div>
      ) : (
        <div ref={scrollRef} className="cb-pfp-scroll" data-part="project-file-scroll">
          {/* always mounted (empty while loading), so the focus survives a folder change */}
          <div
            ref={p.listRef}
            id={listId}
            role="listbox"
            aria-multiselectable="true"
            aria-label={crumbs[crumbs.length - 1]?.label ?? p.project}
            tabIndex={0}
            className="cb-pfp-list"
            data-part="project-file-list"
            {...(p.loading ? { "aria-busy": true } : {})}
            {...(activeIndex >= 0 ? { "aria-activedescendant": domId(activeIndex) } : {})}
            onKeyDown={onListKeyDown}
          >
            {rows.map((e, i) => {
              const disabled = isDisabled(e);
              const checked = e.kind === "file" && p.selected.includes(e.path);
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: an option of the listbox, which keeps the focus (aria-activedescendant)
                // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys
                <div
                  key={e.path}
                  id={domId(i)}
                  role="option"
                  className="cb-pfp-row"
                  data-part="project-file-row"
                  data-kind={e.kind}
                  {...(e.kind === "file" ? { "aria-selected": checked } : {})}
                  aria-label={
                    e.kind === "dir" ? fill(t("projectFiles.folder"), { name: e.name }) : e.name
                  }
                  {...(disabled ? { "aria-disabled": true, "data-disabled": "true" } : {})}
                  {...(e.path === activePath ? { "data-active": "true" } : {})}
                  onClick={() => activate(e)}
                >
                  {e.kind === "file" ? (
                    <span
                      className="cb-check cb-pfp-check"
                      data-part="project-file-check"
                      data-state={checked ? "checked" : "unchecked"}
                      aria-hidden="true"
                    >
                      <span className="cb-box">
                        {checked ? <Icon name="check" size={12} /> : null}
                      </span>
                    </span>
                  ) : (
                    <span className="cb-pfp-check" aria-hidden="true" />
                  )}
                  <span className="cb-pfp-lead" data-part="project-file-lead" aria-hidden="true">
                    {e.kind === "dir" ? (
                      <Icon name="folder" size={16} />
                    ) : (
                      <TypeBadge label={typeBadge(e.name, "")} />
                    )}
                  </span>
                  <span className="cb-pfp-name" data-part="project-file-name" title={e.name}>
                    {e.name}
                  </span>
                  {e.kind === "dir" ? (
                    <span className="cb-pfp-trail" aria-hidden="true">
                      <Icon name="chevron-right" size={12} />
                    </span>
                  ) : e.size !== undefined ? (
                    <span className="cb-pfp-size" data-part="project-file-size">
                      {formatBytes(e.size)}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          {empty ? (
            <EmptyState
              size="panel"
              text={
                p.filter !== ""
                  ? fill(t("projectFiles.noMatch"), { q: p.filter })
                  : t("projectFiles.empty")
              }
            />
          ) : null}
          {/* always mounted, so the loading row and the hint are announced */}
          <div role="status" className="cb-pfp-status">
            {p.loading ? (
              <div className="cb-pfp-loading" data-part="project-file-loading">
                <Spinner label={t("projectFiles.loading")} />
                <span>{t("projectFiles.loading")}</span>
              </div>
            ) : p.truncated && !p.error ? (
              <div className="cb-pfp-truncated" data-part="project-file-truncated">
                {t("projectFiles.truncated")}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** The footer: the count (and the cap once reached), Cancel and Reference. */
function PickerFooter(p: ProjectFilePickerProps) {
  const t = useDesignT();
  const n = p.selected.length;
  const count =
    n === 0
      ? t("projectFiles.countNone")
      : n >= p.max
        ? fill(t("projectFiles.countMax"), { n, max: p.max })
        : fill(t("projectFiles.count"), { n });
  return (
    <div className="cb-pfp-foot" data-part="project-file-foot">
      <span
        className="cb-pfp-count"
        data-part="project-file-count"
        role="status"
        data-max={n >= p.max ? "true" : undefined}
      >
        {count}
      </span>
      <span className="cb-pfp-grow" />
      <Button variant="ghost" onClick={() => p.onOpenChange(false)}>
        {t("overlay.cancel")}
      </Button>
      <Button variant="primary" disabled={n === 0} onClick={() => p.onConfirm(p.selected)}>
        {t("projectFiles.confirm")}
      </Button>
    </div>
  );
}

/**
 * The project file picker (spec §6.16.31): a 640 dialog from 600 up, a bottom sheet below 600
 * (the Dialog's compact form, one history entry). Folders navigate, files toggle; the selection,
 * the path and the filter belong to the caller, so a choice survives moving between folders.
 */
export function ProjectFilePicker(props: ProjectFilePickerProps): JSX.Element | null {
  const t = useDesignT();
  const listRef = useRef<HTMLDivElement>(null);
  const title = t("projectFiles.title");
  const body = <PickerBody {...props} listRef={listRef} />;
  const footer = <PickerFooter {...props} />;
  if (props.referenceSheet) {
    return (
      <BottomSheetFrame
        title={title}
        state="idle"
        share={0}
        page={props.referenceSheet.page}
        footer={<div className="cb-dialog-sheet-foot">{footer}</div>}
      >
        <div className="cb-dialog-sheet" data-part="project-file-picker" data-form="sheet">
          <BoxScope kind="dialog">{body}</BoxScope>
        </div>
      </BottomSheetFrame>
    );
  }
  if (props.referenceDialog) {
    if (!props.open) return null;
    return (
      <div
        className="cb-dialog cb-pfp-dialog"
        data-part="project-file-picker"
        data-size={640}
        data-inline="true"
        role="dialog"
        aria-label={title}
      >
        <div className="cb-dialog-head">
          <h2 className="cb-dialog-title">{title}</h2>
          <IconButton
            label={t("overlay.close")}
            icon={<Icon name="x" size={14} />}
            density="dense"
          />
        </div>
        <BoxScope kind="dialog">
          <div className="cb-dialog-body">{body}</div>
          <div className="cb-dialog-foot">{footer}</div>
        </BoxScope>
      </div>
    );
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={title}
      size={640}
      footer={footer}
    >
      {body}
    </Dialog>
  );
}
