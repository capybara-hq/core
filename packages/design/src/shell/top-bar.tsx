import { IconButton } from "../controls/index";
import { ConvMenu, type ConvMenuEntry } from "../conversation/menu";
import { Icon } from "../icons/icon";
import { useDesignLink, useDesignT } from "../provider";
import { backTarget, goBack } from "./floating-bar";
import { withViewTransition } from "./view-transition";

export { backTarget };

export type TopBarProps = {
  /** The page's name (its h1 text): one line with an ellipsis, the full text in `title`. */
  title?: string | undefined;
  /**
   * Pushed pages: where back goes ({@link backTarget}): `"history"` is the previous in-app entry,
   * a string the page's last linked path segment. Absent on a tab root (no back button).
   */
  back?: "history" | string | (() => void) | undefined;
  /** Opens the command palette; absent: no search button (the setup frame has no palette). */
  onSearch?: (() => void) | undefined;
  /** The page's overflow menu; empty or absent: no button is drawn (spec §6.7 "no menu of one"). */
  menu?: ConvMenuEntry[] | undefined;
  /**
   * The setup frame's steps button before the search (the compact class has no sidebar to hold
   * them): it pushes the steps page (design spec §5.5).
   */
  onSteps?: (() => void) | undefined;
  /** Draw the overflow menu open in place (the reference set and the catalog only). */
  menuOpen?: boolean;
};

/**
 * The overflow entries with a destructive (`fail`) last item set apart by a separator (design spec
 * §6.46), unless the page already put one there.
 */
function withDangerSeparator(menu: ConvMenuEntry[]): ConvMenuEntry[] {
  const last = menu.at(-1);
  const before = menu.at(-2);
  if (menu.length < 2 || last?.kind !== "item" || last.tone !== "fail") return menu;
  if (before?.kind === "separator") return menu;
  return [...menu.slice(0, -1), { kind: "separator" }, last];
}

/**
 * The compact class's one row (design spec §6.46), drawn by `AppShell` above every page in the
 * place the drawer menu bar had: back (pushed pages), the page's name, search and the overflow
 * menu. Every button is the ordinary ghost icon button with a 40 x 40 tap target.
 */
export function TopBar({ title, back, onSearch, menu, onSteps, menuOpen }: TopBarProps) {
  const t = useDesignT();
  const Link = useDesignLink();
  const pushed = back !== undefined;
  const hasMenu = menu !== undefined && menu.length > 0;
  return (
    <header className="cb-topbar" data-part="top-bar" data-pushed={pushed ? "true" : "false"}>
      {back === undefined ? null : typeof back === "function" ? (
        <IconButton
          label={t("shell.back")}
          icon={<Icon name="chevron-left" />}
          part="back"
          onClick={back}
        />
      ) : back === "history" ? (
        <IconButton
          label={t("shell.back")}
          icon={<Icon name="chevron-left" />}
          part="back"
          onClick={() => withViewTransition(goBack, "pop")}
        />
      ) : (
        <Link
          href={back}
          className="cb-btn cb-icon-btn"
          data-part="back"
          data-variant="ghost"
          data-density="default"
          aria-label={t("shell.back")}
          title={t("shell.back")}
        >
          <Icon name="chevron-left" />
        </Link>
      )}
      <span className="cb-topbar-title" data-part="title" {...(title ? { title } : {})}>
        {title}
      </span>
      {onSteps !== undefined ? (
        <IconButton
          part="steps"
          label={t("shell.steps")}
          icon={<Icon name="menu" />}
          onClick={onSteps}
        />
      ) : null}
      {onSearch ? (
        <IconButton
          label={t("shell.searchShort")}
          icon={<Icon name="search" />}
          part="search"
          onClick={onSearch}
        />
      ) : null}
      {hasMenu ? (
        <ConvMenu
          label={t("shell.moreActions")}
          align="end"
          size="touch"
          sideOffset={2}
          inline={menuOpen === true}
          entries={withDangerSeparator(menu)}
          trigger={
            <IconButton
              part="more"
              label={t("shell.moreActions")}
              icon={<Icon name="more-horizontal" />}
              // The open menu's button is pressed (spec §6.46).
              aria-pressed={menuOpen === true ? true : undefined}
            />
          }
        />
      ) : null}
    </header>
  );
}
