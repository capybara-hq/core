import { useId, useState } from "react";
import { EmptyState } from "../display/empty-state";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { Input } from "./inputs";
import { Select, type SelectOption } from "./select";
import { Checkbox, Switch } from "./toggles";

/** One tool of a {@link ToolPolicyList}. */
export type ToolPolicyRow = {
  id: string;
  /** The tool's display title (its declared title, else its bare name; never a model-facing key). */
  label: string;
  /** Hover text on the title: the full key and the description, for whoever needs them. */
  tooltip?: string;
  /**
   * One line under the title: why the tool cannot be used now (`warn`), a muted remark; `action`
   * adds a text button after it that leads to where it is resolved (待复核 → 去复核).
   */
  note?: {
    text: string;
    tone?: "muted" | "warn";
    action?: { label: string; onClick(): void; ariaLabel?: string };
  };
  /** Whether the tool is on (the checkbox or the switch); ignored without `onCheck`. */
  checked: boolean;
  /** Locks this row's checkbox or switch (a tool that cannot be switched now; say why in `note`). */
  checkLocked?: boolean;
  /** The policy select's value; the caller passes its "default" value for an unchecked tool. */
  policy: string;
  /** Locks this row's select (a policy someone else fixed; say why in `note`). */
  locked?: boolean;
};

export type ToolPolicyListProps = {
  /** The list's accessible name. */
  label: string;
  rows: ToolPolicyRow[];
  /** The policy select's options (Default / Ask / Deny). */
  policyOptions: SelectOption[];
  /**
   * Draws the checkbox of each row (whether the tool is used). Without it the rows are the title
   * and the select only: a list of policies for tools that are all in use.
   */
  onCheck?: (id: string, next: boolean) => void;
  onPolicy(id: string, value: string): void;
  /** Draws the select-all row; called with the rows the filter shows (checkboxes only). */
  onCheckAll?: (ids: string[], next: boolean) => void;
  /**
   * How `onCheck` is drawn: `checkbox` (default) left of the title, the select off while the tool
   * is unchecked; `switch` (「启用 <title>」) right of the select, which stays editable while the
   * tool is off (a connector's tools: a default policy set before the tool is switched on).
   */
  control?: "checkbox" | "switch";
  /**
   * Read-only (someone who may not change the tools): each row's policy is the option's label as
   * text in the select's column and no checkbox or switch is drawn; say in `note` what is off.
   */
  readOnly?: boolean;
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
 * checked count; `search` the filter field, which narrows the rows by title. Without `onCheck`
 * there are no checkboxes: each row is the title and its select (a member's own policies). With
 * `control: "switch"` the use control is a switch at the row's end and the select stays on; with
 * `readOnly` the policy is text and nothing can be changed.
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
  control = "checkbox",
  readOnly = false,
}: ToolPolicyListProps) {
  const t = useDesignT();
  const id = useId();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = q === "" ? rows : rows.filter((r) => r.label.toLowerCase().includes(q));
  const on = visible.filter((r) => r.checked).length;
  const allState = on === 0 ? false : on === visible.length ? true : "indeterminate";
  /** The checkbox left of the title, the switch at the row's end; neither when read-only. */
  const checkbox = onCheck !== undefined && control === "checkbox" && !readOnly;
  const toggle = onCheck !== undefined && control === "switch" && !readOnly;
  const policyLabel = (v: string) => policyOptions.find((o) => o.value === v)?.label ?? v;
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
      {checkbox && onCheckAll && visible.length > 0 ? (
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
            data-state={onCheck ? (r.checked ? "checked" : "unchecked") : undefined}
          >
            <span className="cb-tool-policy-text" data-check={checkbox ? undefined : "none"}>
              {checkbox && onCheck ? (
                <Checkbox
                  checked={r.checked}
                  disabled={disabled || r.checkLocked === true}
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
              ) : (
                <span
                  className="cb-tool-policy-title"
                  data-part="tool-policy-title"
                  title={r.tooltip}
                >
                  {r.label}
                </span>
              )}
              {r.note ? (
                <span
                  className="cb-tool-policy-note"
                  data-part="tool-policy-note"
                  data-tone={r.note.tone ?? "muted"}
                >
                  {r.note.tone === "warn" ? <Icon name="circle-alert" size={12} /> : null}
                  <span className="cb-tool-policy-note-text">{r.note.text}</span>
                  {r.note.action ? (
                    <button
                      type="button"
                      className="cb-tool-policy-note-action"
                      data-part="tool-policy-note-action"
                      aria-label={r.note.action.ariaLabel}
                      onClick={r.note.action.onClick}
                    >
                      {r.note.action.label}
                    </button>
                  ) : null}
                </span>
              ) : null}
            </span>
            <span className="cb-tool-policy-select" data-part="tool-policy-select">
              {readOnly ? (
                <span className="cb-tool-policy-value" data-part="tool-policy-value">
                  {policyLabel(r.policy)}
                </span>
              ) : (
                <Select
                  density="dense"
                  options={policyOptions}
                  value={r.policy}
                  disabled={disabled || r.locked === true || (checkbox && !r.checked)}
                  aria-label={t("toolPolicy.policyOf").replace("{tool}", r.label)}
                  onChange={(e) => onPolicy(r.id, e.target.value)}
                />
              )}
            </span>
            {toggle && onCheck ? (
              <span className="cb-tool-policy-switch" data-part="tool-policy-switch">
                <Switch
                  checked={r.checked}
                  disabled={disabled || r.checkLocked === true}
                  label={t("toolPolicy.enableOf").replace("{tool}", r.label)}
                  onChange={(next) => onCheck(r.id, next)}
                />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
