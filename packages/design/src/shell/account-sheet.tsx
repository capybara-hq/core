import * as RD from "@radix-ui/react-dialog";
import type { MouseEvent, ReactNode } from "react";
import { Avatar, type AvatarValue } from "../display/avatar";
import { NavRow } from "../display/nav-row";
import { BottomSheetContent } from "../overlays/bottom-sheet";
import { picksAway } from "../overlays/drawer";
import { popOverlaysThen, useOverlayHistory } from "../overlays/use-overlay-history";
import { useDesignT } from "../provider";

/** What the drawer's account row opens (design spec §6.54). */
export interface AccountSheetData {
  name: string;
  /** The current org's name; null outside an org (the platform console). */
  orgName: string | null;
  /** The person's avatar (a circle: an image or the initial). */
  avatar?: AvatarValue;
  /** The org switcher (apps/web's own control); absent with one org. */
  orgSwitcher?: ReactNode;
  personalSettingsHref: string;
  /** The theme control (the light / dark switch). */
  theme: ReactNode;
  /** The system status line (what the StatusBar shows on wider windows). */
  status: ReactNode;
  /** The PWA install hint, while the app is not installed. */
  installHint?: ReactNode;
  /** A native shell's profile switcher (`profiles@1.show`); absent: no 「切换平台」 row. */
  onSwitchProfile?(): void;
  onSignOut(): void;
}

export type AccountSheetProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  data: AccountSheetData;
};

/**
 * The account sheet (design spec §6.54): a bottom sheet from the drawer's account row with the
 * person and org, the org switcher, 个人设置, the theme, the system status, the install hint,
 * 切换平台 (a native shell only) and sign out. It holds its own history entry on a compact touch
 * window, so the system back closes it before the drawer under it (Decision 25); a row that goes
 * somewhere leaves the entry (the navigation is pending) and also closes the drawer.
 */
export function AccountSheet({ open, onOpenChange, data }: AccountSheetProps) {
  const t = useDesignT();
  const history = useOverlayHistory(open, () => onOpenChange(false));
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
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent
        title={t("account.title")}
        part="account-sheet"
        onDismiss={() => onOpenChange(false)}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the rows inside are the controls; this only observes their clicks */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a row's Enter fires the same click */}
        <div className="cb-account" data-part="account-body" onClick={onClick}>
          <div className="cb-account-who" data-part="account-who">
            <Avatar value={data.avatar ?? null} name={data.name} size={40} shape="circle" />
            <span className="cb-account-names">
              <span className="cb-account-name">{data.name}</span>
              {data.orgName === null ? null : (
                <span className="cb-account-org">{data.orgName}</span>
              )}
            </span>
          </div>
          {data.orgSwitcher ? <div className="cb-account-slot">{data.orgSwitcher}</div> : null}
          <NavRow icon="user" label={t("account.settings")} href={data.personalSettingsHref} />
          <div className="cb-account-line" data-part="account-theme">
            <span className="cb-account-label">{t("account.theme")}</span>
            {data.theme}
          </div>
          <div className="cb-account-line" data-part="account-status">
            <span className="cb-account-label">{t("account.status")}</span>
            <span className="cb-account-status">{data.status}</span>
          </div>
          {data.installHint ? <div className="cb-account-slot">{data.installHint}</div> : null}
          {data.onSwitchProfile ? (
            // the native switcher opens inside the click (user activation) and keeps the page
            <NavRow
              stay
              icon="arrow-up-down"
              label={t("account.switchProfile")}
              onSelect={data.onSwitchProfile}
            />
          ) : null}
          <NavRow icon="log-out" label={t("account.signOut")} onSelect={signOut} />
        </div>
      </BottomSheetContent>
    </RD.Root>
  );
}
