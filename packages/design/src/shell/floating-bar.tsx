import type { ReactNode } from "react";
import type { NavBadge } from "../display/nav-badge";
import { useDesignT } from "../provider";
import { FloatingIconButton } from "./floating-button";
import { withViewTransition } from "./view-transition";

/**
 * Where back goes (design spec §4.6): the previous in-app history entry when there is one, else
 * the last linked segment of the page's `path` above the page itself (the path's last segment is
 * the current page, whatever its link; every page head has a path), else the home, so a deep link
 * opened from outside still has a way up (mobile app plan Decision 19).
 */
export function backTarget(
  path: readonly { href?: string | undefined }[],
  hasInAppHistory: boolean,
): "history" | string {
  if (hasInAppHistory) return "history";
  for (let i = path.length - 2; i >= 0; i--) {
    const href = path[i]?.href;
    if (href) return href;
  }
  return "/";
}

/** The longest a view transition waits for the page behind a back to arrive. */
const SETTLE_LIMIT_MS = 500;

/**
 * Goes back one entry and settles once the page has changed (the next `popstate` and the frame
 * after it), so a view transition captures the new page; a bounded wait covers a `popstate` that
 * never comes.
 */
export function goBack(): Promise<void> {
  return new Promise((resolve) => {
    const settle = () => requestAnimationFrame(() => resolve());
    window.addEventListener("popstate", settle, { once: true });
    window.setTimeout(resolve, SETTLE_LIMIT_MS);
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
};

/**
 * The chat-first compact shell's floating row (design spec §4.6, §6.55): drawn by `AppShell` over
 * the top of the page, shown below 600 only. It holds the leading control, the menu button with
 * the pending inbox count on a chat surface and the back button on a pushed page; the centre and
 * trailing controls belong to the page (the conversation's title pill and overflow).
 */
export function FloatingBar({ lead, trailing }: FloatingBarProps) {
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
      {trailing}
    </div>
  );
}
