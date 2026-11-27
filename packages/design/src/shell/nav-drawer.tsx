import { useEffect, useState } from "react";
import { Avatar } from "../display/avatar";
import { EmptyState } from "../display/empty-state";
import type { NavBadge } from "../display/nav-badge";
import { NavRow } from "../display/nav-row";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { Drawer, DrawerLevel } from "../overlays/drawer";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";
import { AccountSheet, type AccountSheetData } from "./account-sheet";
import {
  ConversationList,
  type ConversationListActions,
  type ConversationListItem,
} from "./conversation-list";

/** The drawer's recent conversations (design spec §6.54): the newest first, by time. */
export interface DrawerRecent {
  state: "loading" | "ready" | "error";
  /** The newest conversations, at most `DRAWER_RECENT_MAX` of them are drawn. */
  items: ConversationListItem[];
  /** The open conversation (its row is current). */
  activeId?: string;
  onRetry(): void;
  /** A pull down in a native shell reads the list again (interaction spec §3). */
  onRefresh?: () => Promise<unknown>;
  /** A row's long press or right click: rename, archive, delete. */
  actions?: ConversationListActions;
}

/** How many recent conversations the drawer lists (the rest are on the conversations page). */
export const DRAWER_RECENT_MAX = 20;

/** The drawer's section entries (mobile layout spec §4.2). */
export type DrawerSectionId = "inbox" | "agents" | "automations";

/** What the chat-first compact shell's drawer holds (design spec §6.54). */
export interface DrawerNavData {
  /** The sections in order (a guest has no automations); `badge` is the pending inbox count. */
  sections: {
    id: DrawerSectionId;
    label: string;
    href: string;
    icon: IconName;
    badge?: NavBadge;
  }[];
  /** The second level's entries: Skills, Connectors, Devices and the org's extension pages. */
  more: { id: string; label: string; href: string; icon: IconName }[];
  /** The row that opens the second level: "Skills, connectors, devices…". */
  moreLabel: string;
  /** The recent conversations, by time (not grouped by agent). */
  recent: DrawerRecent;
  /** The conversations page: the recent section's All link goes there. */
  allConversations: { label: string; href: string };
  newConversation: { label: string; href: string };
  /**
   * Opens the command palette; absent: no search row. The AppShell supplies its own palette's
   * whenever it has commands, so an app passes none.
   */
  onSearch?: () => void;
  account: AccountSheetData;
  /** The pending inbox count on the menu button. */
  menuBadge?: NavBadge;
}

export type NavDrawerProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  data: DrawerNavData;
  /** The route, for the current section row. */
  pathname?: string | undefined;
  /**
   * Client navigation for a pick (the shell's `onNavigate`): a pick then pops the drawer's history
   * entry before it navigates (Drawer's `onNavigate`).
   */
  onNavigate?: ((href: string) => void) | undefined;
};

const under = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/**
 * The chat-first compact shell's drawer (design spec §6.54): at the top the search field and the
 * New conversation button, then the navigation as one grouped card (Inbox with the pending count,
 * Agents, Automations, and More, which opens the "Skills, connectors, devices…" level, Decision 18), the recent
 * conversations by time under Recent with All (the conversations page), and at the foot the
 * account row, which opens the account sheet (§6.55). A pick closes the drawer; the system back
 * closes the account sheet first, then the drawer (Decision 25). While a native strip shows
 * (`[data-native-nav]`, interaction model §10.2) the entries its pill holds are hidden: the
 * sections (`data-nav-section`), and search, New conversation and the recents (`data-nav-pill`).
 */
export function NavDrawer({ open, onOpenChange, data, pathname, onNavigate }: NavDrawerProps) {
  const t = useDesignT();
  const Link = useDesignLink();
  const [level, setLevel] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  // A closed drawer starts at its list again, with no sheet.
  useEffect(() => {
    if (open) return;
    setLevel(false);
    setAccountOpen(false);
  }, [open]);
  const search = () => {
    onOpenChange(false);
    data.onSearch?.();
  };
  const recent = data.recent;
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      label={t("drawer.label")}
      {...(onNavigate ? { onNavigate } : {})}
    >
      {level ? (
        <div className="cb-navdrawer-level">
          <DrawerLevel
            title={data.moreLabel}
            backLabel={t("drawer.back")}
            onBack={() => setLevel(false)}
          >
            {data.more.map((m) => (
              <NavRow
                key={m.id}
                icon={m.icon}
                label={m.label}
                href={m.href}
                current={pathname !== undefined && under(pathname, m.href)}
              />
            ))}
          </DrawerLevel>
        </div>
      ) : (
        <div className="cb-navdrawer" data-part="nav-drawer">
          <div className="cb-navdrawer-top" data-part="drawer-top">
            {data.onSearch ? (
              <button
                type="button"
                className="cb-navdrawer-search"
                data-part="drawer-search"
                data-nav-pill=""
                onClick={search}
              >
                <Icon name="search" size={16} />
                <span>{t("drawer.search")}</span>
              </button>
            ) : null}
            <Link
              href={data.newConversation.href}
              className="cb-navdrawer-new"
              data-part="drawer-new"
              data-nav-pill=""
              data-drawer-pick="true"
              title={data.newConversation.label}
            >
              <Icon name="square-pen" size={16} />
              <span>{data.newConversation.label}</span>
              <LinkPendingMark />
            </Link>
          </div>
          <nav
            className="cb-navdrawer-card"
            data-part="drawer-nav-card"
            aria-label={t("shell.nav")}
          >
            {data.sections.map((s) => (
              <NavRow
                key={s.id}
                icon={s.icon}
                label={s.label}
                href={s.href}
                current={pathname !== undefined && under(pathname, s.href)}
                data-nav-section={s.id}
                {...(s.badge ? { badge: s.badge } : {})}
              />
            ))}
            {data.more.length > 0 ? (
              <NavRow
                icon="more-horizontal"
                label={t("drawer.moreRow")}
                trailing="chevron"
                onSelect={() => setLevel(true)}
              />
            ) : null}
          </nav>
          <div className="cb-navdrawer-recent" data-part="drawer-recent" data-nav-pill="">
            <div className="cb-navdrawer-recent-head">
              <h2 className="cb-navdrawer-recent-label" data-part="drawer-recent-label">
                {t("drawer.recent")}
              </h2>
              <Link
                href={data.allConversations.href}
                className="cb-navdrawer-recent-all"
                data-part="drawer-recent-all"
                data-drawer-pick="true"
                aria-label={data.allConversations.label}
                aria-current={
                  pathname !== undefined && under(pathname, data.allConversations.href)
                    ? "page"
                    : undefined
                }
              >
                {t("drawer.recentAll")}
                <LinkPendingMark />
              </Link>
            </div>
            <ConversationList
              label={t("drawer.recent")}
              items={recent.items.slice(0, DRAWER_RECENT_MAX)}
              state={recent.state}
              onRetry={recent.onRetry}
              activeId={recent.activeId}
              empty={<EmptyState size="panel" text={t("sidebar.empty")} />}
              {...(recent.actions ? { actions: recent.actions } : {})}
              {...(recent.onRefresh ? { onRefresh: recent.onRefresh } : {})}
            />
          </div>
          <div className="cb-navdrawer-foot" data-part="drawer-foot">
            <button
              type="button"
              className="cb-navdrawer-account"
              data-part="drawer-account"
              aria-haspopup="dialog"
              onClick={() => setAccountOpen(true)}
            >
              <span className="cb-navdrawer-account-avatar">
                <Avatar
                  value={data.account.avatar ?? null}
                  name={data.account.name}
                  size={28}
                  shape="circle"
                />
              </span>
              <span className="cb-account-names">
                <span className="cb-account-name">{data.account.name}</span>
                {data.account.orgName === null ? null : (
                  <span className="cb-account-org">{data.account.orgName}</span>
                )}
              </span>
              <Icon name="chevron-right" size={16} />
            </button>
          </div>
        </div>
      )}
      <AccountSheet
        open={accountOpen}
        onOpenChange={setAccountOpen}
        data={data.account}
        onDone={() => {
          setAccountOpen(false);
          onOpenChange(false);
        }}
      />
    </Drawer>
  );
}
