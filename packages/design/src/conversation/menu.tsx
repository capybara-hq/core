import * as RM from "@radix-ui/react-dropdown-menu";
import {
  type JSX,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { useDesignT } from "../provider";
import { SIZES } from "../tokens";

// The menus of the conversation page (spec §6.7, §6.16.1, §6.16.3, §6.16.18): the title menu,
// More, the composer pickers and the right panel's switcher. Unlike the generic Menu they carry
// icons, group labels, tags and a closing note, and can be drawn open in place (the reference set).

export type ConvMenuEntry =
  | {
      kind: "item";
      id: string;
      label: string;
      /** An icon before the label, or a node (a type badge). */
      icon?: IconName | ReactNode;
      /** A tag after the label ("agent 默认"). */
      tag?: string;
      /** A choice of a set: a `menuitemradio` with `aria-checked` and a `check` at its end. */
      checked?: boolean;
      /** Draw the `check` at the end of the checked item (default true; the panel switcher omits it). */
      checkMark?: boolean;
      tone?: "fail";
      disabled?: boolean;
      onSelect(): void;
    }
  | { kind: "label"; label: string }
  | { kind: "separator" }
  | { kind: "note"; text: string };

export type ConvMenuProps = {
  trigger: ReactElement<Record<string, unknown>>;
  entries: ConvMenuEntry[];
  /** Accessible name of the menu. */
  label?: string;
  /**
   * The side it opens on. An `anchored` menu picks its side itself ({@link menuPlacement}); there
   * `side` only places a menu drawn open in place (`inline`).
   */
  side?: "top" | "bottom";
  /** Gap between the trigger and the menu (default 4, `space.1`). */
  sideOffset?: number;
  align?: "start" | "end";
  size?: "narrow" | "default" | "wide";
  /**
   * A composer toolbar menu (§6.16.3): anchored to its trigger, below it unless the space below
   * is short (then above), its start edge on the trigger's, at least the trigger's width; its
   * height capped at `layout.menu-max-height` and the room on that side, the list scrolling
   * inside under the filter field (more than {@link MENU_FILTER_THRESHOLD} items) and over the
   * notes; the checked item scrolled into view on open.
   */
  anchored?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /**
   * As the menu closes, before focus returns to the trigger; `preventDefault()` keeps it where
   * an item's action put it (a quick action focuses the composer).
   */
  onCloseAutoFocus?(e: Event): void;
  /**
   * Draw the menu open in place (no portal, not modal, never closes): the reference set and the
   * catalog only.
   */
  inline?: boolean;
  /**
   * A form `Select`'s list (spec §6.2): with `anchored`, the content is a `listbox` and the items
   * are `option`s (`aria-selected`, `data-value` = the item id); without a filter the focus
   * starts on the selected option.
   */
  listbox?: boolean;
  /** The id of the element that names the menu, in place of `label`. */
  labelledBy?: string;
};

/** An anchored menu with more items than this has a filter field at its top. */
export const MENU_FILTER_THRESHOLD = 10;

/** The space kept between an anchored menu and the viewport edge (px). */
export const MENU_COLLISION_PADDING = 8;

export type MenuPlacementInput = {
  /** The trigger's top and bottom edges in the viewport (px). */
  triggerTop: number;
  triggerBottom: number;
  viewportHeight: number;
  /** The menu's natural height: everything shown, nothing capped (px). */
  contentHeight: number;
  /** The design cap (default `layout.menu-max-height`). */
  maxHeight?: number;
  /** Between the trigger and the menu (default 4). */
  gap?: number;
  /** Kept from the viewport edge (default {@link MENU_COLLISION_PADDING}). */
  padding?: number;
};

/**
 * Where an anchored menu opens and how tall it may be (spec §6.16.3): its height is the smaller of
 * the design cap and the room from the trigger to the viewport edge on its side, minus the gap and
 * the collision padding. It opens below when the menu (up to the cap) fits there, else above when
 * it fits there; when neither side fits it, on the side with more room, capped to it. The menu
 * takes `side` from it when it opens; its height is then CSS's (the same min, with Radix's live
 * room on that side), so `maxHeight` is what that CSS comes to at the moment of opening.
 */
export function menuPlacement(i: MenuPlacementInput): {
  side: "top" | "bottom";
  maxHeight: number;
} {
  const cap = i.maxHeight ?? SIZES.layout["menu-max-height"];
  const gap = i.gap ?? 4;
  const pad = i.padding ?? MENU_COLLISION_PADDING;
  const want = Math.min(i.contentHeight, cap);
  const below = i.viewportHeight - i.triggerBottom - gap - pad;
  const above = i.triggerTop - gap - pad;
  const side = want <= below ? "bottom" : want <= above ? "top" : below >= above ? "bottom" : "top";
  return { side, maxHeight: Math.max(0, Math.min(cap, side === "bottom" ? below : above)) };
}

/**
 * The entries a filter query keeps (case-insensitive substring of the label): the matching items,
 * each group label that still heads a match, and the notes; separators drop while filtering. An
 * empty query keeps everything.
 */
export function filterMenuEntries(entries: ConvMenuEntry[], query: string): ConvMenuEntry[] {
  const q = query.trim().toLocaleLowerCase();
  if (q === "") return entries;
  const out: ConvMenuEntry[] = [];
  let label: ConvMenuEntry | null = null;
  for (const e of entries) {
    if (e.kind === "label") label = e;
    else if (e.kind === "note") out.push(e);
    else if (e.kind === "item" && e.label.toLocaleLowerCase().includes(q)) {
      if (label !== null) {
        out.push(label);
        label = null;
      }
      out.push(e);
    }
  }
  return out;
}

const isIconName = (x: unknown): x is IconName => typeof x === "string";
const itemCount = (entries: ConvMenuEntry[]) => entries.filter((e) => e.kind === "item").length;

function Entry({
  e,
  i,
  noteId,
  title,
  listbox,
}: {
  e: ConvMenuEntry;
  i: number;
  noteId: string;
  /** The full label on hover (an anchored menu cuts long ones). */
  title?: boolean;
  /** An option of a listbox (a Select) rather than a menu item. */
  listbox?: boolean;
}): JSX.Element {
  switch (e.kind) {
    case "label":
      return (
        <RM.Label className="cb-cmenu-label" data-part="menu-label">
          {e.label}
        </RM.Label>
      );
    case "separator":
      return <RM.Separator className="cb-cmenu-sep" />;
    case "note":
      return (
        <div id={`${noteId}-${i}`} className="cb-cmenu-note" data-part="menu-note">
          {e.text}
        </div>
      );
    default:
      return (
        <RM.Item
          className="cb-cmenu-item"
          data-part="menu-item"
          data-tone={e.tone}
          disabled={e.disabled}
          onSelect={() => e.onSelect()}
          {...(title ? { title: e.label } : {})}
          {...(listbox
            ? { role: "option", "aria-selected": e.checked === true, "data-value": e.id }
            : e.checked !== undefined
              ? { role: "menuitemradio", "aria-checked": e.checked }
              : {})}
        >
          {e.icon === undefined ? null : isIconName(e.icon) ? (
            <Icon name={e.icon} size={14} />
          ) : (
            e.icon
          )}
          <span className="cb-cmenu-text">{e.label}</span>
          {e.tag ? (
            <span className="cb-cmenu-tag" data-part="menu-tag">
              {e.tag}
            </span>
          ) : null}
          {e.checked !== undefined ? (
            <>
              <span className="cb-cmenu-grow" />
              {e.checked && e.checkMark !== false ? <Icon name="check" size={14} /> : null}
            </>
          ) : null}
        </RM.Item>
      );
  }
}

const entryKey = (e: ConvMenuEntry, i: number) =>
  e.kind === "item" ? e.id : e.kind === "label" ? `l${i}:${e.label}` : `${e.kind[0]}${i}`;

export function ConvMenu({
  trigger,
  entries,
  label,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  size = "default",
  anchored,
  open,
  onOpenChange,
  onCloseAutoFocus,
  inline,
  listbox,
  labelledBy,
}: ConvMenuProps): JSX.Element {
  // Notes are not items, so screen readers skip them inside a menu: they describe the menu (m14).
  const noteId = useId();
  const notes = entries.flatMap((e, i) => (e.kind === "note" ? [`${noteId}-${i}`] : []));
  const [own, setOwn] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isOpen = open ?? own;
  const setOpen = (o: boolean) => {
    if (open === undefined) setOwn(o);
    onOpenChange?.(o);
  };
  const shared = {
    "data-part": "menu",
    "aria-label": label,
    // a menu is named by its trigger (Radix's aria-labelledby); a listbox by its field's label
    ...(listbox || labelledBy ? { "aria-labelledby": labelledBy } : {}),
    ...(notes.length > 0 ? { "aria-describedby": notes.join(" ") } : {}),
    align,
    sideOffset,
    ...(onCloseAutoFocus ? { onCloseAutoFocus } : {}),
  } as const;
  const content = anchored ? (
    <AnchoredContent
      shared={shared}
      entries={entries}
      noteId={noteId}
      inline={inline === true}
      inlineSide={side}
      sideOffset={sideOffset}
      triggerRef={triggerRef}
      listbox={listbox === true}
      onClose={() => setOpen(false)}
    />
  ) : (
    <RM.Content
      className="cb-cmenu"
      data-size={size === "default" ? undefined : size}
      side={side}
      avoidCollisions={!inline}
      {...shared}
    >
      {entries.map((e, i) => (
        <Entry key={entryKey(e, i)} e={e} i={i} noteId={noteId} />
      ))}
    </RM.Content>
  );
  return (
    <RM.Root
      {...(inline
        ? { open: true, modal: false, onOpenChange: () => {} }
        : { open: isOpen, onOpenChange: setOpen })}
    >
      <RM.Trigger ref={triggerRef} asChild>
        {trigger}
      </RM.Trigger>
      {inline ? content : <RM.Portal>{content}</RM.Portal>}
    </RM.Root>
  );
}

/** The items of an anchored menu: menu items, or a Select's options. */
const ITEM_SELECTOR = '[role^="menuitem"], [role="option"]';
const ENABLED_ITEM_SELECTOR =
  '[role^="menuitem"]:not([data-disabled]), [role="option"]:not([data-disabled])';
/** The chosen item: a checked menu item or a selected option. */
const CHECKED_SELECTOR = '[aria-checked="true"], [aria-selected="true"]';

/**
 * Printable keys and Backspace: typing that belongs in the filter field. Space on a focused item
 * is not typing: it activates the item, as Enter does.
 */
const typesIntoFilter = (e: KeyboardEvent): boolean =>
  !e.ctrlKey &&
  !e.metaKey &&
  !e.altKey &&
  (e.key.length === 1 || e.key === "Backspace") &&
  !(e.key === " " && e.target instanceof Element && e.target.matches(ITEM_SELECTOR));

/** The content of an anchored menu: placement, the height cap, the filter and the scrolling list. */
function AnchoredContent({
  shared,
  entries,
  noteId,
  inline,
  inlineSide,
  sideOffset,
  triggerRef,
  listbox,
  onClose,
}: {
  shared: Record<string, unknown>;
  entries: ConvMenuEntry[];
  noteId: string;
  inline: boolean;
  inlineSide: "top" | "bottom";
  sideOffset: number;
  triggerRef: RefObject<HTMLButtonElement | null>;
  listbox: boolean;
  onClose(): void;
}): JSX.Element {
  const t = useDesignT();
  const ref = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const countId = useId();
  const [query, setQuery] = useState("");
  // The side it opens on (menuPlacement, once); the height is CSS's, from Radix's live room on
  // that side, so it stays right after a resize, a zoom or a phone keyboard.
  const [side, setSide] = useState<"top" | "bottom">(inline ? inlineSide : "bottom");
  const filterable = itemCount(entries) > MENU_FILTER_THRESHOLD;
  const shown = filterable ? filterMenuEntries(entries, query) : entries;
  const body = shown.filter((e) => e.kind !== "note");
  const footer = entries.map((e, i) => [e, i] as const).filter(([e]) => e.kind === "note");
  const matches = body.filter(
    (e): e is Extract<ConvMenuEntry, { kind: "item" }> => e.kind === "item",
  );

  // Before the first paint: measure the natural height, pick the side, and scroll the list to
  // the checked item.
  useLayoutEffect(() => {
    const el = ref.current;
    const list = listRef.current;
    if (!el || !list) return;
    const r = inline ? undefined : triggerRef.current?.getBoundingClientRect();
    if (r)
      setSide(
        menuPlacement({
          triggerTop: r.top,
          triggerBottom: r.bottom,
          viewportHeight: window.innerHeight,
          // the list's whole height in place of its capped one
          contentHeight: el.offsetHeight - list.clientHeight + list.scrollHeight,
          gap: sideOffset,
        }).side,
      );
    const item = list.querySelector<HTMLElement>(CHECKED_SELECTOR);
    if (item && item.offsetTop + item.offsetHeight > list.clientHeight)
      list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  }, [inline, sideOffset, triggerRef]);
  // After Radix has focused the menu: a listbox without a filter starts on its selected option
  // (else its first), as a native select does.
  useEffect(() => {
    if (!listbox || filterable || inline) return;
    const id = setTimeout(() => {
      const list = listRef.current;
      const start =
        list?.querySelector<HTMLElement>('[aria-selected="true"]:not([data-disabled])') ??
        list?.querySelector<HTMLElement>(ENABLED_ITEM_SELECTOR);
      start?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(id);
  }, [listbox, filterable, inline]);
  // After Radix has focused the menu: typing starts in the filter.
  useEffect(() => {
    if (!filterable || inline) return;
    const id = setTimeout(() => filterRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [filterable, inline]);

  const focusFilter = () => {
    const f = filterRef.current;
    if (!f) return;
    f.focus();
    f.setSelectionRange(f.value.length, f.value.length);
  };
  const firstItem = () =>
    listRef.current?.querySelector<HTMLElement>(ENABLED_ITEM_SELECTOR) ?? null;

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // an IME composition owns its keys (Enter confirms the text, it never picks)
    if (e.nativeEvent.isComposing) {
      e.stopPropagation();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      firstItem()?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const first = matches.find((m) => !m.disabled);
      if (first) {
        first.onSelect();
        onClose();
      }
    } else if (e.key !== "Escape" && e.key !== "Tab") {
      // the menu's own typeahead would take the focus from the field
      e.stopPropagation();
    }
  };
  // Radix moves the focus to an item on hover and to the menu when the pointer leaves: typing
  // and Backspace from there go back to the filter, and ↑ on the first item returns to it.
  const onContentKeyCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!filterable || e.target === filterRef.current || e.nativeEvent.isComposing) return;
    if (typesIntoFilter(e)) {
      e.stopPropagation();
      // a character lands in the field once it has the focus; Backspace has no such second
      // event everywhere, so it edits the query here
      if (e.key === "Backspace") {
        e.preventDefault();
        setQuery((q) => q.slice(0, -1));
      }
      focusFilter();
    } else if (e.key === "ArrowUp" && e.target === firstItem()) {
      e.preventDefault();
      e.stopPropagation();
      focusFilter();
    }
  };

  return (
    <RM.Content
      ref={ref}
      className="cb-cmenu"
      data-anchored="true"
      side={side}
      avoidCollisions={!inline}
      collisionPadding={MENU_COLLISION_PADDING}
      onKeyDownCapture={onContentKeyCapture}
      {...(listbox ? { role: "listbox" } : {})}
      {...shared}
    >
      {filterable ? (
        <input
          ref={filterRef}
          className="cb-cmenu-filter"
          data-part="menu-filter"
          type="text"
          value={query}
          placeholder={t("menu.filter")}
          aria-label={t("menu.filter")}
          aria-controls={listId}
          aria-describedby={countId}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFilterKey}
        />
      ) : null}
      {filterable ? (
        // always mounted, so a change of the count is announced
        <div id={countId} className="cb-sr-only" role="status" data-part="menu-count">
          {query.trim() === ""
            ? ""
            : matches.length === 0
              ? t("menu.noMatch")
              : t("menu.count").replace("{n}", String(matches.length))}
        </div>
      ) : null}
      <div ref={listRef} id={listId} className="cb-cmenu-list" data-part="menu-list">
        {body.map((e, i) => (
          <Entry key={entryKey(e, i)} e={e} i={i} noteId={noteId} title listbox={listbox} />
        ))}
        {matches.length === 0 ? (
          <div className="cb-cmenu-empty" data-part="menu-empty">
            {t("menu.noMatch")}
          </div>
        ) : null}
      </div>
      {footer.map(([e, i]) => (
        <Entry key={entryKey(e, i)} e={e} i={i} noteId={noteId} />
      ))}
    </RM.Content>
  );
}
