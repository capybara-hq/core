import { type MouseEvent, useEffect, useState } from "react";
import { isPlainMenu, useNative, useNativeMenuTrigger } from "../native";
import { BottomSheet } from "./bottom-sheet";
import type { MenuItem } from "./menus";
import { SheetGroup, SheetRow } from "./sheet-parts";
/** An object's actions, one model for every class (responsive system spec §2.4). */
export type ObjectActions = {
  /** The object's main action (Start conversation, Create from it, View). */
  primary?: { label: string; href?: string; onSelect?(): void; loading?: boolean };
  /** The rest, in order; `danger` marks destructive items. */
  items?: MenuItem[];
};

/**
 * The rows an action sheet lists for `a`: the primary first, then the items; separators kept
 * between actions, a submenu flattened into its items; empty when nothing is actionable.
 */
export function actionSheetItems(a: ObjectActions): MenuItem[] {
  const out: MenuItem[] = [];
  const p = a.primary;
  if (p !== undefined && (p.href !== undefined || p.onSelect !== undefined)) {
    out.push(
      p.href !== undefined
        ? { label: p.label, href: p.href, ...(p.loading ? { disabled: true } : {}) }
        : {
            label: p.label,
            onSelect: () => p.onSelect?.(),
            ...(p.loading ? { disabled: true } : {}),
          },
    );
  }
  for (const i of a.items ?? []) {
    if (i === "separator") out.push(i);
    else if (i.submenu !== undefined) out.push(...i.submenu.filter((s) => s !== "separator"));
    else out.push(i);
  }
  // no leading, trailing or doubled separators
  return out.filter(
    (i, n) => i !== "separator" || (n > 0 && n < out.length - 1 && out[n - 1] !== "separator"),
  );
}

export type ActionSheetProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The object's name: the sheet's title. */
  title: string;
  items: MenuItem[];
};

/** The items between separators: each run is one SheetGroup. */
function groupsOf(items: MenuItem[]): Exclude<MenuItem, "separator">[][] {
  const out: Exclude<MenuItem, "separator">[][] = [[]];
  for (const i of items) {
    if (i === "separator") out.push([]);
    else out[out.length - 1]?.push(i);
  }
  return out.filter((g) => g.length > 0);
}

/**
 * The action sheet (responsive system spec §2.4; design spec §6.61; plan T0.3, the minimal form
 * this line needs): a bottom sheet (§6.59: its head, handle and close) titled with the object's
 * name, its actions as `SheetRow`s in `SheetGroup`s (a separator starts a new group), a `danger`
 * item in `fail`. A pick closes the sheet, then runs (so a dialog it opens starts over the page);
 * a link row navigates through the design link. A pick never reaches a drawer under the sheet (a
 * recent row's actions keep the drawer open). The system back closes it first (the bottom sheet's
 * history entry).
 *
 * In a shell with `menu@1` (decision P3) a sheet of plain actions (no link) opens as the
 * platform's action sheet instead, anchored to the focused element (the row or the ⋯ that opened
 * it): the open state hands over at once (closed again), a pick runs its action, a dismissal
 * nothing, and a native failure draws this web sheet. A sheet with a link stays the web sheet, so
 * its link rows keep link behaviour (a modified click, the system's link menu).
 */
export function ActionSheet({ open, onOpenChange, title, items }: ActionSheetProps) {
  const native = useNative();
  // the native sheet failed: this open draws the web sheet
  const [fallback, setFallback] = useState(false);
  const nativeMenu = native?.menu && isPlainMenu(items) ? native.menu : undefined;
  const trigger = useNativeMenuTrigger(
    nativeMenu,
    () => ({
      title,
      actions: items.flatMap((item, n) =>
        item === "separator"
          ? []
          : [
              {
                id: `item-${n}`,
                label: item.label,
                ...(item.danger ? { destructive: true } : {}),
                ...(item.disabled ? { disabled: true } : {}),
                run: () => item.onSelect?.(),
              },
            ],
      ),
    }),
    () => {
      setFallback(true);
      onOpenChange(true);
    },
  );
  const handOver = open && nativeMenu !== undefined && !fallback;
  useEffect(() => {
    if (!handOver) return;
    const anchor = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    trigger.onClick?.({ currentTarget: anchor ?? document.body });
    onOpenChange(false);
  });
  // the fallback sheet closed: the next open tries the native sheet again
  useEffect(() => {
    if (!open && fallback) setFallback(false);
  }, [open, fallback]);
  const pick = (run: (() => void) | undefined) => (e: MouseEvent) => {
    e.stopPropagation();
    onOpenChange(false);
    // after the sheet has closed and handed focus back
    if (run) setTimeout(run, 0);
  };
  return (
    <BottomSheet
      open={open && !handOver}
      onOpenChange={onOpenChange}
      title={title}
      part="action-sheet"
    >
      {groupsOf(items).map((g, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: groups are positional
        <SheetGroup key={n} part="action-sheet-group">
          {g.map((i) =>
            i.href !== undefined ? (
              // The wrapper hears the link's click: the sheet closes while the link navigates.
              // biome-ignore lint/a11y/noStaticElementInteractions: the link inside is the control
              // biome-ignore lint/a11y/useKeyWithClickEvents: the link's Enter fires the same click
              <div key={i.label} className="cb-action-sheet-link" onClick={pick(i.onSelect)}>
                <SheetRow
                  href={i.href}
                  label={i.label}
                  part="action-sheet-item"
                  {...(i.icon ? { icon: i.icon } : {})}
                  {...(i.danger ? { danger: true } : {})}
                />
              </div>
            ) : (
              <SheetRow
                key={i.label}
                label={i.label}
                part="action-sheet-item"
                disabled={i.disabled === true}
                onClick={pick(i.onSelect)}
                {...(i.icon ? { icon: i.icon } : {})}
                {...(i.danger ? { danger: true } : {})}
              />
            ),
          )}
        </SheetGroup>
      ))}
    </BottomSheet>
  );
}
