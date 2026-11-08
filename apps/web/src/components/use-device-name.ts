"use client";

import { useLocale, useTranslations } from "next-intl";
import { type Device, deviceName } from "../lib/devices";
import { labelLocale } from "../lib/extension-label";

/** `deviceName` in the page's language: 个人设备 / 个人设备（Docker 沙箱） / the given name. */
export function useDeviceName(): (e: Pick<Device, "name" | "demotedFrom">) => string {
  const t = useTranslations("devices");
  const locale = labelLocale(useLocale());
  return (e) =>
    deviceName(
      e,
      { personal: t("personal"), demoted: (provider) => t("demotedName", { provider }) },
      locale,
    );
}
