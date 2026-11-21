import { useEffect, useState } from "react";
import { Avatar } from "../display/avatar";
import type { NavBadge } from "../display/nav-badge";
import { NavRow } from "../display/nav-row";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { Drawer, DrawerLevel } from "../overlays/drawer";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";
import { AccountSheet, type AccountSheetData } from "./account-sheet";
import { Conversations, type SidebarConversations } from "./sidebar-conversations";

/** The drawer's section entries (mobile layout spec §4.2). */
export type DrawerSectionId = "inbox" | "agents" | "schedules";

/** What the chat-first compact shell's drawer holds (design spec §6.53). */
export interface DrawerNavData {
  /** The sections in order (a guest has no schedules); `badge` is the pending inbox count. */
  sections: {
    id: DrawerSectionId;
    label: string;
    href: string;
    icon: IconName;
    badge?: NavBadge;
  }[];
  /** The second level's entries: 技能, 连接器, 设备 and the org's extension pages. */
  more: { id: string; label: string; href: string; icon: IconName }[];
  /** The row that opens the second level: 「技能、连接器、设备…」. */
  moreLabel: string;
  /** The sidebar's conversation section. */
  recent: SidebarConversations;
  allConversations: { label: string; href: string };
  newConversation: { label: string; href: string };
  /** Opens the command palette. */
  onSearch(): void;
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
 * The chat-first compact shell's drawer (design spec §6.53): search, the section entries with the
 * inbox count, the 「技能、连接器、设备…」 row that opens a second level (Decision 18), the recent
 * conversations with 「全部会话」, and at the foot the account row (it opens the account sheet,
 * §6.54) and the new-conversation button. A pick closes the drawer; the system back closes the
 * account sheet first, then the drawer (Decision 25).
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
    data.onSearch();
  };
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      label={t("drawer.label")}
      {...(onNavigate ? { onNavigate } : {})}
    >
      {level ? (
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
      ) : (
        <div className="cb-navdrawer" data-part="nav-drawer">
          <button
            type="button"
            className="cb-navdrawer-search"
            data-part="drawer-search"
            onClick={search}
          >
            <Icon name="search" size={16} />
            <span>{t("drawer.search")}</span>
          </button>
          <nav className="cb-navdrawer-sections" aria-label={t("shell.nav")}>
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
                icon="skills"
                label={data.moreLabel}
                trailing="chevron"
                onSelect={() => setLevel(true)}
              />
            ) : null}
          </nav>
          <div className="cb-navdrawer-recent" data-part="drawer-recent">
            <Conversations c={data.recent} newHref={data.newConversation.href} />
            <NavRow
              icon="chats"
              label={data.allConversations.label}
              href={data.allConversations.href}
              current={pathname !== undefined && under(pathname, data.allConversations.href)}
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
              <Avatar
                value={data.account.avatar ?? null}
                name={data.account.name}
                size={40}
                shape="circle"
              />
              <span className="cb-account-names">
                <span className="cb-account-name">{data.account.name}</span>
                {data.account.orgName === null ? null : (
                  <span className="cb-account-org">{data.account.orgName}</span>
                )}
              </span>
            </button>
            <Link
              href={data.newConversation.href}
              className="cb-navdrawer-new"
              data-part="drawer-new"
              data-drawer-pick="true"
              aria-label={data.newConversation.label}
              title={data.newConversation.label}
            >
              <Icon name="square-pen" size={16} />
              <LinkPendingMark />
            </Link>
          </div>
        </div>
      )}
      <AccountSheet open={accountOpen} onOpenChange={setAccountOpen} data={data.account} />
    </Drawer>
  );
}
