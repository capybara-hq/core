import type { ReactNode } from "react";
import type { DesignKey } from "../i18n";
import { useDesignT } from "../provider";
import { DateTime, versionLabel } from "./date-time";

/** Where a device lives: a cloud sandbox or a machine connected with `capybara-device`. */
export type DeviceNameplateOrigin = "cloud" | "local";

/**
 * What a device is doing, in the page's words (auto mode design §4): a cloud device runs or is
 * suspended, a local device's machine is online or offline.
 */
export type DeviceNameplateState = "running" | "suspended" | "online" | "offline";

export type DeviceNameplateProps = {
  /** The device's name, the plate's one large line. */
  name: string;
  origin: DeviceNameplateOrigin;
  state: DeviceNameplateState;
  /**
   * The device program's version as reported (e.g. "0.4.0"); drawn as `v0.4.0`. Null or absent
   * draws a dash.
   */
  version?: string | null;
  /**
   * When the device was last active (ISO): a cloud device's last use, a local one's machine's
   * last seen. Null or absent reads 从未连接 / "Never connected".
   */
  lastSeen?: string | null;
  /**
   * When the device was created (ISO), as a third mono figure after last seen. A page whose
   * object carries no creation time leaves it out.
   */
  created?: string | null;
  /**
   * The mode mark after the origin (a `Badge`): 自动 / 沙箱 on a local device, the network mode on
   * a cloud one.
   */
  badge?: ReactNode;
  /**
   * The page's own labels. Anything left out comes from the design i18n (§7): 云端设备 /
   * 本地设备, the four state words, 程序 / 最后活跃 / 从未连接.
   */
  labels?: {
    origin?: Partial<Record<DeviceNameplateOrigin, string>>;
    state?: Partial<Record<DeviceNameplateState, string>>;
    version?: string;
    lastSeen?: string;
    created?: string;
    never?: string;
  };
};

/**
 * A device's head (spec §6.41, auto mode design §4): one flat band holding the name as a
 * nameplate — the name, its origin, a status light and the mode badge on the left, the program
 * version and last seen as mono figures on the right (the creation time joins them when the page
 * has one). It is the only place a device's version and last seen appear, and the page's one
 * bright element: the status light is the only accent on a running device, everything else is
 * quiet. It draws its own band, never a card in a card.
 */
export function DeviceNameplate({
  name,
  origin,
  state,
  version,
  lastSeen,
  created,
  badge,
  labels,
}: DeviceNameplateProps) {
  const t = useDesignT();
  const originLabel = labels?.origin?.[origin] ?? t(`nameplate.origin.${origin}` as DesignKey);
  const stateLabel = labels?.state?.[state] ?? t(`nameplate.state.${state}` as DesignKey);
  const versionText = labels?.version ?? t("nameplate.version");
  const lastSeenText = labels?.lastSeen ?? t("nameplate.lastSeen");
  const createdText = labels?.created ?? t("nameplate.created");
  const neverText = labels?.never ?? t("nameplate.never");
  return (
    <div
      className="cb-nameplate"
      data-part="device-nameplate"
      data-origin={origin}
      data-state={state}
    >
      <div className="cb-nameplate-main">
        <span className="cb-nameplate-name" data-part="device-nameplate-name">
          {name}
        </span>
        <span className="cb-nameplate-meta" data-part="device-nameplate-meta">
          <span className="cb-nameplate-origin" data-part="device-nameplate-origin">
            {originLabel}
          </span>
          <span className="cb-nameplate-status" data-part="device-nameplate-status">
            <span
              className="cb-nameplate-light"
              data-part="device-nameplate-light"
              data-state={state}
              aria-hidden="true"
            />
            {stateLabel}
          </span>
          {badge ? (
            <span className="cb-nameplate-badge" data-part="device-nameplate-badge">
              {badge}
            </span>
          ) : null}
        </span>
      </div>
      <div className="cb-nameplate-figures" data-part="device-nameplate-figures">
        <span className="cb-nameplate-figure" data-part="device-nameplate-figure">
          <span className="cb-nameplate-label" data-part="device-nameplate-label">
            {versionText}
          </span>
          <span className="cb-nameplate-value" data-part="device-nameplate-value">
            {version ? versionLabel(version) : "—"}
          </span>
        </span>
        <span className="cb-nameplate-figure" data-part="device-nameplate-figure">
          <span className="cb-nameplate-label" data-part="device-nameplate-label">
            {lastSeenText}
          </span>
          <span className="cb-nameplate-value" data-part="device-nameplate-value">
            {lastSeen ? <DateTime value={lastSeen} /> : neverText}
          </span>
        </span>
        {created != null ? (
          <span className="cb-nameplate-figure" data-part="device-nameplate-figure">
            <span className="cb-nameplate-label" data-part="device-nameplate-label">
              {createdText}
            </span>
            <span className="cb-nameplate-value" data-part="device-nameplate-value">
              <DateTime value={created} />
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
