import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useContext,
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
  /** Prose, clamped to two lines; the full text is the line's `title`. */
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

/** The roving tab stop of a CardGrid (spec §6.34): which card's controls are in the tab order. */
type Slot = { index: number; holder: boolean };
const SlotContext = createContext<Slot | null>(null);

const LINK = '[data-part="object-card-link"]';
const CARD = '[data-part="object-card"]';

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
 * that card's link, primary and menu and leaves the grid. `loading` (true: six cards, or a count)
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
  const [stop, setStop] = useState(0);
  if (loading !== undefined && loading !== false) {
    const count = loading === true ? SKELETON_CARDS : loading;
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
  const cards = Children.toArray(children);
  const holder = Math.min(stop, Math.max(0, cards.length - 1));
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const target = e.target as HTMLElement;
    if (!target.matches(LINK) || e.altKey || e.metaKey || e.shiftKey) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(`:scope > ${CARD}`));
    const at = items.findIndex((c) => c.contains(target));
    if (at < 0) return;
    const to = moveTo(e.key, at, items.length, columnsOf(items));
    if (to === null) return;
    e.preventDefault();
    items[to]?.querySelector<HTMLElement>(LINK)?.focus();
  };
  const onFocus = (e: { target: EventTarget }) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-card-index]");
    const i = Number(card?.getAttribute("data-card-index"));
    if (card !== null && Number.isInteger(i)) setStop(i);
  };
  return (
    <ul
      className="cb-card-grid"
      data-part="card-grid"
      aria-label={label}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {cards.map((child, i) => (
        <SlotContext.Provider
          // Children.toArray keys every child (its own key, else its position), so a card keeps
          // its state when the list is filtered or reordered.
          key={isValidElement(child) && child.key !== null ? child.key : i}
          value={{ index: i, holder: i === holder }}
        >
          {child}
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

function LoadedCard({ avatar, title, href, description, meta, primary, menu }: ObjectCardLoaded) {
  const Link = useDesignLink();
  const t = useDesignT();
  const slot = useContext(SlotContext);
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
  // The description sits over the stretched link (so its title tooltip shows) and passes a plain
  // click on to the link; a click that ends a text selection stays a selection.
  const openFromText = (e: MouseEvent<HTMLElement>) => {
    if (window.getSelection?.()?.toString()) return;
    const link = e.currentTarget.closest(CARD)?.querySelector<HTMLElement>(LINK);
    link?.click();
  };
  return (
    <li
      className="cb-object-card"
      data-part="object-card"
      data-card-index={slot === null ? undefined : slot.index}
    >
      <span className="cb-object-card-head" data-part="object-card-head">
        <CardAvatar avatar={avatar} title={title} />
        <Link
          href={href}
          className="cb-object-card-link"
          data-part="object-card-link"
          {...(tabIndex !== undefined ? { tabIndex } : {})}
        >
          <span className="cb-object-card-name" data-part="object-card-name" title={title}>
            {title}
          </span>
          <LinkPendingMark />
        </Link>
      </span>
      {description ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: a pointer convenience; the card's link is the keyboard way in
        <p
          className="cb-object-card-desc"
          data-part="object-card-description"
          title={description}
          onClick={openFromText}
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
              {...(a.onSelect ? { onClick: a.onSelect } : {})}
            >
              {a.label}
            </Button>
          ),
        )}
        {actions.length > 0 && lone === undefined ? (
          <Menu
            items={menu ?? []}
            trigger={
              <IconButton
                label={t("shell.moreActions")}
                icon={<Icon name="more-horizontal" />}
                density="dense"
                variant="default"
                disabled={waiting}
                tabIndex={tabIndex}
              />
            }
          />
        ) : null}
      </span>
    </li>
  );
}
