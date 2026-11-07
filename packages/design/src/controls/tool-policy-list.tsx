import { useId, useState } from "react";
import { EmptyState } from "../display/empty-state";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { Input } from "./inputs";
import { Select, type SelectOption } from "./select";
import { Checkbox } from "./toggles";

/** One tool of a {@link ToolPolicyList}. */
export type ToolPolicyRow = {
  id: string;
  /** The tool's display title. */
  label: string;
  /** Hover text on the title (a human description, when there is one). */
  tooltip?: string;
  /** One line under the title: why the tool cannot be used now (`warn`), a muted remark. */
  note?: { text: string; tone?: "muted" | "warn" };
  checked: boolean;
  /** The policy select's value; the caller passes its "default" value for an unchecked tool. */
  policy: string;
};

export type ToolPolicyListProps = {
  /** The list's accessible name. */
  label: string;
  rows: ToolPolicyRow[];
  /** The policy select's options (Default / Ask / Deny). */
  policyOptions: SelectOption[];
  onCheck(id: string, next: boolean): void;
  onPolicy(id: string, value: string): void;
  /** Draws the select-all row; called with the rows the filter shows. */
  onCheckAll?: (ids: string[], next: boolean) => void;
  /** Draws the filter field above the rows (a group with many tools). */
  search?: boolean;
  disabled?: boolean;
  /** `card` (default) inside a padded box (a Sheet, a form card); `flush` alone in a flush card. */
  inset?: "card" | "flush";
};

/**
 * Tools with their policy (spec §6.36): one row per tool, the checkbox and its title on the left
 * and a dense policy select on the right, disabled while the tool is unchecked. Rows are split
 * by `line-soft` hairlines inside the one box (§1). `onCheckAll` adds the select-all row with the
 * checked count; `search` the filter field, which narrows the rows by title.
 */
export function ToolPolicyList({
  label,
  rows,
  policyOptions,
  onCheck,
  onPolicy,
  onCheckAll,
  search = false,
  disabled = false,
  inset = "card",
}: ToolPolicyListProps) {
  const t = useDesignT();
  const id = useId();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = q === "" ? rows : rows.filter((r) => r.label.toLowerCase().includes(q));
  const on = visible.filter((r) => r.checked).length;
  const allState = on === 0 ? false : on === visible.length ? true : "indeterminate";
  return (
    <div
      className="cb-tool-policy"
      data-part="tool-policy-list"
      data-inset={inset === "flush" ? "flush" : undefined}
    >
      {search ? (
        <div className="cb-tool-policy-search" data-part="tool-policy-search">
          <Input
            type="search"
            density="dense"
            prefix={<Icon name="search" size={14} />}
            placeholder={t("toolPolicy.search")}
            aria-label={t("toolPolicy.search")}
            aria-controls={id}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      {onCheckAll && visible.length > 0 ? (
        <div className="cb-tool-policy-all" data-part="tool-policy-all">
          <Checkbox
            checked={allState}
            disabled={disabled}
            label={t("toolPolicy.selectAll")}
            onChange={(next) =>
              onCheckAll(
                visible.map((r) => r.id),
                next,
              )
            }
          />
          <span className="cb-tool-policy-count" data-part="tool-policy-count">
            {on}/{visible.length}
          </span>
        </div>
      ) : null}
      {visible.length === 0 && rows.length > 0 ? (
        // A search that matched nothing: the panel empty state, as the sidebar's (spec §6.18)
        <div className="cb-tool-policy-empty" data-part="tool-policy-empty">
          <EmptyState size="panel" text={t("toolPolicy.noMatch")} />
        </div>
      ) : null}
      <ul id={id} className="cb-tool-policy-rows" aria-label={label}>
        {visible.map((r) => (
          <li
            key={r.id}
            className="cb-tool-policy-row"
            data-part="tool-policy-row"
            data-state={r.checked ? "checked" : "unchecked"}
          >
            <span className="cb-tool-policy-text">
              <Checkbox
                checked={r.checked}
                disabled={disabled}
                label={
                  <span
                    className="cb-tool-policy-title"
                    data-part="tool-policy-title"
                    title={r.tooltip}
                  >
                    {r.label}
                  </span>
                }
                onChange={(next) => onCheck(r.id, next)}
              />
              {r.note ? (
                <span
                  className="cb-tool-policy-note"
                  data-part="tool-policy-note"
                  data-tone={r.note.tone ?? "muted"}
                >
                  {r.note.tone === "warn" ? <Icon name="circle-alert" size={12} /> : null}
                  {r.note.text}
                </span>
              ) : null}
            </span>
            <span className="cb-tool-policy-select" data-part="tool-policy-select">
              <Select
                density="dense"
                options={policyOptions}
                value={r.policy}
                disabled={disabled || !r.checked}
                aria-label={t("toolPolicy.policyOf").replace("{tool}", r.label)}
                onChange={(e) => onPolicy(r.id, e.target.value)}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
