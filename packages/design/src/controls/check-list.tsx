import type { ReactNode } from "react";
import { useDesignT } from "../provider";
import { Checkbox } from "./toggles";

/** One choice of a {@link CheckList}. */
export type CheckListRow = {
  id: string;
  /** The name, on the first line (`ink`, one line with an ellipsis). */
  title: string;
  /** Short marks after the name on its line (`Badge`s): they never shrink or wrap. */
  marks?: ReactNode;
  /** One `small` `muted` prose line under the name, cut at one line; its full text is the hover. */
  description?: string;
  checked: boolean;
  /**
   * The row cannot be changed (a built-in skill every agent has): its checkbox is off, and it
   * counts in neither the select-all state nor the `n/m` count.
   */
  locked?: boolean;
};

export type CheckListProps = {
  /** The list's accessible name. */
  label: string;
  rows: CheckListRow[];
  onCheck(id: string, next: boolean): void;
  /**
   * Draws the head row's checkbox: select all, called with the ids of the rows given that are not
   * locked (a page that filters passes only the rows it shows).
   */
  onCheckAll?: (ids: string[], next: boolean) => void;
  /**
   * The group's name in the head row (a plugin, 本组织): the select-all checkbox's text with
   * `onCheckAll`, else a plain heading. Without it the select-all checkbox reads 「全选」.
   */
  title?: string;
  disabled?: boolean;
  /** `card` (default) inside a padded box; `flush` alone in a flush card. */
  inset?: "card" | "flush";
};

/**
 * A multi-select of named things with a line of description each (spec §6.39): the agent page's
 * 组织技能. One row per choice, split by `line-soft` hairlines inside the one box (§1): the
 * checkbox and the name with its marks on the first line, the description as one cut muted line
 * under it (the full text on hover). A head row (`title` and / or `onCheckAll`) names the group
 * and selects all of it, mixed while some are checked, with the `n/m` count; locked rows are
 * neither selected nor counted.
 */
export function CheckList({
  label,
  rows,
  onCheck,
  onCheckAll,
  title,
  disabled = false,
  inset = "card",
}: CheckListProps) {
  const t = useDesignT();
  const open = rows.filter((r) => r.locked !== true);
  const on = open.filter((r) => r.checked).length;
  const allState = on === 0 ? false : on === open.length ? true : "indeterminate";
  const selectAll = onCheckAll !== undefined && open.length > 0;
  return (
    <div
      className="cb-check-list"
      data-part="check-list"
      data-inset={inset === "flush" ? "flush" : undefined}
    >
      {selectAll || title !== undefined ? (
        <div className="cb-check-list-all" data-part="check-list-all">
          {selectAll ? (
            <Checkbox
              checked={allState}
              disabled={disabled}
              label={
                <span className="cb-check-list-group" data-part="check-list-group">
                  {title ?? t("checkList.selectAll")}
                </span>
              }
              {...(title !== undefined
                ? { "aria-label": t("checkList.selectAllOf").replace("{group}", title) }
                : {})}
              onChange={(next) =>
                onCheckAll(
                  open.map((r) => r.id),
                  next,
                )
              }
            />
          ) : (
            <span className="cb-check-list-group" data-part="check-list-group">
              {title}
            </span>
          )}
          <span className="cb-check-list-count" data-part="check-list-count">
            {selectAll ? `${on}/${open.length}` : rows.length}
          </span>
        </div>
      ) : null}
      <ul className="cb-check-list-rows" aria-label={label}>
        {rows.map((r) => (
          <li
            key={r.id}
            className="cb-check-list-row"
            data-part="check-list-row"
            data-state={r.checked ? "checked" : "unchecked"}
            data-locked={r.locked === true ? "true" : undefined}
          >
            <span className="cb-check-list-line" data-part="check-list-line">
              <Checkbox
                checked={r.checked}
                disabled={disabled || r.locked === true}
                label={
                  <span
                    className="cb-check-list-title"
                    data-part="check-list-title"
                    title={r.title}
                  >
                    {r.title}
                  </span>
                }
                onChange={(next) => onCheck(r.id, next)}
              />
              {r.marks ? (
                <span className="cb-check-list-marks" data-part="check-list-marks">
                  {r.marks}
                </span>
              ) : null}
            </span>
            {r.description ? (
              <span
                className="cb-check-list-description"
                data-part="check-list-description"
                title={r.description}
              >
                {r.description}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
