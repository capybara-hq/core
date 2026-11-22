import { type JSX, type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { ConvMenu, type ConvMenuEntry, MENU_FILTER_THRESHOLD } from "../conversation/menu";
import { Avatar } from "../display/avatar";
import { Icon } from "../icons/icon";
import { useHaptics } from "../native";
import { BottomSheet, SheetOptionList } from "../overlays/bottom-sheet";
import { SheetGroup } from "../overlays/sheet-parts";
import { useDesignT } from "../provider";
import { useClassForm } from "../shell/class-forms";
import { type Density, useDensity } from "./density";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  /**
   * A person (spec §6.2 "Options with a person"): a 16 circle `Avatar` before the label in the
   * trigger and the menu; `null` draws the initial of the label.
   */
  person?: { avatarUrl: string | null };
};

/** The 16 circle avatar of an option's person. */
function optionAvatar(o: SelectOption) {
  if (!o.person) return undefined;
  const { avatarUrl } = o.person;
  return (
    <Avatar
      shape="circle"
      size={16}
      name={o.label}
      value={avatarUrl ? { kind: "image", src: avatarUrl } : null}
    />
  );
}

/** What `onChange` receives: the part of a native select's change event callers read. */
export type SelectChangeEvent = {
  target: { value: string; name: string };
  currentTarget: { value: string; name: string };
};

export type SelectProps = {
  options: SelectOption[];
  /** The chosen value (controlled); `defaultValue` for an uncontrolled one (default: the first option). */
  value?: string | undefined;
  defaultValue?: string | undefined;
  /** Called when a person picks another option (never for the current one), as a native change. */
  onChange?: ((e: SelectChangeEvent) => void) | undefined;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  /** Shown, `faint`, while the value matches no option. */
  placeholder?: string | undefined;
  /** A form field: a hidden native select carries the value, `required` and `form` for the form. */
  name?: string | undefined;
  required?: boolean | undefined;
  form?: string | undefined;
  density?: Density | undefined;
  /** Set by `Field` (the label's `for`, help or error, invalid, required). */
  id?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | "true" | "false" | undefined;
  "aria-required"?: boolean | "true" | "false" | undefined;
  "aria-label"?: string | undefined;
  "aria-labelledby"?: string | undefined;
  /** Draw the list open in place (the reference set and the catalog only). */
  referenceOpen?: boolean | undefined;
};

/**
 * A form select (spec §6.2): a field-like button (`combobox`) that opens the design system's own
 * list instead of the browser's popup: the anchored menu of §6.16.3 as a `listbox` (below the
 * field, above it when the room below is short, at least the field's width, its height capped at
 * `layout.menu-max-height` and the live room, a filter past ten options), the selected option
 * with a `check`. Arrows, Enter, Space, Escape and typeahead (without a filter) as a native select.
 * A `Field` names it through its label (`label[for]` reaches the button).
 */
export function Select({
  options,
  value,
  defaultValue,
  onChange,
  disabled,
  invalid,
  placeholder,
  name,
  required,
  form,
  density,
  referenceOpen,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  "aria-required": ariaRequired,
}: SelectProps): JSX.Element {
  const step = useDensity(density);
  const autoId = useId();
  const triggerId = id ?? `${autoId}-select`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [own, setOwn] = useState(defaultValue ?? options[0]?.value ?? "");
  const [open, setOpen] = useState(false);
  // The list's name: the field's label (by id), else its text, else the trigger's aria-label.
  const [listName, setListName] = useState<{ labelledBy?: string; label?: string }>({});
  // Disabled closes it for good: a pick whose save disables the field (flushed inside Radix's
  // select event) must not reopen the list when the save settles.
  if (disabled && open) setOpen(false);
  const current = value ?? own;
  const chosen = options.find((o) => o.value === current);
  const isInvalid = invalid === true || ariaInvalid === true || ariaInvalid === "true";

  useLayoutEffect(() => {
    if (ariaLabelledBy) return setListName({ labelledBy: ariaLabelledBy });
    if (ariaLabel) return setListName({ label: ariaLabel });
    const label = triggerRef.current?.labels?.[0];
    if (!label) return setListName({});
    setListName(label.id ? { labelledBy: label.id } : { label: label.textContent ?? "" });
  }, [ariaLabel, ariaLabelledBy]);

  const t = useDesignT();
  // The compact class (and only after hydration: `null` before it draws the desktop form) opens
  // a picker sheet instead of the anchored list (interaction spec §2.5).
  const compact = useClassForm() === "compact";
  const [sheetOpen, setSheetOpen] = useState(false);
  const [query, setQuery] = useState("");
  if (sheetOpen && (disabled || !compact)) setSheetOpen(false);
  const closeSheet = () => {
    setSheetOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };
  // The sheet's title: the field's label (by id, else its text), else the trigger's aria-label.
  const sheetTitle = () => {
    const by = ariaLabelledBy ? document.getElementById(ariaLabelledBy)?.textContent : undefined;
    return (
      by ??
      ariaLabel ??
      triggerRef.current?.labels?.[0]?.textContent ??
      placeholder ??
      chosen?.label ??
      ""
    );
  };
  const [title, setTitle] = useState("");

  const haptics = useHaptics();
  const pick = (v: string) => {
    if (value === undefined) setOwn(v);
    if (v === current) return;
    // a change plays the `selection` haptic (a native shell's)
    haptics("selection");
    const target = { value: v, name: name ?? "" };
    onChange?.({ target, currentTarget: target });
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      id={triggerId}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={referenceOpen === true || (!disabled && (compact ? sheetOpen : open))}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={describedBy}
      aria-invalid={isInvalid ? true : undefined}
      aria-required={required ? true : ariaRequired}
      disabled={disabled}
      value={current}
      className="cb-select"
      data-part="select"
      data-cap-part="input"
      data-density={step}
      data-state={disabled ? "disabled" : isInvalid ? "error" : undefined}
      // a click on the Field's label reaches the button as a click without a pointer (detail 0):
      // it focuses the field, as a native select's label does (Radix opens on pointerdown)
      onClick={(e) => {
        if (compact) {
          if (disabled) return;
          setTitle(sheetTitle());
          setSheetOpen(true);
          return;
        }
        if (e.detail === 0 && !open) triggerRef.current?.focus();
      }}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        // ↓, Enter and Space open it (Radix); ↑ too, as a native select
        if (e.key === "ArrowUp" && !open) {
          e.preventDefault();
          setOpen(true);
        }
      }}
    >
      {/* every label in one grid cell, only the current one shown: the field is as wide as its
          widest option, as a native select, and does not jump when the value changes */}
      <span className="cb-select-value" data-part="input-control">
        {options.map((o) => (
          <span
            key={o.value}
            className="cb-select-label"
            data-part="select-label"
            data-current={o === chosen ? "true" : undefined}
            data-person={o.person ? "true" : undefined}
            aria-hidden={o === chosen ? undefined : "true"}
          >
            {o.person ? (
              <>
                {optionAvatar(o)}
                <span className="cb-select-label-text">{o.label}</span>
              </>
            ) : (
              o.label
            )}
          </span>
        ))}
        {placeholder !== undefined ? (
          <span
            className="cb-select-label"
            data-part="select-label"
            data-placeholder="true"
            data-current={chosen ? undefined : "true"}
            aria-hidden={chosen ? "true" : undefined}
          >
            {placeholder}
          </span>
        ) : null}
      </span>
      <span className="cb-input-affix" aria-hidden="true">
        <Icon name="chevron-down" size={14} />
      </span>
    </button>
  );

  const entries: ConvMenuEntry[] = options.map((o) => ({
    kind: "item",
    id: o.value,
    label: o.label,
    ...(o.person ? { icon: optionAvatar(o) } : {}),
    checked: o === chosen,
    ...(o.disabled ? { disabled: true } : {}),
    onSelect: () => pick(o.value),
  }));

  const needle = query.trim().toLowerCase();
  const sheetOptions = options
    .filter((o) => !needle || o.label.toLowerCase().includes(needle))
    .map((o) => ({
      id: o.value,
      label: o.label,
      checked: o === chosen,
      ...(o.disabled ? { disabled: true } : {}),
    }));

  return (
    <div className="cb-select-root">
      {compact ? (
        <>
          {trigger}
          <BottomSheet
            open={sheetOpen && !disabled}
            onOpenChange={(o) => (o ? setSheetOpen(true) : closeSheet())}
            title={title}
            part="select-sheet"
          >
            {options.length > MENU_FILTER_THRESHOLD ? (
              <input
                type="search"
                className="cb-cmenu-filter cb-select-sheet-search"
                data-part="select-sheet-search"
                value={query}
                placeholder={t("menu.filter")}
                aria-label={t("menu.filter")}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
              />
            ) : null}
            <SheetGroup>
              <SheetOptionList
                label={title}
                options={sheetOptions}
                onPick={(v) => {
                  pick(v);
                  closeSheet();
                }}
              />
            </SheetGroup>
          </BottomSheet>
        </>
      ) : (
        /* always the same tree: toggling `disabled` (a save in flight) keeps the button mounted */
        <ConvMenu
          trigger={trigger}
          entries={entries}
          anchored
          listbox
          {...(listName.labelledBy ? { labelledBy: listName.labelledBy } : {})}
          {...(listName.label ? { label: listName.label } : {})}
          open={!disabled && open}
          onOpenChange={(o) => setOpen(o && !disabled)}
          {...(referenceOpen ? { inline: true } : {})}
        />
      )}
      {name !== undefined || required || form !== undefined ? (
        // the form's copy: submits the value, validates `required`; its options carry no text
        <select
          aria-hidden="true"
          tabIndex={-1}
          className="cb-sr-only"
          name={name}
          required={required}
          form={form}
          disabled={disabled}
          value={chosen ? current : ""}
          onChange={() => {}}
          // a failed validation focuses it: the person lands on the field
          onFocus={() => triggerRef.current?.focus()}
        >
          {chosen ? null : <option value="" />}
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled} />
          ))}
        </select>
      ) : null}
    </div>
  );
}
