import * as RD from "@radix-ui/react-dialog";
import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Badge } from "../display/basic";
import { ObjectMark } from "../display/object-mark";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { BottomSheetContent, BottomSheetFrame } from "../overlays/bottom-sheet";
import { commandScore } from "../overlays/palette";
import { useOverlayHistory } from "../overlays/use-overlay-history";
import { useDesignLink, useDesignT } from "../provider";
import { isTouchPointer } from "../shell/pointer";
import { useSizeClass } from "../shell/size-class";
import { TypeBadge, typeBadge } from "./files";
import { Spinner } from "./prose";

// The composer's menus (spec §6.16.30): + (everything a person can add or use), `/` (skills and
// commands) and `@` (files and resources) share one shell anchored above the composer frame, a
// bottom sheet on compact. It has no search box of its own: the query is the composer text after
// the trigger, and the composer textarea stays focused as the combobox that drives the list.

/** Which menu: +, `/` or `@`. */
export type ComposerMenuKind = "plus" | "slash" | "at";

/** One row: an icon (or a mark, or a file's type), the name, a muted line, a trailing badge. */
export type ComposerMenuItem = {
  /** Unique within its group. */
  id: string;
  /** The name, never with a leading `/` or `$`. */
  label: string;
  /** One muted line under the name (a skill's description, a connector's). */
  description?: string;
  /** The row's kind as an icon: `terminal` for a command, `skills` for a skill, a + row's own. */
  icon?: IconName;
  /** A thing a plugin brings (a connector, its prompt or resource): `ObjectMark`, image or initial. */
  mark?: { text: string; image?: string };
  /** A file: its type mark from the name's extension. */
  file?: { name: string };
  /** Faint text after the name (a skill's argument hint "[issue-number]"). */
  hint?: string;
  /** A trailing mark in `warn` (Needs setup on a connector waiting for setup). */
  badge?: string;
  /** Not choosable: drawn `disabled`, skipped by ↑↓, a click does nothing. */
  disabled?: boolean;
  /** More text the query matches, as `search` in `commandScore` ("superpowers:brainstorming"). */
  keywords?: string[];
  /**
   * A second level behind the row (a connector's resources): a trailing → button, named `label`
   * for assistive technology, and the → key on the active row; `onDrill` opens the level. The row's
   * own pick stays the row. Ignored on a disabled row.
   */
  drill?: { label: string; onDrill(): void };
  /** The pick. The caller closes the menu or switches it (Skills opens `/`); the menu does neither. */
  onSelect(): void;
};

export type ComposerMenuGroup = {
  id: string;
  /** The group label (`micro` `muted`); absent for a group without one. */
  label?: string;
  items: ComposerMenuItem[];
};

export type ComposerMenuProps = {
  kind: ComposerMenuKind;
  /** The rows by group, in the order shown; the groups keep this order whatever the query. */
  groups: ComposerMenuGroup[];
  /** The composer text after the trigger (`/fix` → "fix"); "" for +. */
  query: string;
  /**
   * Rank and hide rows by `query` with `commandScore` (default true); `false` when the caller
   * already searched (the `@` menu's server results): every row stays, in the caller's order.
   */
  filter?: boolean;
  /** Results are on their way: a loading row after the rows (and no empty line). */
  loading?: boolean;
  /** The line shown when no row matches. */
  empty: string;
  /** Esc, Backspace through the trigger, a space after `@` with no match, the sheet's dismissal. */
  onClose(): void;
  /** The footer's `@` and `/` hints become buttons switching to that menu. */
  onSwitch?(kind: "slash" | "at"): void;
  /**
   * A second level is open (a connector's resources): the head "‹ title" with a back button, ←
   * and Backspace on an empty query call `onBack`. On compact it is the sheet's in-sheet drill-in
   * (spec §6.59) with the search field. The caller supplies the level's `groups`.
   */
  level?: { title: string; onBack(): void };
  /** The compact sheet's search field (the keyboard covers the composer there). */
  onQueryChange?(query: string): void;
  /** The sheet's search field label (default "Search"). */
  searchLabel?: string;
  /**
   * Guidance under the list, whatever it holds: a muted line and an optional next step, a link
   * (through the DesignProvider's `link`) that closes the menu as it navigates (the `/` menu of an
   * agent without invocable skills links an editor to the agent's skills).
   */
  notice?: { text?: string; action?: { label: string; href: string } };
};

/** A row as the menu shows it: its key, its DOM id, whether it is the active one. */
export type ComposerMenuShownItem = {
  item: ComposerMenuItem;
  /** Unique across the menu (`<group id>/<item id>`). */
  key: string;
  /** The option's element id (the combobox's `aria-activedescendant`). */
  domId: string;
  active: boolean;
};

export type ComposerMenuShownGroup = {
  id: string;
  label?: string;
  items: ComposerMenuShownItem[];
};

/**
 * Where the caret stands in the composer's text, for the keys that only act at an edge. A caller
 * whose field has no `selectionStart` (a contenteditable) passes it as `onKeyDown`'s second
 * argument; without it the menu reads the event target's selection.
 */
export type ComposerMenuCaret = { collapsed: boolean; atStart: boolean; atEnd: boolean };

function readCaret(e: KeyboardEvent<HTMLElement>): ComposerMenuCaret {
  const f = e.currentTarget as HTMLElement & {
    selectionStart?: number | null;
    selectionEnd?: number | null;
    value?: string;
  };
  // no selection to read (not a text field): assume nothing about the caret
  if (typeof f.selectionStart !== "number" || typeof f.selectionEnd !== "number")
    return { collapsed: false, atStart: false, atEnd: false };
  const start = f.selectionStart;
  const end = f.selectionEnd;
  return { collapsed: start === end, atStart: end === 0, atEnd: start === (f.value?.length ?? 0) };
}

/** The attributes the composer textarea takes as the menu's combobox (spec §6.16.30). */
export type ComposerMenuCombobox = {
  role: "combobox";
  "aria-expanded": boolean;
  "aria-autocomplete": "list";
  "aria-controls"?: string;
  "aria-activedescendant"?: string;
};

/** What `useComposerMenu` returns: the combobox's half for the composer, the list's for the menu. */
export type ComposerMenuController = {
  /** The listbox's id. */
  listboxId: string;
  /** The active row's item id; `undefined` while closed or with nothing choosable. */
  activeId: string | undefined;
  /** Spread on the composer textarea (`ComposerBox menu.combobox`). */
  combobox: ComposerMenuCombobox;
  /**
   * The composer textarea's keys: ↑↓ move, ↵ picks (with nothing to choose it closes the menu,
   * while results load it waits; it never sends), Esc closes, Backspace through the trigger (no
   * selection) and a space right after `@` or after `@…` with no match close (the key still
   * types). `true` when the menu took the key (the composer then stops); never during an IME
   * composition.
   */
  onKeyDown(e: KeyboardEvent<HTMLElement>, caret?: ComposerMenuCaret): boolean;
  /** The rows after ranking, for `ComposerMenu`. */
  shown: ComposerMenuShownGroup[];
  /** The pointer moved onto a row. */
  hover(key: string): void;
  /** Picks a row (nothing for a disabled one). */
  pick(item: ComposerMenuItem): void;
  /** The compact sheet's search field keys: ↑↓, ↵ and Esc as in the composer. */
  onFieldKeyDown(e: KeyboardEvent<HTMLElement>): boolean;
};

/**
 * The rows a query keeps (spec §6.16.30): with `filter` each row is scored by `commandScore`
 * (label, `keywords` as its search text, description), non-matches are hidden and the rest of a
 * group is ordered by score (stable); the groups keep the caller's order, so commands, given last,
 * never take the first ↵ meant for a skill. Without `filter` (or with an empty query) everything
 * stays as given. Groups left without rows are dropped.
 */
export function rankComposerMenu(
  groups: ComposerMenuGroup[],
  query: string,
  filter: boolean,
): ComposerMenuGroup[] {
  if (!filter || query.trim() === "") return groups.filter((g) => g.items.length > 0);
  return groups
    .map((g) => ({
      ...g,
      items: g.items
        .map((item, i) => ({
          item,
          i,
          score: commandScore(
            {
              label: item.label,
              ...(item.keywords ? { search: item.keywords.join(" ") } : {}),
              ...(item.description ? { description: item.description } : {}),
            },
            query,
          ),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .map((x) => x.item),
    }))
    .filter((g) => g.items.length > 0);
}

const noModifier = (e: KeyboardEvent<HTMLElement>) =>
  !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;

/**
 * The menu's state for one composer (spec §6.16.30): pass the props while a menu is open, `null`
 * while none is. Call it unconditionally; give `combobox` and `onKeyDown` to `ComposerBox menu`
 * (open or not) and the controller to `ComposerMenu`. The active row starts on the first
 * choosable row and starts over when the menu or the query changes.
 */
export function useComposerMenu(p: ComposerMenuProps | null): ComposerMenuController {
  const listboxId = useId();
  const [chosen, setChosen] = useState<{ key: string; kind: string; query: string } | null>(null);
  // a level starts its own active row, as a new menu kind does
  const levelKey = (q: ComposerMenuProps) => `${q.kind}|${q.level?.title ?? ""}`;
  const open = p !== null;
  const ranked = p ? rankComposerMenu(p.groups, p.query, p.filter !== false) : [];
  const flat = ranked.flatMap((g) => g.items.map((item) => ({ item, key: `${g.id}/${item.id}` })));
  const enabled = flat.filter((r) => r.item.disabled !== true);
  const activeKey =
    p &&
    chosen &&
    chosen.kind === levelKey(p) &&
    chosen.query === p.query &&
    enabled.some((r) => r.key === chosen.key)
      ? chosen.key
      : enabled[0]?.key;
  const domId = (i: number) => `${listboxId}-${i}`;
  const activeIndex = flat.findIndex((r) => r.key === activeKey);
  const active = activeIndex >= 0 ? flat[activeIndex] : undefined;
  let n = 0;
  const shown: ComposerMenuShownGroup[] = ranked.map((g) => ({
    id: g.id,
    ...(g.label ? { label: g.label } : {}),
    items: g.items.map((item) => {
      const key = `${g.id}/${item.id}`;
      return { item, key, domId: domId(n++), active: key === activeKey };
    }),
  }));

  const choose = (key: string) => {
    if (p) setChosen({ key, kind: levelKey(p), query: p.query });
  };
  const move = (dir: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = enabled.findIndex((r) => r.key === activeKey);
    const next = enabled[(at + dir + enabled.length) % enabled.length];
    if (!next) return;
    choose(next.key);
    // a key move keeps the new row in view (the pointer's never scrolls the list)
    const el = document.getElementById(domId(flat.findIndex((r) => r.key === next.key)));
    if (typeof el?.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  };
  const pick = (item: ComposerMenuItem) => {
    if (item.disabled) return;
    item.onSelect();
  };
  const handle = (
    e: KeyboardEvent<HTMLElement>,
    from: "composer" | "field",
    given?: ComposerMenuCaret,
  ): boolean => {
    if (!p) return false;
    const caretFacts = () => given ?? readCaret(e);
    // an IME composition owns its keys (Enter confirms the text, it never picks)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return false;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && noModifier(e)) {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    if (e.key === "Enter" && noModifier(e)) {
      if (active) {
        e.preventDefault();
        pick(active.item);
        return true;
      }
      e.preventDefault();
      // results on their way: the ↵ waits for them; nothing to choose: it closes the menu (the
      // next ↵ sends). It never sends the draft while the menu is open.
      if (!p.loading) p.onClose();
      return true;
    }
    if (e.key === "Escape") {
      // in the sheet's field the sheet's own Esc closes it (once)
      if (from === "field") return false;
      e.preventDefault();
      p.onClose();
      return true;
    }
    // the second level: ← and Backspace on an empty query go back (Backspace then never reaches
    // the composer, so it does not delete the "@")
    if (p.level && noModifier(e) && p.query === "") {
      if (e.key === "ArrowLeft" || (e.key === "Backspace" && caretFacts().collapsed)) {
        e.preventDefault();
        p.level.onBack();
        return true;
      }
    }
    // → on the active row opens its second level, with the caret collapsed at the end of the text
    // (elsewhere it moves the caret)
    if (e.key === "ArrowRight" && noModifier(e) && active?.item.drill && !active.item.disabled) {
      const c = caretFacts();
      if (c.collapsed && c.atEnd) {
        e.preventDefault();
        active.item.drill.onDrill();
        return true;
      }
    }
    if (from === "composer" && p.kind !== "plus") {
      const collapsed = caretFacts().collapsed;
      // the caret right after the trigger: Backspace deletes it, and the menu goes with it (a
      // selection's Backspace deletes the selection instead)
      if (e.key === "Backspace" && p.query === "" && collapsed) {
        p.onClose();
        return false;
      }
      // a space right after "@", or after "@…" with nothing found: the person is writing an
      // address or plain text, not picking
      if (
        e.key === " " &&
        p.kind === "at" &&
        (p.query === "" || (flat.length === 0 && !p.loading))
      ) {
        p.onClose();
        return false;
      }
    }
    return false;
  };

  const combobox: ComposerMenuCombobox = {
    role: "combobox",
    "aria-expanded": open,
    "aria-autocomplete": "list",
    ...(open ? { "aria-controls": listboxId } : {}),
    ...(open && active ? { "aria-activedescendant": domId(activeIndex) } : {}),
  };
  return {
    listboxId,
    activeId: open ? active?.item.id : undefined,
    combobox,
    onKeyDown: (e, caret) => handle(e, "composer", caret),
    shown,
    hover: choose,
    pick,
    onFieldKeyDown: (e) => handle(e, "field"),
  };
}

/** The lead of a row: the icon, the connector's mark, or the file's type. */
function Lead({ item }: { item: ComposerMenuItem }) {
  return (
    <span className="cb-cmm-lead" data-part="composer-menu-lead" aria-hidden="true">
      {item.mark ? (
        <ObjectMark
          text={item.mark.text}
          {...(item.mark.image ? { image: item.mark.image } : {})}
          size={24}
        />
      ) : item.file ? (
        <TypeBadge label={typeBadge(item.file.name, "")} />
      ) : item.icon ? (
        <Icon name={item.icon} size={16} />
      ) : null}
    </span>
  );
}

function Row({
  row,
  controller,
}: {
  row: ComposerMenuShownItem;
  controller: ComposerMenuController;
}): JSX.Element {
  const { item, domId, active } = row;
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: an option of the composer's combobox, which keeps the focus (aria-activedescendant)
    // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox (the composer textarea) handles the keys
    <div
      id={domId}
      role="option"
      className="cb-cmm-item"
      data-part="composer-menu-item"
      aria-selected={active}
      aria-labelledby={`${domId}-label${item.badge ? ` ${domId}-badge` : ""}`}
      {...(item.description ? { "aria-describedby": `${domId}-desc` } : {})}
      {...(item.drill && !item.disabled ? { "aria-keyshortcuts": "ArrowRight" } : {})}
      {...(item.disabled ? { "aria-disabled": true, "data-disabled": "true" } : {})}
      {...(item.description ? { "data-described": "true" } : {})}
      // the composer keeps the focus (and its caret) through a click
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => {
        if (!active && !item.disabled) controller.hover(row.key);
      }}
      onClick={() => controller.pick(item)}
    >
      <Lead item={item} />
      <span className="cb-cmm-body">
        <span className="cb-cmm-head">
          <span className="cb-cmm-label" id={`${domId}-label`}>
            {item.label}
          </span>
          {item.hint ? (
            <span className="cb-cmm-hint" data-part="composer-menu-hint">
              {item.hint}
            </span>
          ) : null}
        </span>
        {item.description ? (
          <span className="cb-cmm-desc" data-part="composer-menu-desc" id={`${domId}-desc`}>
            {item.description}
          </span>
        ) : null}
      </span>
      {item.badge ? (
        <span className="cb-cmm-badge" data-part="composer-menu-badge" id={`${domId}-badge`}>
          <Badge tone="warn">{item.badge}</Badge>
        </span>
      ) : null}
      {item.drill && !item.disabled ? (
        <button
          type="button"
          className="cb-cmm-drill"
          data-part="composer-menu-drill"
          aria-label={item.drill.label}
          // a pointer shortcut: the → key drills, the tab order skips it
          tabIndex={-1}
          // the composer keeps the focus through a click
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            item.drill?.onDrill();
          }}
        >
          <Icon name="chevron-right" size={16} />
        </button>
      ) : null}
    </div>
  );
}

function Group({
  g,
  controller,
  sheet,
}: {
  g: ComposerMenuShownGroup;
  controller: ComposerMenuController;
  sheet: boolean;
}): JSX.Element {
  const id = useId();
  const rows = g.items.map((row) => <Row key={row.key} row={row} controller={controller} />);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of a listbox's options, not a fieldset
    <div role="group" className="cb-cmm-group" {...(g.label ? { "aria-labelledby": id } : {})}>
      {g.label ? (
        <div
          id={id}
          className={sheet ? "cb-sheet-group-heading" : "cb-cmm-group-label"}
          data-part="composer-menu-label"
        >
          {g.label}
        </div>
      ) : null}
      {/* the sheet's rows stand on the sheet group's ground (§6.59) */}
      {sheet ? <div className="cb-sheet-group cb-cmm-rows">{rows}</div> : rows}
    </div>
  );
}

/** The listbox with its groups, then the loading row or the empty line in a live region. */
function List({
  p,
  controller,
  title,
  sheet,
}: {
  p: ComposerMenuProps;
  controller: ComposerMenuController;
  title: string;
  sheet?: boolean;
}): JSX.Element {
  const t = useDesignT();
  const rows = controller.shown.reduce((n, g) => n + g.items.length, 0);
  return (
    <>
      <div
        id={controller.listboxId}
        role="listbox"
        aria-label={title}
        className="cb-cmm-list"
        data-part="composer-menu-list"
      >
        {controller.shown.map((g) => (
          <Group key={g.id} g={g} controller={controller} sheet={sheet === true} />
        ))}
      </div>
      {/* always mounted, so the empty line and the loading row are announced */}
      <div role="status" className="cb-cmm-status">
        {p.loading ? (
          <div className="cb-cmm-loading" data-part="composer-menu-loading">
            <Spinner label={t("composerMenu.loading")} />
            <span>{t("composerMenu.loading")}</span>
          </div>
        ) : rows === 0 ? (
          <div className="cb-cmm-empty" data-part="composer-menu-empty">
            {p.empty}
          </div>
        ) : null}
      </div>
      {p.notice ? <Notice notice={p.notice} onClose={p.onClose} /> : null}
    </>
  );
}

/** The guidance under the list: a muted line and the next step's link, which closes the menu. */
function Notice({
  notice,
  onClose,
}: {
  notice: NonNullable<ComposerMenuProps["notice"]>;
  onClose(): void;
}): JSX.Element {
  const Link = useDesignLink();
  return (
    <div className="cb-cmm-notice" data-part="composer-menu-notice">
      {notice.text ? <span>{notice.text}</span> : null}
      {notice.action ? (
        // the link (a keyboard Enter clicks it too) closes the menu as it navigates
        // biome-ignore lint/a11y/noStaticElementInteractions: the click comes from the link inside
        // biome-ignore lint/a11y/useKeyWithClickEvents: the link handles the keyboard itself
        <span onClick={onClose}>
          <Link href={notice.action.href} className="cb-text-link">
            {notice.action.label}
          </Link>
        </span>
      ) : null}
    </div>
  );
}

/** The second level's head "‹ title": a back button and the level's title. */
function LevelHead({ level }: { level: NonNullable<ComposerMenuProps["level"]> }): JSX.Element {
  const t = useDesignT();
  return (
    <div className="cb-cmm-level" data-part="composer-menu-level">
      <button
        type="button"
        className="cb-cmm-back"
        data-part="composer-menu-back"
        aria-label={t("composerMenu.back")}
        // the composer keeps the focus through a click
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => level.onBack()}
      >
        <Icon name="chevron-left" size={16} />
      </button>
      <span className="cb-cmm-level-title">{level.title}</span>
    </div>
  );
}

/** The footer's key hints (from 841 up): the menu switches as buttons, the rest as text. */
function Footer({
  p,
  controller,
}: {
  p: ComposerMenuProps;
  controller: ComposerMenuController;
}): JSX.Element {
  const t = useDesignT();
  const sep = (
    <span className="cb-cmm-sep" aria-hidden="true">
      ·
    </span>
  );
  const keyText = (k: string, label: string) => (
    <>
      <span className="cb-cmm-key">{k}</span> {label}
    </>
  );
  const switchTo = (kind: "at" | "slash", k: string, label: string) =>
    p.onSwitch ? (
      <button
        type="button"
        className="cb-cmm-switch"
        data-part="composer-menu-switch"
        aria-pressed={p.kind === kind}
        // a pointer shortcut: the keys switch by typing the trigger, the tab order skips it
        tabIndex={-1}
        // the composer keeps the focus through a click
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => p.onSwitch?.(kind)}
      >
        {keyText(k, label)}
      </button>
    ) : (
      <span>{keyText(k, label)}</span>
    );
  return (
    <div className="cb-cmm-foot" data-part="composer-menu-foot">
      {switchTo("at", "@", t("composerMenu.footAt"))}
      {sep}
      {switchTo("slash", "/", t("composerMenu.hint.slash"))}
      {sep}
      <span>{keyText("↑↓", t("composerMenu.hint.move"))}</span>
      {sep}
      {!p.level && controller.shown.some((g) => g.items.some((r) => r.item.drill)) ? (
        <>
          <span data-part="composer-menu-drill-hint">{t("composerMenu.footDrill")}</span>
          {sep}
        </>
      ) : null}
      <span>{keyText("↵", t("composerMenu.hint.pick"))}</span>
      {sep}
      <span>{keyText("esc", t("composerMenu.hint.close"))}</span>
      <span className="cb-cmm-grow" />
      {p.kind === "plus" ? null : (
        <span className="cb-cmm-type" data-part="composer-menu-type">
          {t("composerMenu.typeToSearch")}
        </span>
      )}
    </div>
  );
}

/** The compact sheet's body: the search field over the rows. */
function SheetBody({
  p,
  controller,
  title,
  keepFocus,
}: {
  p: ComposerMenuProps;
  controller: ComposerMenuController;
  title: string;
  /** Set by the sheet that owns this body: the search field had the focus when the body unmounted. */
  keepFocus?: { current: boolean };
}): JSX.Element {
  const t = useDesignT();
  const field = useRef<HTMLInputElement>(null);
  // The sheet keys its pane by page, so a drill (or back) remounts this body: hand the focus on
  // to the new search field when the old one held it.
  useLayoutEffect(() => {
    const input = field.current;
    if (keepFocus?.current) {
      keepFocus.current = false;
      input?.focus();
    }
    return () => {
      if (keepFocus && document.activeElement === input) keepFocus.current = true;
    };
  }, [keepFocus]);
  const label = p.searchLabel ?? t("composerMenu.search");
  const activeDom = controller.shown.flatMap((g) => g.items).find((r) => r.active)?.domId;
  return (
    <div className="cb-cmm" data-part="composer-menu" data-kind={p.kind} data-form="sheet">
      <input
        ref={field}
        type="search"
        className="cb-cmm-search"
        data-part="composer-menu-search"
        aria-label={label}
        placeholder={label}
        value={p.query}
        aria-controls={controller.listboxId}
        {...(activeDom ? { "aria-activedescendant": activeDom } : {})}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => p.onQueryChange?.(e.target.value)}
        onKeyDown={(e) => {
          controller.onFieldKeyDown(e);
        }}
      />
      <List p={p} controller={controller} title={title} sheet />
    </div>
  );
}

/** The compact form: a bottom sheet with one history entry (the system back closes it). */
function ComposerMenuSheet({
  p,
  controller,
  title,
}: {
  p: ComposerMenuProps;
  controller: ComposerMenuController;
  title: string;
}): JSX.Element {
  const t = useDesignT();
  const keepFocus = useRef(false);
  useOverlayHistory(true, p.onClose);
  return (
    <RD.Root
      open
      onOpenChange={(o) => {
        if (!o) p.onClose();
      }}
    >
      <BottomSheetContent
        // a level is the sheet's own drill-in (§6.59): its title, a back control, Esc goes back
        title={p.level?.title ?? title}
        {...(p.level ? { page: p.level.title } : {})}
        back={p.level ? { label: t("composerMenu.back"), onBack: p.level.onBack } : undefined}
        part="composer-menu-sheet"
        onDismiss={p.onClose}
        // on touch a choice never focuses the composer (its focus pops the keyboard)
        returnFocus={() => !isTouchPointer()}
      >
        <SheetBody p={p} controller={controller} title={title} keepFocus={keepFocus} />
      </BottomSheetContent>
    </RD.Root>
  );
}

/**
 * The composer's menu (spec §6.16.30): as wide as the composer frame, attached `space.2` above it,
 * its list scrolling under `layout.menu-max-height`, the key hints at its foot from 841 up; a
 * bottom sheet with a search field on compact. Render it as `ComposerBox menu.node` while a menu
 * is open, with the controller `useComposerMenu` returned for the same props.
 */
export function ComposerMenu({
  controller,
  referenceSheet,
  referenceAnchored,
  ...p
}: ComposerMenuProps & {
  controller: ComposerMenuController;
  /** The reference set and the catalog only: the compact sheet drawn in place over `page`. */
  referenceSheet?: { page?: ReactNode };
  /**
   * The reference set and the catalog only: the anchored form whatever the size class, so a wide
   * state's block opened in a phone window draws in its cell instead of a portaled sheet.
   */
  referenceAnchored?: boolean;
}): JSX.Element {
  const t = useDesignT();
  const compact = useSizeClass() === "compact";
  const title = t(`composerMenu.title.${p.kind}`);
  if (referenceSheet) {
    return (
      <BottomSheetFrame
        title={p.level?.title ?? title}
        state="idle"
        share={0}
        page={referenceSheet.page}
        {...(p.level ? { backLabel: t("composerMenu.back") } : {})}
      >
        <SheetBody p={p} controller={controller} title={title} />
      </BottomSheetFrame>
    );
  }
  if (compact && !referenceAnchored)
    return <ComposerMenuSheet p={p} controller={controller} title={title} />;
  return <AnchoredMenu p={p} controller={controller} title={title} />;
}

/**
 * The anchored form. It closes when the person leaves the composer: a press outside the composer
 * frame (the menu is inside it), or the focus moving to an element outside it (Tab, a click on
 * another control). The focus leaving the window (another tab, another app) keeps it open.
 */
function AnchoredMenu({
  p,
  controller,
  title,
}: {
  p: ComposerMenuProps;
  controller: ComposerMenuController;
  title: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(p.onClose);
  close.current = p.onClose;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const frame = el.closest<HTMLElement>('[data-part="composer"]') ?? el;
    const inside = (n: EventTarget | null) => n instanceof Node && frame.contains(n);
    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) close.current();
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget !== null && !inside(e.relatedTarget)) close.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    frame.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      frame.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  return (
    <div ref={ref} className="cb-cmm" data-part="composer-menu" data-kind={p.kind}>
      {p.level ? <LevelHead level={p.level} /> : null}
      <div className="cb-cmm-scroll">
        <List p={p} controller={controller} title={title} />
      </div>
      <Footer p={p} controller={controller} />
    </div>
  );
}
