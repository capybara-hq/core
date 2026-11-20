import {
  BottomNav,
  type BottomNavItem,
  type ConvMenuEntry,
  type IconName,
  MePanel,
  type MePanelProps,
  type MeRow,
  ReferenceScreen,
  TopBar,
} from "@capybara-hq/design";
import {
  BOTTOM_NAV_FIXTURE,
  type FixtureMeItem,
  ME_PANEL_FIXTURE,
  TOP_BAR_FIXTURE,
} from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// The compact shell's reference blocks (design spec §6.45 BottomNav, §6.46 TopBar, §6.48 MePanel):
// the same ids and boxes as docs/design/reference/src/{bottom-nav,top-bar,me-panel}.html, drawn
// from the shared fixtures (@capybara-hq/design/fixtures). The shell hides these bars outside the
// compact class (its slots do), the components themselves always draw: so the blocks draw them
// at a phone's width in any window.

const PHONE = 390;
/** The iPhone Duo outer display (design spec §4.7). */
const DUO_OUTER = 382;

// ── BottomNav ───────────────────────────────────────────────────────────────

export const bottomItems = (badge: boolean): BottomNavItem[] =>
  BOTTOM_NAV_FIXTURE.items.map((i) => ({
    id: i.id as BottomNavItem["id"],
    label: i.label,
    href: "#",
    icon: i.icon as IconName,
    ...(badge && i.count !== undefined ? { count: i.count } : {}),
  }));

function bottomNavBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="bottom-nav-default" width={PHONE}>
        <BottomNav items={bottomItems(false)} current="chats" />
      </RefBlock>
      <RefBlock id="bottom-nav-active" width={PHONE}>
        <BottomNav items={bottomItems(false)} current="agents" />
      </RefBlock>
      <RefBlock id="bottom-nav-badge" width={PHONE}>
        <BottomNav items={bottomItems(true)} current="chats" />
      </RefBlock>
      <RefBlock id="bottom-nav-short" width={DUO_OUTER}>
        <BottomNav items={bottomItems(true)} current="chats" short />
      </RefBlock>
    </>
  );
}

// ── TopBar ──────────────────────────────────────────────────────────────────

export const overflow: ConvMenuEntry[] = TOP_BAR_FIXTURE.overflow.map((m) => ({
  kind: "item" as const,
  id: m.id,
  label: m.label,
  icon: m.icon as IconName,
  onSelect: () => {},
  ...(m.danger ? { tone: "fail" as const } : {}),
}));

function topBarBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="top-bar-root" width={PHONE}>
        <TopBar title={TOP_BAR_FIXTURE.rootTitle} onSearch={() => {}} menu={overflow} />
      </RefBlock>
      <RefBlock id="top-bar-pushed" width={PHONE}>
        <TopBar title={TOP_BAR_FIXTURE.pushedTitle} back="#" onSearch={() => {}} menu={overflow} />
      </RefBlock>
      <RefBlock id="top-bar-overflow" width={PHONE} height={268}>
        <TopBar
          title={TOP_BAR_FIXTURE.pushedTitle}
          back="#"
          onSearch={() => {}}
          menu={overflow}
          menuOpen
        />
      </RefBlock>
    </>
  );
}

// ── MePanel ─────────────────────────────────────────────────────────────────

const M = ME_PANEL_FIXTURE;
type Role = "member" | "admin" | "super-admin";

const row = (n: { id: string; label: string; href: string; icon: string }): MeRow => ({
  id: n.id,
  label: n.label,
  href: "#",
  icon: n.icon as IconName,
});

const accountRows: MeRow[] = M.accountItems.map((n) =>
  n.id === "language"
    ? {
        id: n.id,
        label: n.label,
        icon: n.icon as IconName,
        ...(n.value ? { value: n.value } : {}),
        menu: [{ label: "简体中文", checked: true, onSelect: () => {} }],
      }
    : n.id === "theme"
      ? {
          id: n.id,
          label: n.label,
          icon: n.icon as IconName,
          theme: {
            label: n.label,
            value: "light" as const,
            lightLabel: "浅色",
            darkLabel: "深色",
            onChange: () => {},
          },
        }
      : n.id === "sign-out"
        ? { id: n.id, label: n.label, icon: n.icon as IconName, onSelect: () => {} }
        : row({ ...n, href: n.href ?? "#" }),
);

const ORG_ROLE: Record<Role, string> = {
  member: "组织成员",
  admin: "组织管理员",
  // an org member who is a super admin: the manage group holds only the admin console entry
  "super-admin": "组织成员",
};

function panel(role: Role): MePanelProps {
  const visible = M.visible[role];
  const of = (group: FixtureMeItem["group"]) =>
    M.items.filter((n) => n.group === group && visible.includes(n.audience)).map(row);
  return {
    account: { name: M.account.name },
    org: {
      name: M.org.name,
      initial: M.org.initial,
      slug: M.org.slug,
      role: ORG_ROLE[role],
      menu: [{ label: M.org.name, checked: true, onSelect: () => {} }],
    },
    workspace: of("workspace"),
    manage: [
      ...of("manage"),
      ...(role === "super-admin"
        ? [{ ...row({ ...M.adminEntry, id: "admin" }), external: true }]
        : []),
    ],
    accountRows,
    system: M.system,
  };
}

const adminContext: MePanelProps = {
  account: { name: M.account.name },
  org: null,
  adminContext: true,
  manage: M.adminContext.items.map(row),
  back: row({ ...M.adminContext.back, id: "back" }),
  accountRows,
  system: M.system,
};

/** The Me tab's screen, as the reference draws it: the root top bar (Me), the panel, the bottom nav. */
function MeScreen({ children }: { children: ReactNode }) {
  return (
    <ReferenceScreen
      top={<TopBar title={M.title} onSearch={() => {}} menu={overflow} />}
      bottom={<BottomNav items={bottomItems(true)} current="me" />}
      pad
    >
      {children}
    </ReferenceScreen>
  );
}

function mePanelBlocks(): ReactNode {
  return (
    <>
      {(["member", "admin", "super-admin"] as const).map((role) => (
        <RefBlock key={role} id={`me-panel-${role}`} width={PHONE}>
          <MeScreen>
            <MePanel {...panel(role)} />
          </MeScreen>
        </RefBlock>
      ))}
      <RefBlock id="me-panel-admin-context" width={PHONE}>
        <MeScreen>
          <MePanel {...adminContext} />
        </MeScreen>
      </RefBlock>
    </>
  );
}

export const COMPACT_SHELL_BLOCKS = {
  "bottom-nav": bottomNavBlocks,
  "top-bar": topBarBlocks,
  "me-panel": mePanelBlocks,
} as const;
