import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "../icons/icon";
import { Menu, type MenuItem } from "../overlays/menus";
import { useOptionalToast } from "../overlays/toast";
import { useDesignT } from "../provider";
import { FIELDS } from "./a11y";
import { Button, IconButton } from "./button";

export interface RepeaterItem {
  /** Stable identity across edits and moves. */
  key: string;
  /** The card's title (`{name}`); also its accessible name. Untitled items are named by position. */
  title?: ReactNode;
  /** A muted mono line after the title (`{baseUrl}`). */
  subtitle?: ReactNode;
  body: ReactNode;
  /** Something inside fails validation: the card's border turns `fail`. */
  invalid?: boolean;
  /** Only the head is drawn (with `onToggle`). */
  collapsed?: boolean;
}

export type RepeaterPreset = { id: string; label: string; help?: string };

export type RepeaterProps = {
  /** The list's accessible name ("端点"). */
  label: string;
  items: RepeaterItem[];
  /** The add button's words ("添加端点"). */
  addLabel: string;
  /** Adds an item; `presetId` when a preset was picked, `undefined` for a blank one. */
  onAdd(presetId?: string): void;
  /** With presets the add button opens a menu of them plus "空白" / "Blank". */
  presets?: RepeaterPreset[];
  /** Removes at once and returns the restore the undo toast calls. */
  onRemove(key: string): () => void;
  /** Present when the order matters: the drag handle, move up / down and Alt+↑/↓. */
  onMove?(key: string, to: number): void;
  /** Present when cards collapse: a chevron before the title. */
  onToggle?(key: string): void;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Drawn instead of the list when there are no items. */
  empty?: string;
  /**
   * `cards` (default): hairline cards with a head (title, subtitle, actions). `rows`: compact rows
   * (a `FieldRow` each) with the actions at the row's end and no head; titles only name them.
   */
  variant?: "cards" | "rows";
};

/** Plain text of a title for accessible names and the toast; else "第 n 项" / "Item n". */
function nameOf(item: RepeaterItem, index: number, t: ReturnType<typeof useDesignT>): string {
  if (typeof item.title === "string" || typeof item.title === "number") {
    const s = String(item.title).trim();
    if (s) return s;
  }
  return t("repeater.item").replace("{n}", String(index + 1));
}

type Pending =
  | { kind: "add"; before: Set<string> }
  | { kind: "move"; el: HTMLElement; key: string }
  | { kind: "remove"; index: number };

/**
 * A list of item cards (spec §6.26): an array of objects in a config form (endpoints, models).
 * Each item is a group named by its title; remove is immediate with an undo toast; reorder by drag
 * handle, move buttons or Alt+↑/↓ on a focused item; after an add, focus goes to the new item's
 * first field.
 */
export function Repeater({
  label,
  items,
  addLabel,
  onAdd,
  presets,
  onRemove,
  onMove,
  onToggle,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  disabled = false,
  empty,
  variant = "cards",
}: RepeaterProps) {
  const t = useDesignT();
  const toast = useOptionalToast();
  const base = useId();
  const refs = useRef(new Map<string, HTMLElement>());
  const addRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pending = useRef<Pending | null>(null);
  const addedFromMenu = useRef(false);
  const menuFocus = useRef<HTMLElement | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const canAdd = !disabled && items.length < max;
  const canRemove = !disabled && items.length > min;
  const reorder = onMove !== undefined;

  // Keep focus through the re-render that follows an add, a move or a remove.
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    if (p.kind === "add") {
      const fresh = items.find((i) => !p.before.has(i.key));
      if (!fresh) return; // the caller adds later (async); wait for it
      pending.current = null;
      const el = refs.current.get(fresh.key);
      const body = el?.querySelector<HTMLElement>('[data-part="repeater-body"]');
      const target = body?.querySelector<HTMLElement>(FIELDS) ?? el;
      // A preset menu may still be closing; its close hands focus here too (onCloseAutoFocus).
      if (addedFromMenu.current) menuFocus.current = target ?? null;
      target?.focus();
      return;
    }
    pending.current = null;
    if (p.kind === "move") {
      if (!p.el.isConnected) return;
      const usable = !(p.el instanceof HTMLButtonElement && p.el.disabled);
      if (usable) {
        if (document.activeElement !== p.el) p.el.focus();
        return;
      }
      // A move button that just became disabled (top / bottom): its sibling, else the item.
      const item = refs.current.get(p.key);
      const other = item?.querySelector<HTMLElement>('[data-part="repeater-move"]:not(:disabled)');
      (other ?? item)?.focus();
      return;
    }
    const next = items[Math.min(p.index, items.length - 1)];
    const target = next ? refs.current.get(next.key) : undefined;
    (
      target ?? (addRef.current && !addRef.current.disabled ? addRef.current : rootRef.current)
    )?.focus();
  }, [items]);

  // A drag that never started (the handle pressed and released) disarms the card.
  useEffect(() => {
    if (armed === null) return;
    const up = () => setArmed(null);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [armed]);

  const add = (presetId?: string) => {
    pending.current = { kind: "add", before: new Set(items.map((i) => i.key)) };
    onAdd(presetId);
  };

  const move = (key: string, to: number) => {
    if (!onMove || disabled || to < 0 || to >= items.length) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) pending.current = { kind: "move", el: active, key };
    onMove(key, to);
  };

  const remove = (item: RepeaterItem, index: number) => {
    const name = nameOf(item, index, t);
    pending.current = { kind: "remove", index };
    const restore = onRemove(item.key);
    toast?.success(t("repeater.removed").replace("{name}", name), {
      actionLabel: t("repeater.undo"),
      onAction: restore,
    });
  };

  const onKeyDown = (e: KeyboardEvent, key: string, index: number) => {
    if (!e.altKey || !reorder || disabled) return;
    if (e.key === "ArrowUp" && index > 0) {
      e.preventDefault();
      move(key, index - 1);
    } else if (e.key === "ArrowDown" && index < items.length - 1) {
      e.preventDefault();
      move(key, index + 1);
    }
  };

  const drag = (key: string, index: number) =>
    reorder && !disabled
      ? {
          draggable: armed === key,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", key);
            setDragging(key);
          },
          onDragOver: (e: DragEvent) => {
            if (dragging === null || dragging === key) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOver(key);
          },
          onDragLeave: () => setOver((o) => (o === key ? null : o)),
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            if (dragging !== null && dragging !== key) onMove?.(dragging, index);
            setDragging(null);
            setOver(null);
            setArmed(null);
          },
          onDragEnd: () => {
            setDragging(null);
            setOver(null);
            setArmed(null);
          },
        }
      : {};

  const addButton =
    presets && presets.length > 0 ? (
      <Menu
        label={addLabel}
        onCloseAutoFocus={(e) => {
          // After an add the new item's first field takes focus, not the trigger.
          if (!addedFromMenu.current) return;
          e.preventDefault();
          addedFromMenu.current = false;
          menuFocus.current?.focus();
          menuFocus.current = null;
        }}
        items={[
          ...presets.map(
            (p): MenuItem => ({
              label: p.label,
              ...(p.help ? { description: p.help } : {}),
              onSelect: () => {
                addedFromMenu.current = true;
                add(p.id);
              },
            }),
          ),
          "separator",
          {
            label: t("repeater.blank"),
            onSelect: () => {
              addedFromMenu.current = true;
              add();
            },
          },
        ]}
        trigger={
          <Button ref={addRef} density="dense" disabled={!canAdd} part="repeater-add">
            <Icon name="plus" size={14} />
            {addLabel}
            <Icon name="chevron-down" size={14} />
          </Button>
        }
      />
    ) : (
      <Button
        ref={addRef}
        density="dense"
        disabled={!canAdd}
        part="repeater-add"
        onClick={() => add()}
      >
        <Icon name="plus" size={14} />
        {addLabel}
      </Button>
    );

  const actions = (item: RepeaterItem, index: number, name: string) => (
    <div className="cb-repeater-actions">
      {reorder ? (
        <>
          <IconButton
            density="dense"
            part="repeater-move"
            label={t("repeater.moveUp").replace("{name}", name)}
            icon={<Icon name="arrow-up" size={14} />}
            disabled={disabled || index === 0}
            onClick={() => move(item.key, index - 1)}
          />
          <IconButton
            density="dense"
            part="repeater-move"
            label={t("repeater.moveDown").replace("{name}", name)}
            icon={<Icon name="arrow-down" size={14} />}
            disabled={disabled || index === items.length - 1}
            onClick={() => move(item.key, index + 1)}
          />
        </>
      ) : null}
      <IconButton
        density="dense"
        part="repeater-remove"
        label={t("repeater.remove").replace("{name}", name)}
        icon={<Icon name="trash-2" size={14} />}
        disabled={!canRemove}
        onClick={() => remove(item, index)}
      />
    </div>
  );

  const handle = (key: string) =>
    reorder && !disabled ? (
      <span
        className="cb-repeater-handle"
        data-part="repeater-handle"
        aria-hidden="true"
        onPointerDown={() => setArmed(key)}
      >
        <Icon name="grip-vertical" size={14} />
      </span>
    ) : null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own border and legend layout
    <div
      ref={rootRef}
      className="cb-repeater"
      role="group"
      aria-label={label}
      tabIndex={-1}
      data-part="repeater"
      data-variant={variant}
      data-disabled={disabled ? "true" : undefined}
    >
      {items.length === 0 ? (
        empty ? (
          <p className="cb-repeater-empty" data-part="repeater-empty">
            {empty}
          </p>
        ) : null
      ) : (
        <ul className="cb-repeater-list">
          {items.map((item, index) => {
            const name = nameOf(item, index, t);
            const titleId = `${base}-${index}-title`;
            const collapsed = onToggle !== undefined && item.collapsed === true;
            const hasTitle = typeof item.title !== "undefined";
            // A plain-text title names the group directly; a rich one through its element.
            const richTitle =
              hasTitle && typeof item.title !== "string" && typeof item.title !== "number";
            return (
              <li key={item.key} className="cb-repeater-li">
                {/* biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own border and legend layout */}
                <div
                  ref={(el) => {
                    if (el) refs.current.set(item.key, el);
                    else refs.current.delete(item.key);
                  }}
                  className="cb-repeater-item"
                  role="group"
                  tabIndex={-1}
                  {...(richTitle && variant === "cards"
                    ? { "aria-labelledby": titleId }
                    : { "aria-label": name })}
                  data-part="repeater-item"
                  data-invalid={item.invalid ? "true" : undefined}
                  data-collapsed={collapsed ? "true" : undefined}
                  data-dragging={dragging === item.key ? "true" : undefined}
                  data-drop={over === item.key ? "true" : undefined}
                  onKeyDown={(e) => onKeyDown(e, item.key, index)}
                  {...drag(item.key, index)}
                >
                  {variant === "rows" ? (
                    <>
                      {handle(item.key)}
                      <div className="cb-repeater-body" data-part="repeater-body">
                        {item.body}
                      </div>
                      {actions(item, index, name)}
                    </>
                  ) : (
                    <>
                      <div className="cb-repeater-head" data-part="repeater-head">
                        {handle(item.key)}
                        {onToggle ? (
                          <IconButton
                            density="dense"
                            part="repeater-toggle"
                            label={t(collapsed ? "repeater.expand" : "repeater.collapse").replace(
                              "{name}",
                              name,
                            )}
                            aria-expanded={!collapsed}
                            icon={
                              <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={14} />
                            }
                            onClick={() => onToggle(item.key)}
                          />
                        ) : null}
                        <span className="cb-repeater-titles">
                          <span
                            id={titleId}
                            className="cb-repeater-title"
                            data-part="repeater-title"
                          >
                            {hasTitle ? item.title : name}
                          </span>
                          {item.subtitle ? (
                            <span className="cb-repeater-subtitle" data-part="repeater-subtitle">
                              {item.subtitle}
                            </span>
                          ) : null}
                        </span>
                        {actions(item, index, name)}
                      </div>
                      {collapsed ? null : (
                        <div className="cb-repeater-body" data-part="repeater-body">
                          {item.body}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="cb-repeater-foot">{addButton}</div>
    </div>
  );
}
