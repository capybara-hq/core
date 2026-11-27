import * as RD from "@radix-ui/react-dialog";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Avatar, type AvatarValue } from "../display/avatar";
import { Segmented } from "../display/tabs";
import type { IconName } from "../icons/paths";
import { BottomSheetContent } from "../overlays/bottom-sheet";
import { picksAway } from "../overlays/drawer";
import { Menu, type MenuItem } from "../overlays/menus";
import { focusOnOpen } from "../overlays/quiet-focus";
import { SheetFootnote, SheetGroup, SheetRow } from "../overlays/sheet-parts";
import { popOverlaysThen, useOverlayHistory } from "../overlays/use-overlay-history";
import { useDesignT } from "../provider";
import type { PreferenceBarProps } from "./preference-bar";

/** The theme switch's data (the wide preference bar's `theme`): light and dark. */
export type AccountSheetTheme = NonNullable<PreferenceBarProps["theme"]>;

/** What the drawer's account row opens (design spec §6.55). */
export interface AccountSheetData {
  name: string;
  /** The current org's name; null outside an org (the platform console). */
  orgName: string | null;
  /** The person's avatar (a circle: an image or the initial). */
  avatar?: AvatarValue;
  /**
   * The org switcher's items (the orgs, creating one); absent with one org: the Organization row
   * is the org's name, not a control. A pick closes the sheet and the drawer under it.
   */
  orgMenu?: MenuItem[];
  /** The language choice (on a phone the only way to switch it): the current one's name, the items. */
  language?: { value: string; label: string; items: MenuItem[] };
  personalSettingsHref: string;
  /** The theme switch; null when the UI theme defines one scheme only. */
  theme: AccountSheetTheme | null;
  /** The system status line (the account menu's status on wider windows): the footnote. */
  status: ReactNode;
  /** The PWA install hint, while the app is not installed. */
  installHint?: ReactNode;
  /** A native shell's profile switcher (`profiles@1.show`); absent: no "Switch platform" row. */
  onSwitchProfile?(): void;
  onSignOut(): void;
}

export type AccountSheetProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  data: AccountSheetData;
  /** Closes the sheet and what it sits over (the drawer); default: the sheet alone. */
  onDone?: () => void;
  /**
   * A native strip's account sheet (interaction model §10.2, D11): the drawer's
   * "Skills, connectors, devices…" entries (Skills, Connectors, Devices, the org's extension
   * pages). A row opens them in the sheet, as the drawer's More opens its level; absent or empty:
   * no row.
   */
  more?: AccountSheetMoreItem[];
};

/** One entry of the account sheet's "Skills, connectors, devices…" level. */
export type AccountSheetMoreItem = { id: string; label: string; href: string; icon: IconName };

/** `items` with `after` run once an item's own action has (a pick closes the sheet and drawer). */
function closingAfter(items: MenuItem[], after: () => void): MenuItem[] {
  return items.map((i) =>
    i === "separator" || i.onSelect === undefined
      ? i
      : {
          ...i,
          onSelect: () => {
            i.onSelect?.();
            after();
          },
        },
  );
}

/**
 * The account sheet (design spec §6.55, maintainer decision 2026-11-22): grouped rows on the
 * bottom sheet (§6.59). The profile row (avatar, name, "Profile and preferences") opens Personal
 * settings; Organization (the current org; a menu of the orgs when there are several) and Switch
 * platform (a native shell only); Language and Appearance; sign out alone in its group; the status line as the footnote. A
 * native strip's sheet also holds "Skills, connectors, devices…" under the profile (`more`). It holds
 * its own history entry on a compact touch window, so the system back closes it before the drawer
 * under it (Decision 25); a row that goes somewhere leaves the entry (the navigation is pending)
 * and also closes the drawer.
 */
export function AccountSheet({ open, onOpenChange, data, onDone, more }: AccountSheetProps) {
  const t = useDesignT();
  const history = useOverlayHistory(open, () => onOpenChange(false));
  // The "Skills, connectors, devices…" level: in the same sheet (one history entry, no second
  // sheet); a closed sheet opens at its rows again. Focus moves to the level's back row and
  // returns to the row that opened it.
  const [level, setLevel] = useState(false);
  const levelBack = useRef<HTMLButtonElement | null>(null);
  const moreRow = useRef<HTMLButtonElement | null>(null);
  const entered = useRef(false);
  useEffect(() => {
    if (!open) setLevel(false);
  }, [open]);
  useEffect(() => {
    if (level) {
      entered.current = true;
      focusOnOpen(levelBack.current);
    } else if (entered.current) {
      entered.current = false;
      focusOnOpen(moreRow.current);
    }
  }, [level]);
  const hasMore = more !== undefined && more.length > 0;
  const done = onDone ?? (() => onOpenChange(false));
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const pick = (e.target as HTMLElement).closest<HTMLElement>("[data-drawer-pick]");
    if (pick === null) return;
    if (picksAway(pick, e)) history.leaveEntry();
    onOpenChange(false);
  };
  // Sign out leaves the page: it runs once the overlays' entries are popped, so no back() races
  // its navigation and one back afterwards is the page before (T27 review).
  const signOut = () => {
    if (!popOverlaysThen(data.onSignOut)) data.onSignOut();
  };
  const orgRow =
    data.orgName === null ? null : data.orgMenu && data.orgMenu.length > 0 ? (
      <Menu
        items={closingAfter(data.orgMenu, done)}
        label={t("account.org")}
        trigger={
          <SheetRow
            icon="building"
            label={t("account.org")}
            value={data.orgName}
            chevron
            part="account-org"
          />
        }
      />
    ) : (
      <SheetRow
        static
        icon="building"
        label={t("account.org")}
        value={data.orgName}
        part="account-org"
      />
    );
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent
        title={level && hasMore ? t("account.more") : t("account.title")}
        part="account-sheet"
        onDismiss={() => onOpenChange(false)}
      >
        {level && hasMore ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: the rows inside are the controls; this only observes their clicks
          // biome-ignore lint/a11y/useKeyWithClickEvents: a row's Enter fires the same click
          <div className="cb-account" data-part="account-more-level" onClick={onClick}>
            <SheetGroup part="account-more-back-group">
              <SheetRow
                ref={levelBack}
                icon="arrow-left"
                label={t("account.back")}
                part="account-more-back"
                // the level's way back stays in the sheet: not a pick that closes it
                onClick={(e) => {
                  e.stopPropagation();
                  setLevel(false);
                }}
              />
            </SheetGroup>
            <SheetGroup label={t("account.more")} part="account-more-items">
              {more.map((m) => (
                <SheetRow
                  key={m.id}
                  href={m.href}
                  icon={m.icon}
                  label={m.label}
                  part="account-more-item"
                />
              ))}
            </SheetGroup>
          </div>
        ) : (
          /* biome-ignore lint/a11y/noStaticElementInteractions: the rows inside are the controls; this only observes their clicks */
          /* biome-ignore lint/a11y/useKeyWithClickEvents: a row's Enter fires the same click */
          <div className="cb-account" data-part="account-body" onClick={onClick}>
            <SheetGroup part="account-profile-group">
              <SheetRow
                href={data.personalSettingsHref}
                lead={
                  <Avatar value={data.avatar ?? null} name={data.name} size={40} shape="circle" />
                }
                label={data.name}
                description={t("account.profileHint")}
                chevron
                part="account-profile"
              />
            </SheetGroup>
            {hasMore ? (
              <SheetGroup part="account-more-group">
                {/* a chevron row without onSelect opens something in place: no pick */}
                <SheetRow
                  ref={moreRow}
                  icon="more-horizontal"
                  label={t("account.more")}
                  chevron
                  part="account-more"
                  onClick={() => setLevel(true)}
                />
              </SheetGroup>
            ) : null}
            {orgRow !== null || data.onSwitchProfile ? (
              <SheetGroup part="account-org-group">
                {orgRow}
                {data.onSwitchProfile ? (
                  // the native switcher opens inside the click (user activation) and keeps the page
                  <SheetRow
                    stay
                    icon="arrow-up-down"
                    label={t("account.switchProfile")}
                    onSelect={data.onSwitchProfile}
                    part="account-switch-profile"
                  />
                ) : null}
              </SheetGroup>
            ) : null}
            {data.language || data.theme ? (
              <SheetGroup part="account-preferences">
                {data.language ? (
                  <Menu
                    items={closingAfter(data.language.items, done)}
                    label={data.language.label}
                    trigger={
                      <SheetRow
                        icon="languages"
                        label={t("account.language")}
                        value={data.language.value}
                        chevron
                        part="account-language"
                      />
                    }
                  />
                ) : null}
                {data.theme ? (
                  <SheetRow
                    icon="sun"
                    label={t("account.theme")}
                    part="account-theme"
                    control={
                      <Segmented
                        label={data.theme.label}
                        value={data.theme.value}
                        options={[
                          { value: "light", label: data.theme.lightLabel },
                          { value: "dark", label: data.theme.darkLabel },
                        ]}
                        onChange={(v) => data.theme?.onChange(v === "light" ? "light" : "dark")}
                      />
                    }
                  />
                ) : null}
              </SheetGroup>
            ) : null}
            {data.installHint ? <div className="cb-account-slot">{data.installHint}</div> : null}
            <SheetGroup part="account-sign-out-group">
              <SheetRow
                centered
                danger
                label={t("account.signOut")}
                onSelect={signOut}
                part="account-sign-out"
              />
            </SheetGroup>
            {data.status ? (
              <SheetFootnote part="account-status">{data.status}</SheetFootnote>
            ) : null}
          </div>
        )}
      </BottomSheetContent>
    </RD.Root>
  );
}
