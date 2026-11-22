import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, IconButton, LinkButton } from "../controls/index";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { BoxScope } from "../layout/box";
import { ActionSheet, actionSheetItems } from "../overlays/action-sheet";
import { Menu, type MenuItem, menuActions, menuLone } from "../overlays/index";
import { useLongPress } from "../overlays/long-press";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";
import { ClassForms, useClassForm } from "../shell/class-forms";
import { Avatar, type AvatarValue } from "./avatar";
import { ListEnd, ListMoreButton, type ListMoreProps } from "./list-end";
import { MarkImage } from "./object-mark";
import { type PersonLike, PersonName } from "./person-name";
import { rowActionsLabel } from "./row-actions-label";
import { SkeletonBox, SkeletonText, useSkeletonAnnounces } from "./skeleton";

export type ObjectRowProps = {
  /**
   * The 36 px mark: `text` is the display name, drawn as its upper-cased first grapheme (the one
   * avatar-tile rule); `image`, for a thing a plugin brings (a channel, an extension, a model
   * provider), the plugin's declared icon at 24 on the tile, the initial when it fails to load
   * (maintainer decision 2026-11-08); `icon` only for rows that are steps, not objects; `warn`
   * when it needs attention. `avatar` (an agent's row): its `Avatar` at 28 (§6.30) in the mark's
   * 36 px place; `null` draws the initial square.
   */
  mark: {
    text?: string;
    image?: string | null;
    icon?: IconName;
    tone?: "neutral" | "warn";
    avatar?: AvatarValue;
  };
  name: string;
  /** The name links here. */
  href?: string;
  /** Package names and ids are mono. */
  mono?: boolean;
  /** Scope / kind chips and attention chips after the name. */
  chips?: { label: string; tone?: "neutral" | "warn" }[];
  /** One line in `muted`. */
  description?: string;
  /**
   * One mono line in `faint`; as a list, the parts are joined with " · " and a `{ label, tone:
   * "warn" }` part is drawn in `warn` (a sensitive-permission count); a `{ person }` part is a
   * `PersonName` 16 (a requester, spec §6.17).
   */
  meta?: string | (string | { label: string; tone: "warn" } | { person: PersonLike })[];
  /** A mono state label with its color. */
  state?: { label: string; tone: "ok" | "warn" | "fail" | "muted" };
  /** A short mono text at the right (last use). */
  trailing?: string;
  /**
   * The row's most common action, always a secondary (`default`) button or link: the page head
   * holds the one primary of the screen (spec §6.17); urgency is the row's `state`.
   */
  action?: { label: string; href?: string; onSelect?(): void; loading?: boolean };
  menu?: MenuItem[];
  /**
   * An action of the row is running (spec §6.17): every button of the row is disabled until it
   * settles, and the menu button (or the menu's lone item drawn as a button) shows the spinner
   * unless the row action's own `loading` does.
   */
  busy?: boolean;
};

/** A button or link at the row's right: the row action, or a menu's lone item. */
type RowButton = { label: string; href?: string; onSelect?(): void; loading?: boolean };

/** What the list's one action sheet shows for the chosen row. */
type SheetContent = { title: string; items: MenuItem[] };
/**
 * The list's one action sheet (spec §6.17 "Grouped list", §6.61): a row chooses it with its
 * content and keeps it current while chosen; the list draws one sheet for all its rows.
 */
type SheetHost = {
  chosen: string | null;
  choose(key: string, content: SheetContent): void;
  /** The chosen row's content changed (an action started or stopped running). */
  update(key: string, content: SheetContent): void;
  /** The row went away: a sheet it chose closes. */
  release(key: string): void;
};
const SheetHostContext = createContext<SheetHost | null>(null);

/** What a sheet's content draws, to tell a real change from a re-render. */
const sheetSignature = ({ title, items }: SheetContent) =>
  JSON.stringify([
    title,
    items.map((i) => (i === "separator" ? i : [i.label, i.href, i.disabled, i.danger])),
  ]);

/** Skeleton rows an object list shows while it loads (spec §6.17). */
const SKELETON_ROWS = 3;

/**
 * The panel of an object list: rows split by `line-soft` (spec §6.17). `loading` (true, or a row
 * count) draws skeleton rows in the row's shape instead of the children (a mark box and a name and
 * a description line, in the one bar look of spec §6.29), and marks the list busy. Inside a skeleton
 * group the group announces. A list with more pages (`onLoadMore`, `hasMore`, `loadingMore`,
 * `loadMoreError`; {@link ListMoreProps}) reads the next one as its end comes into view below 600
 * (a skeleton row, then the rows; a failure with Retry in the card) and draws Load more under it
 * from 600 up.
 */
export function ObjectList({
  label,
  loading,
  children,
  ...more
}: {
  label: string;
  loading?: boolean | number;
  children?: ReactNode;
} & ListMoreProps) {
  const t = useDesignT();
  const announces = useSkeletonAnnounces();
  const form = useClassForm();
  const [sheet, setSheet] = useState<({ key: string } & SheetContent) | null>(null);
  const host: SheetHost = {
    chosen: sheet?.key ?? null,
    choose: (key, content) => setSheet({ key, ...content }),
    update: (key, content) =>
      setSheet((cur) =>
        cur?.key === key && sheetSignature(cur) !== sheetSignature(content)
          ? { key, ...content }
          : cur,
      ),
    release: (key) => setSheet((cur) => (cur?.key === key ? null : cur)),
  };
  if (loading === undefined || loading === false) {
    return (
      <SheetHostContext.Provider value={host}>
        <ul
          className="cb-object-list"
          aria-label={label}
          aria-busy={more.loadingMore === true ? true : undefined}
        >
          <BoxScope kind="object-list">{children}</BoxScope>
          <ListEnd more={more} skeleton={<SkeletonRow end />} />
        </ul>
        <ListMoreButton more={more} />
        {form === "compact" || sheet !== null ? (
          // One sheet for the list, beside it: mounted while a row is chosen, so leaving compact
          // with the sheet up does not drop it.
          <ActionSheet
            open={sheet !== null}
            onOpenChange={(o) => {
              if (!o) setSheet(null);
            }}
            title={sheet?.title ?? t("overlay.actions")}
            items={sheet?.items ?? []}
          />
        ) : null}
      </SheetHostContext.Provider>
    );
  }
  const rows = loading === true ? SKELETON_ROWS : loading;
  return (
    <ul className="cb-object-list" aria-label={label} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow
          // biome-ignore lint/suspicious/noArrayIndexKey: the skeleton rows are positional
          key={i}
          announce={i === 0 && announces ? t("table.loading") : undefined}
        />
      ))}
    </ul>
  );
}

/**
 * A skeleton row in the row's shape; `end`: the row a list with more pages shows at its end while
 * the next page loads (hidden from assistive tech: the end's status announces).
 */
function SkeletonRow({ announce, end }: { announce?: string | undefined; end?: boolean }) {
  return (
    <li
      className="cb-object-row"
      data-part="object-row"
      data-skeleton="true"
      data-end={end ? "skeleton" : undefined}
      aria-hidden={end ? true : undefined}
    >
      {/* the loaded row's mark place (same part, same box), holding the mark placeholder */}
      <span className="cb-object-mark" data-part="object-row-mark" data-skeleton="true">
        <SkeletonBox part="mark" />
      </span>
      <span className="cb-object-text">
        <SkeletonText width="30%" />
        <SkeletonText width="55%" />
      </span>
      {announce ? <span className="cb-sr-only">{announce}</span> : null}
    </li>
  );
}

/** One object of an object list: mark, name and chips, description, meta, state, action, menu. */
export function ObjectRow({
  mark,
  name,
  href,
  mono,
  chips,
  description,
  meta,
  state,
  trailing,
  action,
  menu,
  busy,
}: ObjectRowProps) {
  const Link = useDesignLink();
  const t = useDesignT();
  // No menu of one (spec §6.7): a lone safe item is drawn as a second row action; a lone
  // destructive one stays in the menu; none, no menu.
  const actions = menuActions(menu ?? []);
  const lone = menuLone(menu ?? []);
  const actionLoading = action?.loading === true;
  const waiting = busy === true || actionLoading;
  // The spinner goes where the running action is: the row action, else the menu (or its lone item)
  const menuLoading = busy === true && !actionLoading;
  const single: RowButton | undefined = lone && {
    label: lone.label,
    ...(menuLoading ? { loading: true } : {}),
    ...(lone.href !== undefined ? { href: lone.href } : {}),
    ...(lone.onSelect ? { onSelect: lone.onSelect } : {}),
  };
  const slots: (RowButton | undefined)[] = [action, single];
  const hasMeta = meta !== undefined && meta.length > 0;

  // Compact (spec §6.17 "Grouped list", responsive system spec §2.3): a row with a link draws no
  // button and offers its action and menu in the sheet; a row without one keeps its one button
  // (the action, else the lone menu item) and offers the rest of its menu there. A running action
  // makes every item wait, as the wide buttons do.
  const compactButton = href === undefined ? (action ?? single) : undefined;
  const listed: MenuItem[] =
    href !== undefined
      ? actionSheetItems({ ...(action ? { primary: action } : {}), items: menu ?? [] })
      : action === undefined && single !== undefined
        ? []
        : actionSheetItems({ items: menu ?? [] });
  const sheetItems = waiting
    ? listed.map((i) => (i === "separator" ? i : { ...i, disabled: true }))
    : listed;
  // A row that opens nothing keeps a labelled ⋯ whenever its sheet has items (beside its one
  // button, if any), so its menu is reachable without a gesture.
  const compactMenu = href === undefined && sheetItems.length > 0;
  const pressRow = href !== undefined || sheetItems.length > 0;
  const form = useClassForm();
  const host = useContext(SheetHostContext);
  const rowKey = useId();
  const [ownSheetOpen, setOwnSheetOpen] = useState(false);
  const pressable = form === "compact" && sheetItems.length > 0;
  // The list's sheet runs the row's latest actions, whatever render chose it.
  const latestItems = useRef(sheetItems);
  latestItems.current = sheetItems;
  const hosted = (): SheetContent => ({
    title: name,
    items: sheetItems.map((i, n) =>
      i === "separator" || !i.onSelect
        ? i
        : {
            ...i,
            onSelect: () => {
              const now = latestItems.current[n];
              if (now !== undefined && now !== "separator") now.onSelect?.();
            },
          },
    ),
  });
  const chosen = host !== null && host.chosen === rowKey;
  const signature = sheetSignature({ title: name, items: sheetItems });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature stands for the content
  useLayoutEffect(() => {
    if (chosen) host?.update(rowKey, hosted());
  }, [chosen, signature]);
  const hostRef = useRef(host);
  hostRef.current = host;
  useLayoutEffect(
    () => () => {
      hostRef.current?.release(rowKey);
    },
    [rowKey],
  );
  const openSheet = () => {
    if (host !== null) host.choose(rowKey, hosted());
    else setOwnSheetOpen(true);
  };
  const press = useLongPress(openSheet, { enabled: pressable });
  const button = (a: RowButton, i: number) =>
    a.href !== undefined ? (
      <LinkButton key={i} href={a.href} variant="default" density="dense">
        {a.label}
      </LinkButton>
    ) : (
      <Button
        key={i}
        variant="default"
        density="dense"
        loading={a.loading === true}
        disabled={waiting}
        {...(a.onSelect ? { onClick: a.onSelect } : {})}
      >
        {a.label}
      </Button>
    );
  return (
    <>
      <li
        className="cb-object-row"
        data-part="object-row"
        data-open={href !== undefined ? "true" : undefined}
        data-press={pressRow ? "true" : undefined}
        {...press}
      >
        {mark.avatar !== undefined ? (
          <span
            className="cb-object-mark"
            data-part="object-row-mark"
            data-kind="avatar"
            aria-hidden="true"
          >
            <Avatar value={mark.avatar} name={mark.text ?? name} size={28} />
          </span>
        ) : (
          <span
            className="cb-object-mark"
            data-part="object-row-mark"
            data-tone={mark.tone ?? "neutral"}
            data-kind={mark.image ? "image" : undefined}
            aria-hidden="true"
          >
            {mark.icon ? (
              <Icon name={mark.icon} size={16} />
            ) : (
              <MarkImage
                {...(mark.image ? { src: mark.image } : {})}
                text={mark.text ?? ""}
                size={24}
              />
            )}
          </span>
        )}
        <span className="cb-object-text">
          <span className="cb-object-line">
            {href ? (
              <Link href={href} className="cb-object-name" data-mono={mono ? "true" : undefined}>
                {name}
                <LinkPendingMark />
              </Link>
            ) : (
              <span className="cb-object-name" data-mono={mono ? "true" : undefined}>
                {name}
              </span>
            )}
            {chips?.map((c) => (
              <span key={c.label} className="cb-object-chip" data-tone={c.tone ?? "neutral"}>
                {c.label}
              </span>
            ))}
          </span>
          {description ? <span className="cb-object-desc">{description}</span> : null}
          {hasMeta || state ? (
            // Below 600 the state is drawn at the end of this line (spec §4.3, §6.17): the CSS reads
            // it from `data-state` / `data-state-tone`, so the label stays one node in the DOM (the
            // row's own state label, hidden on phones). A row with a state and no meta keeps an
            // empty meta line for it, drawn only on phones.
            <span
              className="cb-object-meta"
              data-empty={hasMeta ? undefined : "true"}
              data-state={state?.label}
              data-state-tone={state?.tone}
            >
              {hasMeta && meta !== undefined ? (
                <span className="cb-object-meta-text">
                  {typeof meta === "string"
                    ? meta
                    : meta.map((m, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional
                        <Fragment key={i}>
                          {i > 0 ? " · " : null}
                          {typeof m === "string" ? (
                            m
                          ) : "person" in m ? (
                            <span className="cb-object-meta-person" data-part="object-row-person">
                              <PersonName
                                name={m.person.name}
                                avatarUrl={m.person.avatarUrl}
                                initialFrom={m.person.initialFrom}
                                size={16}
                              />
                            </span>
                          ) : (
                            <span className="cb-object-meta-part" data-tone={m.tone}>
                              {m.label}
                            </span>
                          )}
                        </Fragment>
                      ))}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        {state ? (
          <span className="cb-object-state" data-tone={state.tone}>
            {state.label}
          </span>
        ) : null}
        {trailing ? <span className="cb-object-trailing">{trailing}</span> : null}
        {href === undefined ? null : (
          <span className="cb-object-chevron" data-part="object-row-chevron" aria-hidden="true">
            <Icon name="chevron-right" size={16} />
          </span>
        )}
        {/* Interaction differs per class (spec §6.64): buttons from 600, the action sheet below. */}
        <ClassForms
          compact={
            <>
              {compactButton !== undefined ? (
                <span className="cb-object-actions">{button(compactButton, 0)}</span>
              ) : null}
              {compactMenu ? (
                <IconButton
                  label={rowActionsLabel(t, name)}
                  icon={
                    menuLoading ? (
                      <span className="cb-btn-spin" aria-hidden="true">
                        <Icon name="spinner" size={14} />
                      </span>
                    ) : (
                      <Icon name="more-horizontal" />
                    )
                  }
                  density="dense"
                  variant="default"
                  className="cb-object-menu"
                  disabled={waiting}
                  aria-busy={menuLoading ? true : undefined}
                  onClick={openSheet}
                />
              ) : null}
            </>
          }
          wide={
            <>
              {action || single ? (
                // The row's buttons in one group (`display: contents`: the row lays them out).
                <span className="cb-object-actions">
                  {slots.map((a, i) => (a === undefined ? null : button(a, i)))}
                </span>
              ) : null}
              {actions.length > 0 && lone === undefined ? (
                <Menu
                  items={menu ?? []}
                  trigger={
                    <IconButton
                      label={t("shell.moreActions")}
                      icon={
                        menuLoading ? (
                          <span className="cb-btn-spin" aria-hidden="true">
                            <Icon name="spinner" size={14} />
                          </span>
                        ) : (
                          <Icon name="more-horizontal" />
                        )
                      }
                      density="dense"
                      variant="default"
                      className="cb-object-menu"
                      disabled={waiting}
                      aria-busy={menuLoading ? true : undefined}
                    />
                  }
                />
              ) : null}
            </>
          }
        />
      </li>
      {host === null && (pressable || ownSheetOpen) ? (
        // Beside the row, not inside it: the sheet's own presses never reach the row's long press.
        <ActionSheet
          open={ownSheetOpen}
          onOpenChange={setOwnSheetOpen}
          title={name}
          items={sheetItems}
        />
      ) : null}
    </>
  );
}
