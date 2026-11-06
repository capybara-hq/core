import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, IconButton, LinkButton } from "../controls/index";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { Menu, type MenuItem, menuActions, menuLone } from "../overlays/index";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";
import { Avatar, type AvatarValue } from "./avatar";
import { EmptyState, type EmptyStateProps } from "./empty-state";
import { SkeletonBox, SkeletonText, useSkeletonAnnounces } from "./skeleton";

/** A card's one primary action (spec §6.34): a `dense` `default` button, or a link. */
export type ObjectCardAction = {
  label: string;
  href?: string;
  onSelect?(): void;
  /** The action is running: the Button's loading state, and the card's other buttons wait. */
  loading?: boolean;
};

/** One loaded card (spec §6.34). */
export type ObjectCardLoaded = {
  /**
   * An agent's `Avatar` at 40 (`null`, or left out: the initial square of `title`), or `{ icon }`
   * for an object without a picture (a 40 px tile on `selected` with the 16 px icon).
   */
  avatar?: AvatarValue | { icon: IconName };
  title: string;
  /** The detail page: the whole card opens it (the name is the card's one link). */
  href: string;
  /** Prose, clamped to two lines; the full text is the line's `title` when it is cut off. */
  description?: string;
  /**
   * One mono line; as a list, the parts are joined with " · " and a `{ label, tone: "warn" }` part
   * is drawn in `warn` (as ObjectRow's meta).
   */
  meta?: string | (string | { label: string; tone: "warn" })[];
  /** The card's one primary action (开始会话, 用它创建, 查看), beside the link, never inside it. */
  primary?: ObjectCardAction;
  /** The ⋯ menu (spec §6.7: no menu of one; a lone safe item is drawn as a second button). */
  menu?: MenuItem[];
  loading?: false;
};

/** A loaded card, or `{ loading: true }`: a skeleton card in the same anatomy. */
export type ObjectCardProps = ObjectCardLoaded | { loading: true };

/** Skeleton cards a loading grid shows: two rows of three at the content width. */
const SKELETON_CARDS = 6;

/**
 * The roving tab stop of a CardGrid (spec §6.34): whether this card's controls are in the tab
 * order, and how the card tells the grid that focus entered it (also from its menu, a portal).
 */
type Slot = {
  holder: boolean;
  onFocusCard(): void;
  /** The card is going away with focus inside it (its link, its buttons, its open menu). */
  onLeaveWithFocus(): void;
};
const SlotContext = createContext<Slot | null>(null);
/** The card's key in its grid, written on its `li` so the grid can find its link. */
const CardKey = createContext<string | null>(null);

const LINK = '[data-part="object-card-link"]';
const CARD = '[data-part="object-card"]';
/** The cards the arrows move between: skeleton cards have no link and take no part. */
const LOADED_CARD = `${CARD}:not([data-skeleton="true"])`;

/** One child of the grid with a key unique in the grid (fragments flattened). */
type Entry = { key: string; node: ReactNode; holdable: boolean };

/**
 * The grid's children as a flat list: fragments are opened (their keys prefix their children's),
 * so a page may pass `<>{agents}{templates}</>`. A child holds the stop unless it is a skeleton
 * card (`ObjectCard loading`) or not an element.
 */
function flatten(children: ReactNode, prefix = ""): Entry[] {
  const out: Entry[] = [];
  Children.toArray(children).forEach((child, i) => {
    if (isValidElement(child) && child.type === Fragment) {
      const el = child as ReactElement<{ children?: ReactNode }>;
      out.push(...flatten(el.props.children, `${prefix}${String(el.key ?? i)}/`));
      return;
    }
    const key = `${prefix}${isValidElement(child) && child.key !== null ? child.key : i}`;
    const holdable =
      isValidElement(child) && (child.props as { loading?: unknown }).loading !== true;
    out.push({ key, node: child, holdable });
  });
  return out;
}

/**
 * The card holding the tab stop: the stored card while it is there; when it has gone (deleted,
 * filtered out), its neighbour, the card now at its place (else the new last card); else the first.
 */
function holderOf(keys: string[], stop: string | null, lastIndex: number): string | undefined {
  if (stop !== null && keys.includes(stop)) return stop;
  if (stop !== null && keys.length > 0) return keys[Math.min(lastIndex, keys.length - 1)];
  return keys[0];
}

/** Cards in the first visual row: the grid's column count (at least 1). */
function columnsOf(cards: HTMLElement[]): number {
  const first = cards[0]?.getBoundingClientRect().top;
  if (first === undefined) return 1;
  let n = 0;
  for (const c of cards) {
    if (Math.abs(c.getBoundingClientRect().top - first) > 1) break;
    n += 1;
  }
  return Math.max(1, n);
}

/** The card the key moves to from `at`, or `at` when it stays (roving focus by row). */
function moveTo(key: string, at: number, count: number, cols: number): number | null {
  const last = count - 1;
  switch (key) {
    case "ArrowRight":
      return Math.min(last, at + 1);
    case "ArrowLeft":
      return Math.max(0, at - 1);
    case "ArrowDown": {
      if (at + cols <= last) return at + cols;
      // a short last row: the last card, when it lies in a later row
      return Math.floor(last / cols) > Math.floor(at / cols) ? last : at;
    }
    case "ArrowUp":
      return at - cols >= 0 ? at - cols : at;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * A responsive grid of {@link ObjectCard}s on the page ground (spec §6.34, ruling P4-15): `auto-fill`
 * columns at least `layout.card-min` wide, `space.3` apart, one column on phones; no box around it,
 * one box per card. Roving focus by row: the grid is one tab stop, the card last reached (the first
 * by default); ← / → move to the previous / next card, ↑ / ↓ to the card above / below (the last
 * card when a short last row has none below), Home / End to the first / last; Tab then goes through
 * that card's link, primary and menu and leaves the grid. The stop belongs to a card (its key): when
 * that card goes away it moves to the neighbour, and so does focus if it was inside the card. The
 * children are a flat list of keyed cards (fragments are opened). `loading` (true: six cards, or a count)
 * draws skeleton cards in the card's anatomy and marks the list busy; `empty` draws the EmptyState
 * instead of the grid. Loading wins over empty.
 */
export function CardGrid({
  label,
  loading,
  empty,
  children,
}: {
  label: string;
  loading?: boolean | number;
  empty?: EmptyStateProps;
  children?: ReactNode;
}) {
  const t = useDesignT();
  const announces = useSkeletonAnnounces();
  const [stop, setStop] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** The holder's position at the last render: where its neighbour will be if it goes. */
  const lastIndex = useRef(0);
  /** A card that went away with focus inside it, until the grid has handed focus on. */
  const lostFocus = useRef(false);
  const isLoading = loading !== undefined && loading !== false;
  const entries = isLoading || empty ? [] : flatten(children);
  const keys = entries.filter((e) => e.holdable).map((e) => e.key);
  const holder = holderOf(keys, stop, lastIndex.current);
  // The held card went away: the stop moves to its neighbour, and if focus was in the card (its
  // link, its buttons, its menu), focus follows to the neighbour's link instead of falling to body.
  useLayoutEffect(() => {
    if (holder !== undefined) lastIndex.current = keys.indexOf(holder);
    if (stop !== null && holder !== stop) setStop(holder ?? null);
    if (!lostFocus.current) return;
    lostFocus.current = false;
    if (holder === undefined) return;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(holder)}"] ${LINK}`)
        ?.focus();
    }
  });
  if (isLoading) {
    const count = loading === true ? SKELETON_CARDS : Number(loading);
    return (
      <ul className="cb-card-grid" data-part="card-grid" aria-label={label} aria-busy="true">
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the skeleton cards are positional
          <SkeletonCard key={i} announce={i === 0 && announces ? t("table.loading") : undefined} />
        ))}
      </ul>
    );
  }
  if (empty) return <EmptyState {...empty} />;
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const target = e.target as HTMLElement;
    if (!target.matches(LINK) || e.altKey || e.metaKey || e.shiftKey) return;
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>(`:scope > ${LOADED_CARD}`),
    );
    const at = items.findIndex((c) => c.contains(target));
    if (at < 0) return;
    const to = moveTo(e.key, at, items.length, columnsOf(items));
    if (to === null) return;
    e.preventDefault();
    items[to]?.querySelector<HTMLElement>(LINK)?.focus();
  };
  return (
    <ul
      ref={listRef}
      className="cb-card-grid"
      data-part="card-grid"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry) => (
        <SlotContext.Provider
          // Keyed by the child's own key, so a card keeps its state (and the stop) when the list
          // is filtered or reordered.
          key={entry.key}
          value={{
            holder: entry.key === holder,
            onFocusCard: () => {
              if (entry.holdable) setStop(entry.key);
            },
            onLeaveWithFocus: () => {
              lostFocus.current = true;
            },
          }}
        >
          <CardKey.Provider value={entry.key}>{entry.node}</CardKey.Provider>
        </SlotContext.Provider>
      ))}
    </ul>
  );
}

/** The skeleton card: the loaded card's boxes, each text a bar slot (spec §6.29). */
function SkeletonCard({ announce }: { announce?: string | undefined }) {
  return (
    <li className="cb-object-card" data-part="object-card" data-skeleton="true">
      <span className="cb-object-card-head" data-part="object-card-head">
        <span className="cb-object-card-avatar" data-part="object-card-avatar" aria-hidden="true">
          <SkeletonBox part="block" height={40} width={40} />
        </span>
        <span className="cb-object-card-name" data-part="object-card-name">
          <SkeletonText width="45%" />
        </span>
      </span>
      <span className="cb-object-card-desc" data-part="object-card-description">
        <SkeletonText width="100%" />
        <SkeletonText width="55%" />
      </span>
      <span className="cb-object-card-foot" data-part="object-card-foot">
        <span className="cb-object-card-meta" data-part="object-card-meta">
          <SkeletonText width="45%" size="small" />
        </span>
        <SkeletonBox part="dense" width={72} />
      </span>
      {announce ? <span className="cb-sr-only">{announce}</span> : null}
    </li>
  );
}

function CardAvatar({ avatar, title }: { avatar: ObjectCardLoaded["avatar"]; title: string }) {
  if (avatar !== undefined && avatar !== null && "icon" in avatar) {
    return (
      <span
        className="cb-object-card-avatar"
        data-part="object-card-avatar"
        data-kind="icon"
        aria-hidden="true"
      >
        <Icon name={avatar.icon} size={16} />
      </span>
    );
  }
  return (
    <span className="cb-object-card-avatar" data-part="object-card-avatar" aria-hidden="true">
      <Avatar value={avatar ?? null} name={title} size={40} />
    </span>
  );
}

/**
 * One card of a {@link CardGrid} (spec §6.34): a single box (`panel`, the `line-card` hairline,
 * radius `md`) holding the avatar or icon, the name, a two-line description, one meta line, one
 * primary action and the ⋯ menu, nothing boxed inside it. The name is the card's one link,
 * stretched over the card so the whole card opens `href`; the primary and the menu sit above it,
 * beside the link (never nested in it), so pressing them does not navigate. `{ loading: true }`
 * draws the skeleton card.
 */
export function ObjectCard(props: ObjectCardProps) {
  if (props.loading === true) return <SkeletonCard />;
  return <LoadedCard {...props} />;
}

/** Whether `ref`'s text is cut off (an ellipsis or a line clamp), measured after layout. */
function useClamped(ref: RefObject<HTMLElement | null>, axis: "x" | "y", text: string | undefined) {
  const [clamped, setClamped] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () =>
      setClamped(
        axis === "x" ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1,
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, axis, text]);
  return clamped;
}

function LoadedCard({ avatar, title, href, description, meta, primary, menu }: ObjectCardLoaded) {
  const Link = useDesignLink();
  const t = useDesignT();
  const slot = useContext(SlotContext);
  const cardKey = useContext(CardKey);
  const nameId = useId();
  const liRef = useRef<HTMLLIElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const descRef = useRef<HTMLParagraphElement>(null);
  // The tooltips carry the full text only when it is cut off.
  const nameClamped = useClamped(nameRef, "x", title);
  const descClamped = useClamped(descRef, "y", description);
  // Leaving the grid with focus inside (deleted from its own menu, filtered out while focused):
  // this cleanup runs before the card's elements are removed, so it can still see where focus is
  // (the card, or its open menu, a portal named by the trigger's aria-controls) and tell the grid,
  // which hands focus to the neighbour card instead of letting it fall to the body.
  const slotRef = useRef(slot);
  slotRef.current = slot;
  useLayoutEffect(
    () => () => {
      const li = liRef.current;
      const active = document.activeElement;
      if (li === null || active === null || active === document.body) return;
      const menuId = li.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-controls");
      const menu = menuId ? document.getElementById(menuId) : null;
      if (li.contains(active) || menu?.contains(active)) slotRef.current?.onLeaveWithFocus();
    },
    [],
  );
  // Outside a grid every control stays in the tab order; inside, only the holder card's.
  const tabIndex = slot === null ? undefined : slot.holder ? 0 : -1;
  const actions = menuActions(menu ?? []);
  const lone = menuLone(menu ?? []);
  const waiting = primary?.loading === true;
  const buttons: ObjectCardAction[] = [];
  if (primary) buttons.push(primary);
  if (lone) {
    buttons.push({
      label: lone.label,
      ...(lone.href !== undefined ? { href: lone.href } : {}),
      ...(lone.onSelect ? { onSelect: lone.onSelect } : {}),
    });
  }
  /** The card's link, from an element inside the card. */
  const linkOf = (el: Element) => el.closest(CARD)?.querySelector<HTMLAnchorElement>(LINK) ?? null;
  // The description sits over the stretched link (so its tooltip shows) and passes a click on to
  // the link: a plain click navigates as the link does; Ctrl / Cmd / Shift or the middle button
  // open a new tab as a link would. A click that ends a text selection in this line stays one.
  const openFromText = (e: MouseEvent<HTMLParagraphElement>) => {
    const sel = window.getSelection?.();
    const p = e.currentTarget;
    const selecting =
      sel !== null &&
      sel !== undefined &&
      !sel.isCollapsed &&
      ((sel.anchorNode !== null && p.contains(sel.anchorNode)) ||
        (sel.focusNode !== null && p.contains(sel.focusNode)));
    if (selecting) return;
    const link = linkOf(p);
    if (link === null) return;
    if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      window.open(link.href, "_blank", "noopener,noreferrer");
      return;
    }
    if (e.button === 0) link.click();
  };
  return (
    <li
      ref={liRef}
      className="cb-object-card"
      data-part="object-card"
      data-card-key={cardKey ?? undefined}
      onFocus={slot === null ? undefined : () => slot.onFocusCard()}
    >
      <span className="cb-object-card-head" data-part="object-card-head">
        <CardAvatar avatar={avatar} title={title} />
        <Link
          href={href}
          className="cb-object-card-link"
          data-part="object-card-link"
          {...(tabIndex !== undefined ? { tabIndex } : {})}
        >
          <span
            ref={nameRef}
            id={nameId}
            className="cb-object-card-name"
            data-part="object-card-name"
            {...(nameClamped ? { title } : {})}
          >
            {title}
          </span>
          <LinkPendingMark />
        </Link>
      </span>
      {description ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: a pointer convenience; the card's link is the keyboard way in
        <p
          ref={descRef}
          className="cb-object-card-desc"
          data-part="object-card-description"
          {...(descClamped ? { title: description } : {})}
          onClick={openFromText}
          onAuxClick={openFromText}
        >
          {description}
        </p>
      ) : null}
      <span className="cb-object-card-foot" data-part="object-card-foot">
        <span className="cb-object-card-meta" data-part="object-card-meta">
          {meta === undefined
            ? null
            : typeof meta === "string"
              ? meta
              : meta.map((m, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional
                  <Fragment key={i}>
                    {i > 0 ? " · " : null}
                    {typeof m === "string" ? (
                      m
                    ) : (
                      <span className="cb-object-card-meta-part" data-tone={m.tone}>
                        {m.label}
                      </span>
                    )}
                  </Fragment>
                ))}
        </span>
        {buttons.map((a, i) =>
          a.href !== undefined ? (
            <LinkButton
              // biome-ignore lint/suspicious/noArrayIndexKey: two fixed slots (the primary, a lone menu item)
              key={i}
              href={a.href}
              variant="default"
              density="dense"
              aria-describedby={nameId}
              {...(tabIndex !== undefined ? { tabIndex } : {})}
            >
              {a.label}
            </LinkButton>
          ) : (
            <Button
              // biome-ignore lint/suspicious/noArrayIndexKey: two fixed slots (the primary, a lone menu item)
              key={i}
              variant="default"
              density="dense"
              loading={a.loading === true}
              disabled={waiting}
              tabIndex={tabIndex}
              aria-describedby={nameId}
              {...(a.onSelect ? { onClick: a.onSelect } : {})}
            >
              {a.label}
            </Button>
          ),
        )}
        {actions.length > 0 && lone === undefined ? (
          <Menu
            items={menu ?? []}
            // A menu item that removed this card: the trigger is gone, so the grid moves focus to
            // the neighbour card instead of the menu returning it to nowhere.
            onCloseAutoFocus={(e) => {
              if (liRef.current === null || !liRef.current.isConnected) e.preventDefault();
            }}
            trigger={
              <IconButton
                label={t("shell.moreActions")}
                icon={<Icon name="more-horizontal" />}
                density="dense"
                variant="default"
                disabled={waiting}
                tabIndex={tabIndex}
                aria-describedby={nameId}
              />
            }
          />
        ) : null}
      </span>
    </li>
  );
}
