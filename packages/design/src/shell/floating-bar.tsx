import type { ReactNode } from "react";
import type { NavBadge } from "../display/nav-badge";
import { useDesignT } from "../provider";
import { FloatingIconButton } from "./floating-button";
import { withViewTransition } from "./view-transition";

/**
 * Where back goes (design spec §4.6): the previous in-app history entry when there is one, else
 * the last linked segment of the page's `path` above the page itself (the path's last segment is
 * the current page, whatever its link; every page head has a path), else the home, so a deep link
 * opened from outside still has a way up (mobile app plan Decision 19). A segment that links to
 * the current page (`pathname`; a section whose home is its first page, as `/account/profile`
 * under the account section) is skipped: a link to the page itself replaces its entry and changes nothing,
 * so back would never leave.
 */
export function backTarget(
  path: readonly { href?: string | undefined }[],
  hasInAppHistory: boolean,
  pathname?: string | undefined,
): "history" | string {
  if (hasInAppHistory) return "history";
  for (let i = path.length - 2; i >= 0; i--) {
    const href = path[i]?.href;
    if (href && (pathname === undefined || pathOf(href) !== pathOf(pathname))) return href;
  }
  return "/";
}

/** A link's path without its query or hash, and without a trailing slash (the root aside). */
function pathOf(href: string): string {
  const path = href.split(/[?#]/, 1)[0] ?? "";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The longest a view transition waits for the page behind a back to arrive. */
export const SETTLE_LIMIT_MS = 500;

/** What waits for the shell's next route commit ({@link routeCommitted}). */
const routeCommitWaiters = new Set<(pathname: string | undefined) => void>();

/**
 * Called by `AppShell` in a layout effect when its route (`pathname`) changes: the new page is in
 * the DOM, so a back waiting on it ({@link goBack}) settles.
 */
export function routeCommitted(pathname: string | undefined): void {
  for (const waiter of [...routeCommitWaiters]) waiter(pathname);
}

/**
 * Goes back one entry and settles once the page has changed, so a view transition captures the
 * new page: when the shell commits the route the back landed on, or, when the back changed no
 * route (a hash or query entry), on the task after its `popstate`. Never on a frame: inside a view
 * transition's update the browser renders none until the update settles, so a frame would only
 * come at the bound. A bounded wait covers a `popstate` that never comes.
 */
export function goBack(): Promise<void> {
  return new Promise((resolve) => {
    const from = window.location.pathname;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      routeCommitWaiters.delete(settle);
      window.removeEventListener("popstate", onPop);
      clearTimeout(timer);
      resolve();
    };
    const onPop = () => {
      if (window.location.pathname === from) setTimeout(settle, 0);
    };
    // Any route the shell commits after the back is the one it landed on.
    routeCommitWaiters.add(settle);
    window.addEventListener("popstate", onPop, { once: true });
    timer = setTimeout(settle, SETTLE_LIMIT_MS);
    window.history.back();
  });
}

/** The leading floating control: the menu (a chat surface) or back (a pushed page). */
export type FloatingLead =
  | { kind: "menu"; onOpen(): void; badge?: NavBadge | undefined }
  | { kind: "back"; target: "history" | string | (() => void) }
  | { kind: "steps"; onOpen(): void };

export type FloatingBarProps = {
  /** Absent: no leading control (a chat surface without a drawer). */
  lead?: FloatingLead | undefined;
  /** The trailing floating control (a page's overflow menu); the home has none (Decision 27). */
  trailing?: ReactNode;
  /**
   * A pushed page's title once its large title has scrolled under the row (design spec §6.56,
   * §6.65): drawn centred between the lead and the trailing control; absent, nothing.
   */
  title?: string | undefined;
};

/**
 * The chat-first compact shell's floating row (design spec §4.6, §6.55): drawn by `AppShell` over
 * the top of the page, shown below 600 only. It holds the leading control, the menu button with
 * the pending inbox count on a chat surface and the back button on a pushed page; the centre and
 * trailing controls belong to the page (the conversation's title pill and overflow).
 */
export function FloatingBar({ lead, trailing, title }: FloatingBarProps) {
  const t = useDesignT();
  let leading: ReactNode = null;
  if (lead?.kind === "menu") {
    const n = lead.badge?.count ?? 0;
    const label =
      n > 0
        ? t("shell.menuPending").replace("{n}", `${n}${lead.badge?.more ? "+" : ""}`)
        : t("shell.menu");
    leading = (
      <FloatingIconButton
        icon="menu"
        label={label}
        menuButton
        onClick={lead.onOpen}
        {...(lead.badge ? { badge: lead.badge } : {})}
      />
    );
  } else if (lead?.kind === "steps") {
    leading = <FloatingIconButton icon="menu" label={t("shell.steps")} onClick={lead.onOpen} />;
  } else if (lead?.kind === "back") {
    const target = lead.target;
    leading =
      typeof target === "function" ? (
        <FloatingIconButton icon="chevron-left" label={t("shell.back")} onClick={target} />
      ) : target === "history" ? (
        <FloatingIconButton
          icon="chevron-left"
          label={t("shell.back")}
          onClick={() => withViewTransition(goBack, "pop")}
        />
      ) : (
        <FloatingIconButton icon="chevron-left" label={t("shell.back")} href={target} />
      );
  }
  return (
    <div className="cb-floatbar" data-part="floating-bar" data-lead={lead?.kind}>
      {leading}
      {/* The room between the row's controls: a drag filler as high as the desktop's top row (on a
          chat surface only where the shell reports window controls, and not while a conversation's
          title pill lies over it). */}
      <span className="cb-floatbar-gap cb-drag-fill" aria-hidden="true" />
      {/* The page's large title stays in the page for assistive technology; this is its echo. */}
      {title ? (
        <span className="cb-floating-title" data-part="floating-title" aria-hidden="true">
          {title}
        </span>
      ) : null}
      {trailing}
    </div>
  );
}
