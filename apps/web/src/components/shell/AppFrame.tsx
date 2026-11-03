"use client";

import {
  AppShell,
  initialOf,
  type MenuItem,
  OverviewPage,
  SetupPage,
  type SidebarContext,
  type SidebarConversations,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { usePathname, useRouter } from "../../i18n/navigation";
import { type OrgReadiness, setupReady } from "../../lib/agents";
import { ApiClientError } from "../../lib/api";
import { loginPathFor } from "../../lib/auth-sources";
import { navigateBrowser } from "../../lib/browser";
import { useConnectResultToast } from "../../lib/connect";
import { NoCurrentOrgError } from "../../lib/conversations";
import { usePreferences } from "../../lib/preferences";
import { retryOnMountOf } from "../../lib/query/client";
import { useAppMutation } from "../../lib/query/define";
import { keys } from "../../lib/query/keys";
import { meQuery, readinessQuery } from "../../lib/query/shell";
import { markSigningOut, resetSession } from "../../lib/query/workspace";
import { logout, type Me, type Membership, setCurrentOrg } from "../../lib/session";
import { broadcastSession, useSessionSync } from "../../lib/session-sync";
import { useErrorMessage } from "../../lib/use-error-message";
import { CreateOrgDialog } from "../CreateOrgDialog";
import { LeaveOrgDialog } from "../LeaveOrgDialog";
import { noOrgConversations, useConversationGroups } from "./conversations";
import {
  activeAdminOf,
  activeNavOf,
  navLevelOf,
  statusPrompt,
  useAdminItems,
  useExtensions,
  useNav,
  usePendingApprovals,
} from "./nav";
import { OrgChooser } from "./OrgChooser";
import { type Session, SessionContext } from "./session";
import {
  activeStepOf,
  type Readiness,
  SetupContext,
  SetupHome,
  setupRouteOf,
  useSetupSteps,
} from "./setup";

/** The local time zone, e.g. `UTC+8`, `UTC-3:30` (the status bar's right side, spec §4.4). */
function timeZoneLabel(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const h = Math.floor(Math.abs(offset) / 60);
  const m = Math.abs(offset) % 60;
  return `UTC${sign}${h}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}`;
}

const noSubscribe = () => () => {};

/**
 * The browser's time zone: empty in the server render and the first hydration (the server's zone
 * is not the viewer's), the browser's afterwards.
 */
function useTimeZoneLabel(): string {
  return useSyncExternalStore(noSubscribe, timeZoneLabel, () => "");
}

/** The setup frame re-reads readiness this often (and on focus), so a member sees the shell appear. */
const SETUP_REFRESH_MS = 30_000;
/** Stands in for readiness when there is no org (the setup steps are then not drawn). */
const NO_ORG_READINESS: OrgReadiness = { modelProvider: "ready", agents: 1 };

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * The `(app)` route group's frame (web-SSR spec §3), drawn from the shell queries the layout read
 * on the server (`getShell()`, hydrated into the browser's cache), with no browser read on mount.
 * The frame is chosen at first paint from the cache and the route:
 * 1. the org chooser, without a current org (outside `/admin`);
 * 2. the setup frame, while the org is not ready on a setup route (web-SSR spec §4);
 * 3. otherwise the App Shell: the sidebar in its work or admin context (web order §2.1–§2.2), the
 *    account menu and the status bar (`<login>@<slug>:<path>` · version · time zone).
 *
 * It provides the session to pages ({@link SessionContext}). An org change is a full navigation to
 * `/` (ruling R4), so the current page stays until the new document arrives; `reload()` re-renders
 * the route on the server (`router.refresh()`), which hydrates fresh shell data. The conversation
 * list, the pending count and the extension pages read their queries directly; the frame stays
 * mounted across navigations, so on each path change it refetches the stale ones of the list and
 * the count (web query cache spec §6, "Persistent components").
 */
export function AppFrame({ version, children }: { version: string; children: ReactNode }) {
  const me = useQuery(meQuery()).data;
  // `me` is always prefetched by the layout; without it (never on a document load) nothing is drawn.
  if (me === undefined) return null;
  const org = me.memberships.find((m) => m.orgId === me.currentOrgId) ?? null;
  // Org-scoped queries are built only with an org.
  if (org === null) {
    return (
      <ShellFrame me={me} org={null} readiness={null} sections={null} version={version}>
        {children}
      </ShellFrame>
    );
  }
  return (
    <OrgFrame me={me} org={org} version={version}>
      {children}
    </OrgFrame>
  );
}

/** The sidebar's sections of the current org, each read from its own query. */
type Sections = {
  conversations: SidebarConversations;
  pending: { count: number; more: boolean; refresh(): void };
  extensions: { id: string; label: string; href: string }[];
};

/** The frame of an account with a current org: readiness and the sidebar sections. */
function OrgFrame({
  me,
  org,
  version,
  children,
}: {
  me: Me;
  org: Membership;
  version: string;
  children: ReactNode;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const qc = useQueryClient();
  const pathname = usePathname();
  const errorMessage = useErrorMessage();
  const toast = useToast();
  const { orgId } = org;
  const readinessQ = readinessQuery(orgId);
  // A failed readiness read draws the shell (as the server's `null` did).
  const readiness =
    useQuery({ ...readinessQ, retryOnMount: retryOnMountOf(readinessQ.queryKey) }).data ?? null;
  const conversations = useConversationGroups(orgId, pathname, {
    onError: (e) =>
      toast.error(e instanceof NoCurrentOrgError ? t("shell.noCurrentOrg") : errorMessage(e)),
  });
  const pending = usePendingApprovals(orgId);
  const extensions = useExtensions(orgId, locale);
  // Persistent sections never remount, so `refetchOnMount` never fires for them: each path change
  // refetches their stale queries (fresh ones stay as they are).
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    for (const queryKey of [keys.org(orgId).conversationGroupsAll(), keys.org(orgId).inboxCount()])
      void qc.refetchQueries({ queryKey, stale: true, type: "active" });
  }, [pathname, qc, orgId]);
  return (
    <ShellFrame
      me={me}
      org={org}
      readiness={readiness}
      sections={{ conversations, pending, extensions }}
      version={version}
    >
      {children}
    </ShellFrame>
  );
}

const NO_PENDING: Sections["pending"] = { count: 0, more: false, refresh: () => {} };

function ShellFrame({
  me,
  org: currentOrg,
  readiness,
  sections,
  version,
  children,
}: {
  me: Me;
  org: Membership | null;
  /** `null` only without a current org (or when its read failed). */
  readiness: OrgReadiness | null;
  /** `null` without a current org: nothing org-scoped is read. */
  sections: Sections | null;
  version: string;
  children: ReactNode;
}) {
  const t = useTranslations();
  const router = useRouter();
  const qc = useQueryClient();
  const pathname = usePathname();
  const errorMessage = useErrorMessage();
  const toast = useToast();
  const orgId = currentOrg?.orgId ?? null;
  const conversations = sections?.conversations ?? noOrgConversations(pathname);
  const pending = sections?.pending ?? NO_PENDING;
  const { primary, more, inbox, adminHref, commands } = useNav(
    pending.count,
    navLevelOf(me),
    pending.more,
    me.account.isEnterpriseAdmin,
  );
  const extensions = sections?.extensions ?? [];
  const adminItems = useAdminItems();
  const preferences = usePreferences();
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [leavingOrg, setLeavingOrg] = useState(false);
  // The org dialogs stay open (pending) until the new org's frame arrives, then close.
  const [dialogOrg, setDialogOrg] = useState(orgId);
  if (dialogOrg !== orgId) {
    setDialogOrg(orgId);
    setCreatingOrg(false);
    setLeavingOrg(false);
  }
  const timeZone = useTimeZoneLabel();
  useConnectResultToast();

  const [switching, setSwitching] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  /**
   * The current org changed (here or in another tab): a full navigation to its home (ruling R4).
   * The browser keeps this page until the new server-rendered document arrives, so nothing of the
   * new org paints inside the old org's shell; the control stays pending until the unload. The
   * query cache is dropped first (`resetSession`), so a read of the old org cannot reach the new one.
   */
  const openHome = useCallback(() => {
    setSwitching(true);
    void resetSession(qc, () => navigateBrowser("/"));
  }, [qc]);
  const reload = useCallback(async () => startRefresh(() => router.refresh()), [router]);
  // Both end the cache's session themselves (`resetSession`): nothing to invalidate.
  const { mutateAsync: putCurrentOrg } = useAppMutation({
    fn: setCurrentOrg,
    invalidates: () => [],
  });
  const { mutateAsync: postLogout } = useAppMutation({ fn: logout, invalidates: () => [] });
  const switchOrg = useCallback(
    async (next: string | null) => {
      try {
        await putCurrentOrg(next);
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 401) {
          await resetSession(qc, () =>
            navigateBrowser(loginPathFor(`${window.location.pathname}${window.location.search}`)),
          );
        }
        throw e;
      }
      broadcastSession("org-switched");
      openHome();
    },
    [openHome, qc, putCurrentOrg],
  );
  // A failed switch from a menu says why (the menu has closed).
  const selectOrg = (next: string) =>
    void switchOrg(next).catch((e: unknown) => toast.error(errorMessage(e)));
  // Another tab signed in or out: start over from `/`; it switched org: follow (the current org
  // belongs to the session the tabs share).
  useSessionSync(() => void resetSession(qc, () => navigateBrowser("/")), openHome);

  const session = useMemo<Session>(
    () => ({
      me,
      reload,
      switchOrg,
      switching,
      refreshPending: pending.refresh,
      version,
      ...(timeZone === "" ? {} : { timeZone }),
    }),
    [me, reload, switchOrg, switching, pending.refresh, version, timeZone],
  );

  async function onLogout() {
    // A read that finds the session gone while signing out is expected: the session guard stands
    // down, so it cannot send the page to sign-in with a return path meanwhile.
    markSigningOut();
    try {
      await postLogout();
    } finally {
      broadcastSession("signed-out");
      await resetSession(qc, () => navigateBrowser("/login"));
    }
  }

  // Leaving keeps the sign-in (web order §9): the kernel already cleared the current org, so move
  // to another org of the account, or to the org chooser when none is left. The dialog stays
  // pending until the new document replaces the page.
  function onLeftOrg() {
    const left = currentOrg;
    if (left) toast.success(t("orgLifecycle.leave.left", { name: left.name }));
    const next = me.memberships.find((m) => m.orgId !== left?.orgId);
    if (next) selectOrg(next.orgId);
    else {
      broadcastSession("org-switched");
      openHome();
    }
  }

  // The setup frame (web-SSR spec §4): while the org lacks a model or an agent, setup routes render
  // in it; the admin console keeps its own context.
  const setupRoute = setupRouteOf(pathname);
  const ready = readiness === null || setupReady(readiness);
  const inSetup = currentOrg !== null && !ready && setupRoute !== "outside";
  const setupState: Readiness =
    readiness === null || ready ? { kind: "ready" } : { kind: "setup", ...readiness };
  const steps = useSetupSteps(me, readiness ?? NO_ORG_READINESS);
  // A route that is no setup route never gets here while in setup: the layout redirects it on the
  // server, and `useWorkspace()` does for client navigations.
  // While in setup, read readiness again every 30 s, on focus and on every navigation (a step page
  // may have changed it): the shell replaces the setup frame once the org is ready.
  useEffect(() => {
    if (!inSetup) return;
    const refresh = () => router.refresh();
    window.addEventListener("focus", refresh);
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") refresh();
    }, SETUP_REFRESH_MS);
    return () => {
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, [inSetup, router]);
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    if (inSetup) router.refresh();
  }, [pathname, inSetup, router]);

  // The account menu (web order §2.1): Organization ▸ (the current one checked), Language ▸,
  // Personal settings, sign out; the theme is the switch after the account.
  const createOrgItem: MenuItem[] = me.canCreateOrg
    ? [{ label: t("shell.createOrg"), onSelect: () => setCreatingOrg(true) }]
    : [];
  // The user's orgs as radio items, then "Create organization…": the org switcher's menu and the
  // account menu's Organization submenu.
  const orgItems: MenuItem[] = [
    // The current org reads as the current choice (primary text and a check), not as disabled;
    // choosing it again does nothing.
    ...me.memberships.map((m) => ({
      label: m.name,
      checked: m.orgId === orgId,
      disabled: switching,
      onSelect: () => {
        if (m.orgId !== orgId) selectOrg(m.orgId);
      },
    })),
    ...(me.memberships.length > 0 && createOrgItem.length > 0 ? ["separator" as const] : []),
    ...createOrgItem,
    // 退出组织… (any member; the dialog tells the only owner to transfer ownership first)
    ...(currentOrg !== null
      ? [
          "separator" as const,
          { label: t("orgLifecycle.leave.action"), onSelect: () => setLeavingOrg(true) },
        ]
      : []),
  ];
  const orgMenu: MenuItem[] =
    me.memberships.length === 0 && !me.canCreateOrg
      ? []
      : [{ label: t("shell.orgMenu"), submenu: orgItems }];
  const languageMenu: MenuItem = {
    label: preferences.language.label,
    submenu: preferences.language.options.map((o) => ({
      label: o.label,
      checked: o.value === preferences.language.value,
      onSelect: () => preferences.language.onChange(o.value),
    })),
  };
  const personalMenu: MenuItem[] = [
    languageMenu,
    { label: t("shell.accountSettings"), href: "/account/connections" },
    "separator",
    { label: t("common.logout"), onSelect: () => void onLogout() },
  ];
  const roles: Record<string, string> = {
    owner: t("members.roles.owner"),
    admin: t("members.roles.admin"),
    member: t("members.roles.member"),
    guest: t("members.roles.guest"),
  };
  const sidebarOrg = (menu: MenuItem[]) =>
    currentOrg
      ? {
          name: currentOrg.name,
          initial: initialOf(currentOrg.name),
          slug: currentOrg.slug,
          role: roles[currentOrg.role] ?? currentOrg.role,
          menu,
        }
      : null;
  const status = {
    context: statusPrompt(me.account.displayName, currentOrg?.slug ?? null, pathname),
    version,
    ...(timeZone === "" ? {} : { timeZone }),
  };

  const dialogs = (
    <>
      {me.canCreateOrg ? (
        <CreateOrgDialog open={creatingOrg} onOpenChange={setCreatingOrg} />
      ) : null}
      {currentOrg !== null && leavingOrg ? (
        <LeaveOrgDialog
          orgId={currentOrg.orgId}
          owner={currentOrg.role === "owner"}
          onClose={() => setLeavingOrg(false)}
          onLeft={onLeftOrg}
        />
      ) : null}
    </>
  );

  // Signed in without a current org: the chooser covers the whole shell (the admin console, which
  // needs no org, stays reachable for enterprise admins).
  if (currentOrg === null && !under(pathname, "/admin")) {
    return (
      <SessionContext.Provider value={session}>
        <OrgChooser onLogout={() => void onLogout()} />
      </SessionContext.Provider>
    );
  }

  if (inSetup && readiness !== null) {
    const home = setupRoute === "home" || setupRoute === "redirect";
    const multiOrg = me.memberships.length > 1 || me.canCreateOrg;
    return (
      <SessionContext.Provider value={session}>
        <SetupContext.Provider value={{ active: true, readiness: setupState, recheck: reload }}>
          <SetupPage
            sidebar={{
              org: sidebarOrg(multiOrg ? orgItems : []),
              home: { href: "/" },
              steps,
              activeNav: activeStepOf(pathname, steps),
              // The org has its own menu in the switcher.
              account: { name: me.account.displayName, menu: personalMenu },
              theme: preferences.theme,
              ...(me.account.isEnterpriseAdmin ? { adminHref: "/admin" } : {}),
            }}
            status={{
              ...status,
              context: statusPrompt(
                me.account.displayName,
                currentOrg?.slug ?? null,
                home ? "/setup" : pathname,
              ),
            }}
          >
            {home ? (
              <OverviewPage
                header={{
                  path: [{ label: currentOrg?.slug ?? "~" }, { label: t("chat.setup.title") }],
                  title: t("chat.setup.title"),
                  // the checklist's progress sits beside the title (no header band on the card)
                  count: t("home.setup.progress", {
                    done: steps.filter((s) => !s.optional && s.state === "done").length,
                    total: steps.filter((s) => !s.optional).length,
                  }),
                  description: t("chat.setup.description"),
                }}
              >
                <SetupHome
                  me={me}
                  readiness={readiness}
                  refreshing={refreshing}
                  onRefresh={() => void reload()}
                />
              </OverviewPage>
            ) : (
              children
            )}
          </SetupPage>
          {dialogs}
        </SetupContext.Provider>
      </SessionContext.Provider>
    );
  }

  // The admin context under /admin (web order §2.2), else the workspace of the current org. Only
  // for an enterprise admin: anyone else gets the 403 beside the workspace sidebar.
  const inAdmin = me.account.isEnterpriseAdmin && under(pathname, "/admin");
  const context: SidebarContext = inAdmin
    ? { kind: "admin", back: { href: "/", slug: currentOrg?.slug ?? null }, items: adminItems }
    : {
        kind: "work",
        org: sidebarOrg(orgItems),
        primary,
        more,
        moreExtensions: extensions.map((x) => ({
          ...x,
          id: `ext:${x.id}`,
          icon: "extension" as const,
        })),
        inbox,
        ...(adminHref === undefined ? {} : { adminHref }),
      };
  return (
    // The conversation page draws its own status bar under its middle column (spec §5.2).
    <AppShell
      sidebar={{
        context,
        // A new conversation starts at the composer; nothing is created before the first send.
        newConversation: { href: "/chat" },
        activeNav: inAdmin ? activeAdminOf(pathname, adminItems) : activeNavOf(pathname),
        conversations,
        account: { name: me.account.displayName, menu: [...orgMenu, ...personalMenu] },
        theme: preferences.theme,
      }}
      commands={commands}
      status={status}
      ownStatusBar={under(pathname, "/chat")}
    >
      <SessionContext.Provider value={session}>
        <SetupContext.Provider value={{ active: false, readiness: setupState, recheck: reload }}>
          {children}
        </SetupContext.Provider>
        {dialogs}
      </SessionContext.Provider>
    </AppShell>
  );
}
