import * as RD from "@radix-ui/react-dialog";
import {
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "../controls/index";
import { Logo } from "../display/logo";
import { Tooltip } from "../display/tooltip";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { useFocusReturn } from "../overlays/focus-return";
import { Menu, type MenuItem } from "../overlays/index";
import { useDesignLink, useDesignT } from "../provider";
import { SIZES } from "../tokens";
import { type PreferenceBarProps, ThemeToggle } from "./preference-bar";
import { Conversations, type SidebarConversations, useRoving } from "./sidebar-conversations";
import { useHydrated, useMediaQuery } from "./use-media-query";

export {
  type SidebarActivity,
  type SidebarConversation,
  type SidebarConversations,
  type SidebarFilter,
  type SidebarGroup,
  untitledLabel,
} from "./sidebar-conversations";

export type SidebarNavItem = {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  /** Shown as a count (`99+` above 99, `n+` with `countMore`); the accessible name includes it. */
  count?: number;
  countMore?: boolean;
};

/** The current org in the switcher: `~/<slug> · <role>` under its name; `menu` switches it. */
export type SidebarOrg = {
  name: string;
  /** Drawn on `ink` in the 24 box (and alone in the rail). */
  initial: string;
  slug: string;
  role: string;
  /** The user's orgs as radio items, then "Create organization…"; empty = not a button. */
  menu: MenuItem[];
};

/**
 * Which context the sidebar shows (spec §2.1–§2.2 of the web order): the workspace of one org, or
 * the admin console of the whole deployment. The sidebar changes as a whole between them.
 */
export type SidebarContext =
  | {
      kind: "work";
      org: SidebarOrg | null;
      /** After New conversation: Home, Agents. */
      primary: SidebarNavItem[];
      /** The 更多 flyout's fixed items. */
      more: SidebarNavItem[];
      /** Extension pages, in the 更多 flyout after a separator. */
      moreExtensions?: SidebarNavItem[];
      /**
       * The inbox: an icon button in the brand row (a rail icon below 1280), with a count badge
       * only while something is pending; current when `activeNav` is `inbox`.
       */
      inbox?: { href: string; count?: number; countMore?: boolean };
      /** The admin console (enterprise admins): the entry above the account row. */
      adminHref?: string;
    }
  | {
      kind: "admin";
      /** "← Back to workspace ~/<slug>". */
      back: { href: string; slug: string | null };
      items: SidebarNavItem[];
    };

export type SidebarProps = {
  context: SidebarContext;
  /** The "New conversation" item of the work context (label from design i18n). */
  newConversation: { href: string };
  /** The current item's id; "" when a conversation is the current page. */
  activeNav: string;
  /** The work context's conversation section (unused in the admin context). */
  conversations: SidebarConversations;
  /** The account row: the avatar and name open the account menu. */
  account: { name: string; menu: MenuItem[] };
  /**
   * The theme switch, drawn after the account (full sidebar or open drawer); the rail has no room,
   * so there it is the account menu's first item. The language is the caller's account submenu.
   */
  theme?: PreferenceBarProps["theme"];
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
  /** Draw the 更多 flyout open (the reference set and the catalog only). */
  moreOpen?: boolean;
};

const countText = (n: { count?: number; countMore?: boolean }): string =>
  (n.count ?? 0) > 99 ? "99+" : `${n.count ?? 0}${n.countMore ? "+" : ""}`;

type Variant = "full" | "rail" | "panel";

/** The first grapheme of a name, upper-cased (an emoji or a CJK character stays whole). */
export function initialOf(name: string): string {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Segmenter
    ? new Segmenter(undefined, { granularity: "grapheme" }).segment(name)[Symbol.iterator]().next()
        .value?.segment
    : Array.from(name)[0];
  return (first ?? "").toUpperCase();
}

/**
 * The left sidebar (spec §6.13): the brand, the context (the org switcher or the admin block),
 * navigation, the conversations grouped by agent (work context), the admin entry and the account.
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
        onEscapeKeyDown={(e) => {
          // Esc in the rename or filter input belongs to that input, not to the drawer.
          const target = e.target as HTMLElement | null;
          if (target?.closest('[data-part="rename"], [data-part="filter"]')) e.preventDefault();
        }}
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
  const ctx = p.context;
  return (
    <aside
      className="cb-sidebar"
      data-part="sidebar"
      data-mode={rail ? "rail" : "full"}
      data-context={ctx.kind}
      data-responsive={responsive ? "true" : undefined}
    >
      <div className="cb-sidebar-top" data-part="brand-row">
        <Logo scale={2} wordmark={!rail} />
        {rail ? null : (
          <span className="cb-sidebar-top-tools">
            {ctx.kind === "work" ? <BrandTools p={p} rail={false} /> : null}
            {variant === "panel" ? (
              <IconButton
                label={t("sidebar.close")}
                icon={<Icon name="x" />}
                onClick={() => onClose?.()}
              />
            ) : null}
          </span>
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
          {ctx.kind === "work" ? <BrandTools p={p} rail /> : null}
        </div>
      ) : null}
      {ctx.kind === "work" ? (
        ctx.org ? (
          <OrgSwitcher org={ctx.org} rail={rail} />
        ) : null
      ) : (
        <AdminBlock back={ctx.back} rail={rail} />
      )}
      <SidebarNav p={p} rail={rail} />
      {ctx.kind === "work" && !rail ? (
        <Conversations c={p.conversations} newHref={p.newConversation.href} />
      ) : (
        <div className="cb-sidebar-fill" />
      )}
      {ctx.kind === "work" && ctx.adminHref !== undefined ? (
        <AdminEntry href={ctx.adminHref} rail={rail} />
      ) : null}
      <Account
        account={rail ? withTheme(p.account, p.theme) : p.account}
        rail={rail}
        trailing={p.theme && !rail ? <ThemeToggle {...p.theme} /> : null}
      />
    </aside>
  );
}

/**
 * Search (opens the command palette) and the inbox (a link with a count badge while something is
 * pending): icon buttons in the brand row, rail icons at the top of the rail (web order §2.1).
 */
function BrandTools({ p, rail }: { p: SidebarProps; rail: boolean }) {
  const t = useDesignT();
  const Link = useDesignLink();
  const ctx = p.context;
  const inbox = ctx.kind === "work" ? ctx.inbox : undefined;
  const search = `${t("shell.searchShort")} ⌘K`;
  const tip = (key: string, label: string, node: ReactElement) =>
    rail ? (
      <RailTip label={label} open={p.railTooltip === key}>
        {node}
      </RailTip>
    ) : (
      // In the brand row the native title is the tooltip: a Radix Tooltip opened by focus would
      // take the drawer's Escape.
      node
    );
  const pending = inbox && (inbox.count ?? 0) > 0 ? countText(inbox) : null;
  const inboxLabel = t("sidebar.inbox");
  const inboxName =
    pending === null
      ? inboxLabel
      : t("shell.navCount").replace("{label}", inboxLabel).replace("{n}", pending);
  return (
    <>
      {tip(
        "search",
        search,
        <IconButton
          label={search}
          icon={<Icon name="search" />}
          part="search"
          onClick={p.onOpenCommands}
        />,
      )}
      {inbox
        ? tip(
            "inbox",
            inboxLabel,
            <Link
              href={inbox.href}
              className="cb-btn cb-icon-btn cb-sidebar-inbox"
              data-part="inbox"
              data-variant="ghost"
              data-density="default"
              aria-label={inboxName}
              title={inboxName}
              {...(p.activeNav === "inbox" ? { "aria-current": "page" as const } : {})}
            >
              <Icon name="inbox" />
              {pending === null ? null : (
                <span className="cb-sidebar-badge" data-part="inbox-badge" aria-hidden="true">
                  {pending}
                </span>
              )}
            </Link>,
          )
        : null}
    </>
  );
}

/** A rail control with its label in a Tooltip to the right, past the rail's edge. */
function RailTip({
  label,
  open,
  children,
}: {
  label: string;
  open?: boolean;
  children: ReactElement;
}) {
  return (
    // Beside the rail: past its edge by space.1 (the item is inset by space.2).
    <Tooltip content={label} side="right" sideOffset={SIZES.space[3]} {...(open ? { open } : {})}>
      {children}
    </Tooltip>
  );
}

/** The org switcher: a 40 block on `bg`, the initial on `ink`, name and `~/<slug> · <role>`. */
function OrgSwitcher({ org, rail }: { org: SidebarOrg; rail: boolean }) {
  const t = useDesignT();
  const label = t("sidebar.orgSwitch").replace("{org}", org.name);
  const initial = (
    <span className="cb-sidebar-org-initial" data-part="org-initial" aria-hidden="true">
      {org.initial}
    </span>
  );
  const content = rail ? (
    initial
  ) : (
    <>
      {initial}
      <span className="cb-sidebar-org-text">
        <span className="cb-sidebar-org-name">{org.name}</span>
        <span className="cb-sidebar-org-meta">
          ~/{org.slug} · {org.role}
        </span>
      </span>
      {org.menu.length > 0 ? <Icon name="chevrons-up-down" size={14} /> : null}
    </>
  );
  if (org.menu.length === 0) {
    return (
      <div className="cb-sidebar-org" data-part="org-switcher" data-static="true" title={org.name}>
        {content}
      </div>
    );
  }
  const button = (
    <button
      type="button"
      className="cb-sidebar-org"
      data-part="org-switcher"
      aria-label={label}
      // A menu trigger takes no Tooltip: in the rail the name is its title.
      title={org.name}
    >
      {content}
    </button>
  );
  return <Menu items={org.menu} trigger={button} />;
}

/** The admin context block: static, the shield in the accent tint, and the way back. */
function AdminBlock({
  back,
  rail,
}: {
  back: { href: string; slug: string | null };
  rail: boolean;
}) {
  const t = useDesignT();
  const Link = useDesignLink();
  const backLabel = back.slug === null ? t("sidebar.back") : `${t("sidebar.back")} ~/${back.slug}`;
  return (
    <div className="cb-sidebar-context">
      <div className="cb-sidebar-org" data-part="context-block" data-static="true">
        <span className="cb-sidebar-org-initial" data-tone="accent" aria-hidden="true">
          <Icon name="admin" size={14} />
        </span>
        {rail ? (
          <span className="cb-sr-only">{t("sidebar.admin")}</span>
        ) : (
          <span className="cb-sidebar-org-text">
            <span className="cb-sidebar-org-name">{t("sidebar.admin")}</span>
            <span className="cb-sidebar-org-meta">{t("sidebar.adminScope")}</span>
          </span>
        )}
      </div>
      {rail ? (
        <RailTip label={backLabel}>
          <Link
            href={back.href}
            className="cb-sidebar-back"
            data-part="back"
            aria-label={backLabel}
          >
            <Icon name="arrow-left" size={14} />
          </Link>
        </RailTip>
      ) : (
        <Link href={back.href} className="cb-sidebar-back" data-part="back">
          <Icon name="arrow-left" size={14} />
          <span className="cb-sidebar-label">{backLabel}</span>
        </Link>
      )}
    </div>
  );
}

/** The work context's way into the admin console, above the account row. */
function AdminEntry({ href, rail }: { href: string; rail: boolean }) {
  const t = useDesignT();
  const Link = useDesignLink();
  const label = t("sidebar.admin");
  const link = (
    <Link
      href={href}
      className="cb-sidebar-item"
      data-part="admin-entry"
      {...(rail ? { "aria-label": label } : {})}
    >
      <Icon name="admin" />
      {rail ? null : (
        <>
          <span className="cb-sidebar-label">{label}</span>
          <Icon name="arrow-up-right" size={14} />
        </>
      )}
    </Link>
  );
  return (
    <div className="cb-sidebar-admin">{rail ? <RailTip label={label}>{link}</RailTip> : link}</div>
  );
}

function SidebarNav({ p, rail }: { p: SidebarProps; rail: boolean }) {
  const t = useDesignT();
  const Link = useDesignLink();
  const ctx = p.context;
  const work = ctx.kind === "work";
  const primary = work ? ctx.primary : ctx.items;
  const more = work ? ctx.more : [];
  const moreExtensions = work ? (ctx.moreExtensions ?? []) : [];
  const hasMore = work && more.length + moreExtensions.length > 0;
  const activeInMore = [...more, ...moreExtensions].some((n) => n.id === p.activeNav);
  const [moreOpen, setMoreOpen] = useState(p.moreOpen ?? false);
  const keys = [
    ...(work ? ["new"] : []),
    ...primary.map((n) => n.id),
    ...(hasMore ? ["more"] : []),
  ];
  const roving = useRoving(p.activeNav === "" ? undefined : p.activeNav);
  const tip = (key: string, label: string, node: ReactElement) =>
    rail ? (
      <RailTip key={key} label={label} open={p.railTooltip === key}>
        {node}
      </RailTip>
    ) : (
      node
    );
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
        <Icon name={n.icon} size={16} />
        {rail ? null : <span className="cb-sidebar-label">{n.label}</span>}
        {count === null ? null : rail ? (
          <span className="cb-sidebar-badge" data-part="rail-badge" aria-hidden="true">
            {count}
          </span>
        ) : (
          <span className="cb-sidebar-count" data-part="nav-count" aria-hidden="true">
            {count}
          </span>
        )}
      </Link>
    );
    return tip(key, n.label, link);
  };
  const moreLabel = t("sidebar.moreGroup");
  const toMenu = (n: SidebarNavItem): MenuItem => ({
    label: n.label,
    href: n.href,
    ...(n.id === p.activeNav ? { current: true } : {}),
  });
  const moreItems: MenuItem[] = [
    ...more.map(toMenu),
    ...(more.length > 0 && moreExtensions.length > 0 ? ["separator" as const] : []),
    ...moreExtensions.map(toMenu),
  ];
  // 更多 opens a flyout to the right of the sidebar (Enter / Space / → open it, Escape closes it
  // and returns focus); it is active while the current page is one of its items.
  const moreTrigger = (
    <button
      type="button"
      className="cb-sidebar-item"
      data-part="more-toggle"
      data-rove="more"
      data-active={activeInMore ? "true" : undefined}
      tabIndex={roving.tabIndexOf("more", keys)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setMoreOpen(true);
        }
      }}
      {...(rail ? { "aria-label": moreLabel, title: moreLabel } : {})}
    >
      <Icon name="more-horizontal" />
      {rail ? null : (
        <>
          <span className="cb-sidebar-label">{moreLabel}</span>
          <Icon name="chevron-right" size={12} />
        </>
      )}
    </button>
  );
  return (
    <nav
      className="cb-sidebar-nav"
      aria-label={t("shell.nav")}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      {work
        ? item(
            "new",
            { label: t("sidebar.new"), href: p.newConversation.href, icon: "plus" },
            "new-conversation",
          )
        : null}
      {primary.map((n) => item(n.id, n))}
      {hasMore ? (
        <Menu
          key="more"
          items={moreItems}
          side="right"
          sideOffset={SIZES.space[3]}
          label={moreLabel}
          open={moreOpen}
          onOpenChange={setMoreOpen}
          // Drawn open for the reference set: it must not lock the rest of the page.
          {...(p.moreOpen ? { modal: false } : {})}
          trigger={moreTrigger}
        />
      ) : null}
    </nav>
  );
}

/** The rail's account menu: the theme switch as its first item. */
function withTheme(
  account: SidebarProps["account"],
  theme: PreferenceBarProps["theme"] | undefined,
): SidebarProps["account"] {
  if (!theme || account.menu.length === 0) return account;
  const item: MenuItem =
    theme.value === "dark"
      ? { label: `${theme.label}: ${theme.lightLabel}`, onSelect: () => theme.onChange("light") }
      : { label: `${theme.label}: ${theme.darkLabel}`, onSelect: () => theme.onChange("dark") };
  return { ...account, menu: [item, "separator", ...account.menu] };
}

function Account({
  account,
  rail,
  trailing,
}: {
  account: SidebarProps["account"];
  rail: boolean;
  trailing?: ReactNode;
}) {
  const t = useDesignT();
  const text = account.name;
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
        {trailing}
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
      {trailing}
    </div>
  );
}
