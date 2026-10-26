import * as RD from "@radix-ui/react-dialog";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "../controls/index";
import { Logo } from "../display/logo";
import { Tooltip } from "../display/tooltip";
import { type Locale, messages } from "../i18n";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { useFocusReturn } from "../overlays/focus-return";
import { Menu, type MenuItem } from "../overlays/index";
import { useDesignLink, useDesignLocale, useDesignT } from "../provider";
import { SIZES } from "../tokens";
import { useHydrated, useMediaQuery } from "./use-media-query";

export type SidebarNavItem = {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  /** Shown as a count (`99+` above 99, `n+` with `countMore`); the accessible name includes it. */
  count?: number;
  countMore?: boolean;
};

export type SidebarConversation = {
  id: string;
  /** null until the conversation has a title: shown as `untitledLabel(startedAt)`. */
  title: string | null;
  startedAt: Date;
  href: string;
};

export type SidebarGroup = {
  agentId: string;
  agentName: string;
  conversations: SidebarConversation[];
  /** The group has more conversations than it shows: a "More" row calls `onMore`. */
  more: boolean;
  onMore(): void;
  /** The group's ＋: a new conversation with this agent. */
  onNew(): void;
};

export type SidebarProps = {
  /** The "New conversation" item (label from design i18n). */
  newConversation: { href: string };
  /** Top-level navigation, Overview … Evals, already filtered by role. */
  nav: SidebarNavItem[];
  /** The current nav item's id; "" when a conversation is the current page. */
  activeNav: string;
  /** Extension pages; the Extensions group shows only when there are any. */
  extensions?: { id: string; label: string; href: string }[];
  /** Settings, Admin (already filtered by role). */
  footerNav: SidebarNavItem[];
  conversations: {
    state: "loading" | "ready" | "error";
    groups: SidebarGroup[];
    activeId?: string;
    /** More groups than shown: a "More groups" row calls `onMoreGroups`. */
    moreGroups: boolean;
    onMoreGroups(): void;
    onRetry(): void;
    /**
     * Collapsed groups to start with, used instead of the viewer's remembered ones (the
     * reference set and the catalog only).
     */
    collapsed?: string[];
    /**
     * Whose groups these are (the org id): the remembered collapsed groups are kept per scope, so
     * pruning in one org never drops another org's. Without it one list per browser.
     */
    scope?: string;
  };
  /** The account footer: menu = org switch, language, theme, sign out. */
  account: { name: string; org: string | null; menu: MenuItem[] };
  onOpenCommands(): void;
  /** Default from media queries: below 1280 `rail`, below 960 `drawer`. */
  mode?: "full" | "rail" | "drawer";
  /**
   * The drawer's open state (rail and drawer modes). AppShell controls it from its menu button;
   * without it the sidebar keeps its own (the rail's expand button opens it).
   */
  drawer?: { open: boolean; onOpenChange(open: boolean): void };
  /**
   * Draw the open drawer inside the nearest positioned box instead of as a modal over the page
   * (the reference set and the catalog only).
   */
  drawerInline?: boolean;
  /** The rail item whose tooltip is drawn open (the reference set and the catalog only). */
  railTooltip?: string;
};

/** `未命名会话 · MM-DD HH:mm` / `Untitled conversation · MM-DD HH:mm`, in local time. */
export function untitledLabel(startedAt: Date, locale: Locale): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const when = `${p(startedAt.getMonth() + 1)}-${p(startedAt.getDate())} ${p(startedAt.getHours())}:${p(startedAt.getMinutes())}`;
  return `${messages[locale]["sidebar.untitled"]} · ${when}`;
}

const COLLAPSED_KEY = "cap.sidebar.collapsed";
/** At most this many remembered collapsed groups (the most recent toggles). */
const COLLAPSED_CAP = 100;

/**
 * The collapsed groups, per viewer and scope (org) in localStorage. The stored set is read in a
 * layout effect, so it applies before the first paint, and read again when the scope changes;
 * storage errors mean "all expanded". `known` is the full list of agent ids when every group is
 * loaded (stale ids are then pruned, within this scope only), else null.
 */
function useCollapsed(
  initial: string[] | undefined,
  known: string[] | null,
  scope: string | undefined,
): [Set<string>, (agentId: string) => void] {
  const key = scope === undefined ? COLLAPSED_KEY : `${COLLAPSED_KEY}.${scope}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(initial));
  const knownRef = useRef(known);
  knownRef.current = known;
  const dirty = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read on mount and per scope
  useLayoutEffect(() => {
    if (initial) return;
    dirty.current = false;
    try {
      const raw = localStorage.getItem(key);
      const ids: unknown = raw ? JSON.parse(raw) : [];
      setCollapsed(
        new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []),
      );
    } catch {
      // Storage blocked or malformed: render expanded.
      setCollapsed(new Set());
    }
  }, [key]);
  // The write happens after a toggle commits, never inside the state updater.
  useEffect(() => {
    if (!dirty.current) return;
    dirty.current = false;
    const k = knownRef.current;
    const ids = [...collapsed].filter((id) => k === null || k.includes(id)).slice(-COLLAPSED_CAP);
    try {
      localStorage.setItem(key, JSON.stringify(ids));
    } catch {
      // Not remembered; the toggle still applies.
    }
  }, [collapsed, key]);
  const toggle = useCallback((agentId: string) => {
    dirty.current = true;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

/**
 * One roving tab stop for a list (spec §6.11): items carry `data-rove="<key>"`; the item whose
 * key is `stop` (else `fallback`, else the first) has tabIndex 0, the others -1. ↑ / ↓ / Home /
 * End move focus between items; focusing an item makes it the stop.
 */
function useRoving(fallback: string | undefined) {
  const [stop, setStop] = useState<string | null>(null);
  const tabIndexOf = (key: string, keys: readonly string[]) => {
    const current = stop !== null && keys.includes(stop) ? stop : fallback;
    const holder = current !== undefined && keys.includes(current) ? current : keys[0];
    return key === holder ? 0 : -1;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>("[data-rove]:not([inert] *)"),
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    const to =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : Math.min(items.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    items[to]?.focus();
  };
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const key = (e.target as HTMLElement).getAttribute("data-rove");
    if (key !== null) setStop(key);
  };
  return { tabIndexOf, onKeyDown, onFocus };
}

const countText = (n: { count?: number; countMore?: boolean }): string =>
  (n.count ?? 0) > 99 ? "99+" : `${n.count ?? 0}${n.countMore ? "+" : ""}`;

type Variant = "full" | "rail" | "panel";

/** Loading: three groups of skeleton bars (widths in %), as the reference set draws them. */
const SKELETON = [
  [64, 88, 72],
  [56, 80],
  [60, 76],
] as const;

/** The first grapheme of a name, upper-cased (an emoji or a CJK character stays whole). */
function initialOf(name: string): string {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Segmenter
    ? new Segmenter(undefined, { granularity: "grapheme" }).segment(name)[Symbol.iterator]().next()
        .value?.segment
    : Array.from(name)[0];
  return (first ?? "").toUpperCase();
}

/**
 * The left sidebar (spec §6.13): navigation, conversations grouped by agent, the account.
 *
 * Without `mode` the variant follows the window width. The server render and the first hydration
 * draw both the full and the rail panel (`data-responsive`) and CSS media queries show one, so the
 * first paint is right at every width; after hydration only the matching variant is rendered.
 */
export function Sidebar(p: SidebarProps) {
  const hydrated = useHydrated();
  const rail = useMediaQuery("(max-width: 1279px)");
  const narrow = useMediaQuery("(max-width: 959px)");
  const responsive = p.mode === undefined && !hydrated;
  const mode = p.mode ?? (narrow ? "drawer" : rail ? "rail" : "full");
  const [ownOpen, setOwnOpen] = useState(false);
  const open = p.drawer?.open ?? ownOpen;
  const setOpen = (o: boolean) => {
    if (p.drawer) p.drawer.onOpenChange(o);
    else setOwnOpen(o);
  };

  // A route change (another nav item or conversation becomes current) closes the drawer.
  const route = `${p.activeNav}|${p.conversations.activeId ?? ""}`;
  const lastRoute = useRef(route);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on route changes only
  useEffect(() => {
    if (lastRoute.current === route) return;
    lastRoute.current = route;
    if (p.drawer) {
      if (p.drawer.open) p.drawer.onOpenChange(false);
    } else setOwnOpen(false);
  }, [route]);

  const drawer =
    mode === "full" || responsive ? null : (
      <RD.Root open={open} onOpenChange={setOpen} modal={!p.drawerInline}>
        {p.drawerInline ? (
          open ? (
            <DrawerLayer p={p} inline onClose={() => setOpen(false)} />
          ) : null
        ) : (
          <RD.Portal>
            <DrawerLayer p={p} onClose={() => setOpen(false)} />
          </RD.Portal>
        )}
      </RD.Root>
    );

  // Fixed slots (full, rail, drawer), so the panel that stays keeps its state after hydration.
  return (
    <>
      {responsive || mode === "full" ? (
        <SidebarPanel p={p} variant="full" responsive={responsive} />
      ) : null}
      {responsive || mode === "rail" ? (
        <SidebarPanel p={p} variant="rail" responsive={responsive} onExpand={() => setOpen(true)} />
      ) : null}
      {drawer}
    </>
  );
}

function DrawerLayer({
  p,
  inline,
  onClose,
}: {
  p: SidebarProps;
  inline?: boolean;
  onClose(): void;
}) {
  const t = useDesignT();
  // The opener (AppShell's menu button, the rail's expand button) is not a Radix trigger.
  const focusReturn = useFocusReturn();
  return (
    <div className="cb-sidebar-layer" data-inline={inline ? "true" : undefined}>
      <div className="cb-sidebar-scrim" aria-hidden="true" onClick={onClose} />
      <RD.Content
        className="cb-sidebar-drawer"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          // Drawn in place (reference set): nothing to move focus into.
          if (inline) e.preventDefault();
          else focusReturn.capture();
        }}
        onCloseAutoFocus={focusReturn.restore}
        onClick={(e: MouseEvent<HTMLElement>) => {
          // Following a link closes the drawer (the route changes).
          if ((e.target as HTMLElement).closest("a[href]")) onClose();
        }}
      >
        <RD.Title className="cb-sr-only">{t("shell.nav")}</RD.Title>
        <SidebarPanel p={p} variant="panel" onClose={onClose} />
      </RD.Content>
    </div>
  );
}

function SidebarPanel({
  p,
  variant,
  responsive,
  onExpand,
  onClose,
}: {
  p: SidebarProps;
  variant: Variant;
  /** Drawn before hydration next to the other variant; CSS media queries pick one. */
  responsive?: boolean;
  onExpand?: () => void;
  onClose?: () => void;
}) {
  const t = useDesignT();
  const rail = variant === "rail";
  const search = `${t("shell.searchShort")} ⌘K`;
  return (
    <aside
      className="cb-sidebar"
      data-part="sidebar"
      data-mode={rail ? "rail" : "full"}
      data-responsive={responsive ? "true" : undefined}
    >
      <div className="cb-sidebar-top">
        <Logo scale={2} wordmark={!rail} />
        {rail ? null : variant === "panel" ? (
          <IconButton
            label={t("sidebar.close")}
            icon={<Icon name="x" />}
            onClick={() => onClose?.()}
          />
        ) : (
          <IconButton label={search} icon={<Icon name="search" />} onClick={p.onOpenCommands} />
        )}
      </div>
      {rail ? (
        <div className="cb-sidebar-rail-tools">
          <Tooltip content={t("sidebar.expand")}>
            <IconButton
              label={t("sidebar.expand")}
              icon={<Icon name="panel-left" />}
              onClick={() => onExpand?.()}
            />
          </Tooltip>
          <Tooltip content={search}>
            <IconButton label={search} icon={<Icon name="search" />} onClick={p.onOpenCommands} />
          </Tooltip>
        </div>
      ) : null}
      <SidebarNav p={p} rail={rail} />
      {rail ? <div className="cb-sidebar-fill" /> : <Conversations p={p} />}
      <Account account={p.account} rail={rail} />
    </aside>
  );
}

function SidebarNav({ p, rail }: { p: SidebarProps; rail: boolean }) {
  const t = useDesignT();
  const Link = useDesignLink();
  const extensions = p.extensions ?? [];
  const keys = [
    "new",
    ...p.nav.map((n) => n.id),
    ...extensions.map((x) => `ext:${x.id}`),
    ...p.footerNav.map((n) => n.id),
  ];
  const roving = useRoving(p.activeNav === "" ? undefined : p.activeNav);
  const item = (
    key: string,
    n: { label: string; href: string; icon: IconName; count?: number; countMore?: boolean },
    part: "nav-item" | "new-conversation" = "nav-item",
  ) => {
    const count = n.count ? countText(n) : null;
    const name =
      count === null
        ? undefined
        : t("shell.navCount").replace("{label}", n.label).replace("{n}", count);
    const link = (
      <Link
        key={key}
        href={n.href}
        className="cb-sidebar-item"
        data-part={part}
        data-rove={key}
        tabIndex={roving.tabIndexOf(key, keys)}
        {...(key === p.activeNav ? { "aria-current": "page" as const } : {})}
        {...(rail ? { "aria-label": name ?? n.label } : name ? { "aria-label": name } : {})}
      >
        <Icon name={n.icon} />
        {rail ? null : <span className="cb-sidebar-label">{n.label}</span>}
        {count === null ? null : rail ? (
          <span className="cb-sidebar-badge" data-part="rail-badge" aria-hidden="true">
            {count}
          </span>
        ) : (
          <span className="cb-sidebar-count" aria-hidden="true">
            {count}
          </span>
        )}
      </Link>
    );
    return rail ? (
      // Beside the rail: past its edge by space.1 (the item is inset by space.2).
      <Tooltip
        key={key}
        content={n.label}
        side="right"
        sideOffset={SIZES.space[3]}
        open={p.railTooltip === key}
      >
        {link}
      </Tooltip>
    ) : (
      link
    );
  };
  return (
    <nav
      className="cb-sidebar-nav"
      aria-label={t("shell.nav")}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      {item(
        "new",
        { label: t("sidebar.new"), href: p.newConversation.href, icon: "plus" },
        "new-conversation",
      )}
      {p.nav.map((n) => item(n.id, n))}
      {extensions.length > 0 ? (
        <>
          {rail ? (
            <span className="cb-sidebar-sep" />
          ) : (
            <div className="cb-sidebar-heading">{t("sidebar.extensions")}</div>
          )}
          {extensions.map((x) => item(`ext:${x.id}`, { ...x, icon: "extension" }))}
        </>
      ) : null}
      {p.footerNav.length > 0 ? (
        <>
          <span className={rail ? "cb-sidebar-sep" : "cb-sidebar-gap"} />
          {p.footerNav.map((n) => item(n.id, n))}
        </>
      ) : null}
    </nav>
  );
}

function Conversations({ p }: { p: SidebarProps }) {
  const t = useDesignT();
  const c = p.conversations;
  const known = c.state === "ready" && !c.moreGroups ? c.groups.map((g) => g.agentId) : null;
  const [collapsed, toggleGroup] = useCollapsed(c.collapsed, known, c.scope);
  // Height motion only after the viewer toggles a group: the remembered state applies without it.
  const [motion, setMotion] = useState(false);
  const toggle = (agentId: string) => {
    setMotion(true);
    toggleGroup(agentId);
  };
  const keys: string[] = [];
  if (c.state === "ready") {
    for (const g of c.groups) {
      keys.push(`t:${g.agentId}`, `n:${g.agentId}`);
      if (!collapsed.has(g.agentId)) {
        keys.push(...g.conversations.map((x) => `c:${x.id}`));
        if (g.more) keys.push(`m:${g.agentId}`);
      }
    }
    if (c.moreGroups) keys.push("mg");
  }
  const roving = useRoving(c.activeId === undefined ? undefined : `c:${c.activeId}`);
  const tab = (key: string) => roving.tabIndexOf(key, keys);

  let body: ReactNode;
  if (c.state === "loading") {
    body = (
      <div className="cb-sidebar-loading">
        {SKELETON.map((group, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed skeleton
          <div key={i} className="cb-sidebar-skeleton-group">
            {group.map((w) => (
              <span key={w} className="cb-sidebar-skeleton" data-part="skeleton-bar" data-w={w} />
            ))}
          </div>
        ))}
      </div>
    );
  } else if (c.state === "error") {
    body = (
      <div className="cb-sidebar-error" role="alert">
        <span className="cb-sidebar-error-text">
          <Icon name="circle-alert" size={14} />
          {t("sidebar.loadFailed")}
        </span>
        <span className="cb-sidebar-retry" data-part="retry">
          <Button variant="ghost" density="dense" onClick={c.onRetry}>
            <Icon name="refresh" size={14} />
            {t("sidebar.retry")}
          </Button>
        </span>
      </div>
    );
  } else if (c.groups.length === 0) {
    body = (
      <p className="cb-sidebar-hint" data-part="empty-hint">
        {t("sidebar.empty")}
      </p>
    );
  } else {
    body = (
      <>
        {c.groups.map((g) => (
          <Group
            key={g.agentId}
            g={g}
            activeId={c.activeId}
            collapsed={collapsed.has(g.agentId)}
            onToggle={() => toggle(g.agentId)}
            tab={tab}
          />
        ))}
        {c.moreGroups ? (
          <button
            type="button"
            className="cb-sidebar-more"
            data-part="more"
            data-rove="mg"
            tabIndex={tab("mg")}
            onClick={c.onMoreGroups}
          >
            {t("sidebar.moreGroups")}
          </button>
        ) : null}
      </>
    );
  }
  return (
    <section
      className="cb-sidebar-convs"
      aria-label={t("sidebar.conversations")}
      aria-busy={c.state === "loading" ? true : undefined}
      data-motion={motion ? "on" : undefined}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      {body}
    </section>
  );
}

function Group({
  g,
  activeId,
  collapsed,
  onToggle,
  tab,
}: {
  g: SidebarGroup;
  activeId: string | undefined;
  collapsed: boolean;
  onToggle(): void;
  tab(key: string): number;
}) {
  const t = useDesignT();
  const locale = useDesignLocale();
  const Link = useDesignLink();
  return (
    <div className="cb-sidebar-group">
      <div className="cb-sidebar-group-head">
        <button
          type="button"
          className="cb-sidebar-group-toggle"
          data-part="group-label"
          data-rove={`t:${g.agentId}`}
          tabIndex={tab(`t:${g.agentId}`)}
          aria-expanded={!collapsed}
          title={g.agentName}
          onClick={onToggle}
        >
          <span className="cb-sidebar-label">{g.agentName}</span>
          <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={12} />
        </button>
        <IconButton
          density="dense"
          label={t("sidebar.newWith").replace("{agent}", g.agentName)}
          icon={<Icon name="plus" size={14} />}
          data-rove={`n:${g.agentId}`}
          tabIndex={tab(`n:${g.agentId}`)}
          onClick={g.onNew}
        />
      </div>
      <div
        className="cb-sidebar-group-body"
        data-part="group-body"
        data-collapsed={collapsed ? "true" : undefined}
        inert={collapsed}
        aria-hidden={collapsed ? true : undefined}
      >
        <div className="cb-sidebar-group-rows">
          {g.conversations.map((x) => {
            const text = x.title ?? untitledLabel(x.startedAt, locale);
            return (
              <Link
                key={x.id}
                href={x.href}
                className="cb-sidebar-conv"
                data-part="conversation"
                data-rove={`c:${x.id}`}
                tabIndex={tab(`c:${x.id}`)}
                title={text}
                {...(x.id === activeId ? { "aria-current": "page" as const } : {})}
              >
                <span className="cb-sidebar-label">{text}</span>
              </Link>
            );
          })}
          {g.more ? (
            <button
              type="button"
              className="cb-sidebar-more"
              data-part="more"
              data-rove={`m:${g.agentId}`}
              tabIndex={tab(`m:${g.agentId}`)}
              onClick={g.onMore}
            >
              {t("sidebar.more")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Account({ account, rail }: { account: SidebarProps["account"]; rail: boolean }) {
  const t = useDesignT();
  const text = account.org ? `${account.name} · ${account.org}` : account.name;
  const content = (
    <>
      <span className="cb-sidebar-avatar" data-part="avatar" aria-hidden="true">
        {initialOf(account.name)}
      </span>
      {rail ? null : <span className="cb-sidebar-label">{text}</span>}
    </>
  );
  // Without menu items (the session is loading) nothing opens, so it is not a button.
  if (account.menu.length === 0) {
    return (
      <div className="cb-sidebar-foot">
        <span className="cb-sidebar-account" data-part="account" data-static="true" title={text}>
          {content}
        </span>
      </div>
    );
  }
  return (
    <div className="cb-sidebar-foot">
      <Menu
        items={account.menu}
        trigger={
          <button
            type="button"
            className="cb-sidebar-account"
            data-part="account"
            aria-label={`${t("shell.account")}: ${text}`}
            title={text}
          >
            {content}
          </button>
        }
      />
    </div>
  );
}
