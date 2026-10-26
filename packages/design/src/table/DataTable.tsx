import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "../controls/button";
import { DensityContext } from "../controls/density";
import { Checkbox } from "../controls/toggles";
import { Pagination } from "../display/pagination";
import { Icon } from "../icons/icon";
import { Menu } from "../overlays/menus";
import { useDesignT } from "../provider";
import { EmptyArea } from "./empty";
import type { DataTableProps } from "./types";

function titleOf(node: ReactNode): string | undefined {
  return typeof node === "string" || typeof node === "number" ? String(node) : undefined;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  label,
  state = "ready",
  error,
  empty,
  noResults,
  toolbar,
  selection,
  bulkActions,
  activeKey,
  onOpen,
  rowMenu,
  expand,
  isDisabled,
  rowLabel,
  sort,
  pagination,
  rowHeight = "default",
  framed = true,
}: DataTableProps<T>) {
  const t = useDesignT();
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [focusKey, setFocusKey] = useState<string | undefined>();

  const selected = selection?.selected ?? new Set<string>();
  const selectable = rows.filter((r) => !isDisabled?.(r)).map(rowKey);
  const selectedCount = selectable.filter((k) => selected.has(k)).length;
  const allState: boolean | "indeterminate" =
    selectedCount === 0 ? false : selectedCount === selectable.length ? true : "indeterminate";

  const toggle = (key: string) => {
    if (!selection) return;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selection.onChange(next);
  };
  const toggleAll = () => {
    if (!selection) return;
    const next = new Set(selected);
    if (allState === true) for (const k of selectable) next.delete(k);
    else for (const k of selectable) next.add(k);
    selection.onChange(next);
  };

  const kind =
    state === "loading"
      ? "loading"
      : state === "error"
        ? "error"
        : rows.length === 0
          ? noResults
            ? "no-results"
            : "empty"
          : null;

  const tabKey =
    focusKey && rows.some((r) => rowKey(r) === focusKey) ? focusKey : rows[0] && rowKey(rows[0]);

  const focusRow = (key: string) => {
    setFocusKey(key);
    const el = bodyRef.current?.querySelector<HTMLElement>(`tr[data-row-key="${CSS.escape(key)}"]`);
    el?.focus();
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T, idx: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = rows[idx + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        e.preventDefault();
        focusRow(rowKey(next));
      }
    } else if (e.key === " ") {
      e.preventDefault();
      if (selection && !isDisabled?.(row)) toggle(rowKey(row));
    } else if (e.key === "Enter") {
      e.preventDefault();
      onOpen?.(row);
    }
  };

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, row: T) => {
    const el = e.target as Node;
    if (!e.currentTarget.contains(el)) return;
    if ((el as HTMLElement).closest?.("[data-no-open]")) return;
    onOpen?.(row);
  };

  const clearSelection = () => selection?.onChange(new Set());
  const hasSelection = selected.size > 0;
  const clearRef = useRef(clearSelection);
  clearRef.current = clearSelection;
  useEffect(() => {
    if (!hasSelection) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) clearRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hasSelection]);

  const bulk = selection && selected.size > 0;
  const colCount = columns.length + (selection ? 1 : 0) + (rowMenu ? 1 : 0);

  const head = (
    <thead>
      <tr>
        {selection ? (
          <th className="cb-table-check" scope="col" data-part="header-cell">
            <Checkbox
              checked={allState}
              onChange={toggleAll}
              aria-label={t("table.selectAll")}
              disabled={selectable.length === 0}
            />
          </th>
        ) : null}
        {columns.map((c) => {
          const current = sort?.key === c.key ? sort : undefined;
          const sortable = c.sortable && sort;
          return (
            <th
              key={c.key}
              scope="col"
              data-part="header-cell"
              data-align={c.align === "right" ? "right" : undefined}
              data-sorted={current ? "true" : undefined}
              aria-sort={current ? (current.dir === "asc" ? "ascending" : "descending") : undefined}
              style={c.width ? { width: c.width } : undefined}
            >
              {sortable ? (
                <button
                  type="button"
                  className="cb-table-sort"
                  onClick={() => sort.onChange(c.key, current?.dir === "asc" ? "desc" : "asc")}
                >
                  {c.header}
                  <span className="cb-table-arrow" aria-hidden="true">
                    <Icon
                      name={
                        current
                          ? current.dir === "asc"
                            ? "arrow-up"
                            : "arrow-down"
                          : "arrow-up-down"
                      }
                      size={12}
                    />
                  </span>
                </button>
              ) : (
                c.header
              )}
            </th>
          );
        })}
        {rowMenu ? <th className="cb-table-menu" scope="col" data-part="header-cell" /> : null}
      </tr>
    </thead>
  );

  return (
    <DensityContext value="dense">
      <div
        className="cb-table"
        data-row-height={rowHeight}
        data-framed={framed ? "true" : "false"}
        data-error={kind === "error" ? "true" : undefined}
      >
        {bulk ? (
          <div className="cb-table-bulk">
            <strong>{t("table.selected").replace("{n}", String(selected.size))}</strong>
            {bulkActions?.(selected)}
            <span className="cb-table-bulk-spacer" />
            <Button variant="ghost" shortcut="Esc" onClick={clearSelection}>
              {t("table.clearSelection")}
            </Button>
          </div>
        ) : toolbar ? (
          <div className="cb-table-toolbar">{toolbar}</div>
        ) : null}
        <div
          className="cb-table-panel"
          data-part="table"
          aria-busy={kind === "loading" || undefined}
        >
          {kind ? (
            <>
              {kind === "loading" || kind === "empty" ? (
                // The header only, drawn above the skeleton / empty state (spec §6.6); hidden from
                // assistive tech, the state below carries the meaning.
                <table className="cb-table-el" aria-hidden="true">
                  {head}
                </table>
              ) : null}
              <EmptyArea<T> kind={kind} error={error} empty={empty} noResults={noResults} />
            </>
          ) : (
            <div className="cb-table-scroll">
              <table
                className="cb-table-el"
                aria-label={label}
                data-select={selection ? "true" : undefined}
              >
                {head}

                <tbody ref={bodyRef}>
                  {rows.map((row, idx) => {
                    const key = rowKey(row);
                    const disabled = !!isDisabled?.(row);
                    const states = [
                      key === activeKey ? "active" : "",
                      selected.has(key) ? "checked" : "",
                      disabled ? "disabled" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const first = columns[0]?.cell(row);
                    const rowName = rowLabel?.(row) ?? (typeof first === "string" ? first : key);
                    const extra = expand?.(row);
                    const menuItems = rowMenu?.(row);
                    // 行内控件随行做 roving tabindex：只有 Tab 停靠行的复选框 / ⋯ 在 Tab 顺序里
                    const inTabRow = key === tabKey ? 0 : -1;
                    return (
                      <Fragment key={key}>
                        <tr
                          className="cb-table-row"
                          data-part="row"
                          data-row-key={key}
                          data-state={states || undefined}
                          aria-current={key === activeKey ? "true" : undefined}
                          tabIndex={key === tabKey ? 0 : -1}
                          // 焦点进入行内任意控件（如点击复选框）也让该行成为 Tab 停靠行
                          onFocus={() => setFocusKey(key)}
                          onKeyDown={(e) => onRowKey(e, row, idx)}
                          onClick={(e) => onRowClick(e, row)}
                        >
                          {selection ? (
                            <td className="cb-table-check" data-part="cell" data-no-open="true">
                              <Checkbox
                                checked={selected.has(key)}
                                onChange={() => toggle(key)}
                                disabled={disabled}
                                tabIndex={inTabRow}
                                aria-label={t("table.selectRow").replace("{name}", rowName)}
                              />
                            </td>
                          ) : null}
                          {columns.map((c) => {
                            const content = c.cell(row);
                            return (
                              <td
                                key={c.key}
                                data-part="cell"
                                data-align={c.align === "right" ? "right" : undefined}
                                data-tone={c.tone}
                              >
                                <span className="cb-table-cell" title={titleOf(content)}>
                                  {content}
                                </span>
                              </td>
                            );
                          })}
                          {menuItems === undefined ? null : menuItems.length === 0 ? (
                            // 这一行没有可用的操作：保留单元格对齐列，不显示 ⋯
                            <td className="cb-table-menu" data-no-open="true" />
                          ) : (
                            <td className="cb-table-menu" data-no-open="true">
                              <Menu
                                items={menuItems}
                                trigger={
                                  <IconButton
                                    label={t("table.rowActions")}
                                    icon={<Icon name="more-horizontal" size={14} />}
                                    tabIndex={inTabRow}
                                  />
                                }
                              />
                            </td>
                          )}
                        </tr>
                        {extra ? (
                          <tr className="cb-table-expand">
                            <td colSpan={colCount}>
                              {/* 每个直接子元素是一行，CSS 在行首加 └ 引导 */}
                              <div className="cb-table-expand-body">
                                {typeof extra === "string" || typeof extra === "number" ? (
                                  <div>{extra}</div>
                                ) : (
                                  extra
                                )}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {pagination ? <Pagination {...pagination} /> : null}
      </div>
    </DensityContext>
  );
}
