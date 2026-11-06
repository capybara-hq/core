import * as RM from "@radix-ui/react-dropdown-menu";
import {
  type JSX,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
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
  /** At most `min(320px, 100vw − 16px)` wide, long labels cut with an ellipsis (quick actions). */
  bounded?: boolean;
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
 * it fits there; when neither side fits it, on the side with more room, capped to it.
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
}: {
  e: ConvMenuEntry;
  i: number;
  noteId: string;
  /** The full label on hover (an anchored menu cuts long ones). */
  title?: boolean;
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
          {...(e.checked !== undefined ? { role: "menuitemradio", "aria-checked": e.checked } : {})}
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
  bounded,
  anchored,
  open,
  onOpenChange,
  onCloseAutoFocus,
  inline,
}: ConvMenuProps): JSX.Element {
  // Notes are not items, so screen readers skip them inside a menu: they describe the menu (m14).
  const noteId = useId();
  const notes = entries.flatMap((e, i) => (e.kind === "note" ? [`${noteId}-${i}`] : []));
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = (o: boolean) => {
    if (open === undefined) setOwn(o);
    onOpenChange?.(o);
  };
  const shared = {
    "data-part": "menu",
    "aria-label": label,
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
      onClose={() => setOpen(false)}
    />
  ) : (
    <RM.Content
      className="cb-cmenu"
      data-size={size === "default" ? undefined : size}
      data-bounded={bounded ? "true" : undefined}
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
      <RM.Trigger asChild>{trigger}</RM.Trigger>
      {inline ? content : <RM.Portal>{content}</RM.Portal>}
    </RM.Root>
  );
}

/** The content of an anchored menu: placement, the height cap, the filter and the scrolling list. */
function AnchoredContent({
  shared,
  entries,
  noteId,
  inline,
  inlineSide,
  sideOffset,
  onClose,
}: {
  shared: Record<string, unknown>;
  entries: ConvMenuEntry[];
  noteId: string;
  inline: boolean;
  inlineSide: "top" | "bottom";
  sideOffset: number;
  onClose(): void;
}): JSX.Element {
  const t = useDesignT();
  const ref = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [place, setPlace] = useState<{ side: "top" | "bottom"; maxHeight: number }>(() => ({
    side: inline ? inlineSide : "bottom",
    maxHeight: SIZES.layout["menu-max-height"],
  }));
  const filterable = itemCount(entries) > MENU_FILTER_THRESHOLD;
  const shown = filterable ? filterMenuEntries(entries, query) : entries;
  const body = shown.filter((e) => e.kind !== "note");
  const footer = entries.map((e, i) => [e, i] as const).filter(([e]) => e.kind === "note");
  const matches = body.filter(
    (e): e is Extract<ConvMenuEntry, { kind: "item" }> => e.kind === "item",
  );

  // Before the first paint: measure the natural height, pick the side and the cap, and bring
  // the checked item into view.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!inline) {
      const id = el.id;
      const triggerEl = id ? document.querySelector(`[aria-controls="${id}"]`) : null;
      const r = triggerEl?.getBoundingClientRect();
      if (r)
        setPlace(
          menuPlacement({
            triggerTop: r.top,
            triggerBottom: r.bottom,
            viewportHeight: window.innerHeight,
            // the list's whole height in place of its capped one
            contentHeight:
              el.offsetHeight -
              (listRef.current?.clientHeight ?? 0) +
              (listRef.current?.scrollHeight ?? 0),
            gap: sideOffset,
          }),
        );
    }
    listRef.current
      ?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [inline, sideOffset]);
  // After Radix has focused the menu: typing starts in the filter.
  useEffect(() => {
    if (!filterable || inline) return;
    const id = setTimeout(() => filterRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [filterable, inline]);

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      listRef.current
        ?.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])')
        ?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
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

  return (
    <RM.Content
      ref={ref}
      className="cb-cmenu"
      data-anchored="true"
      // the side chosen by menuPlacement (Radix's data-side is where it ended up)
      data-placement={place.side}
      side={place.side}
      avoidCollisions={!inline}
      collisionPadding={MENU_COLLISION_PADDING}
      style={{ maxHeight: `${place.maxHeight}px` }}
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
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFilterKey}
        />
      ) : null}
      <div ref={listRef} className="cb-cmenu-list" data-part="menu-list">
        {body.map((e, i) => (
          <Entry key={entryKey(e, i)} e={e} i={i} noteId={noteId} title />
        ))}
        {matches.length === 0 ? (
          <div className="cb-cmenu-empty" data-part="menu-empty" role="status">
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
