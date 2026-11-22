"use client";

import { useTranslations } from "next-intl";
import { type Device, deviceName } from "../lib/devices";

/** `deviceName` in the page's language: the localized "Personal" label or the given name. */
export function useDeviceName(): (e: Pick<Device, "name">) => string {
  const t = useTranslations("devices");
  return (e) => deviceName(e, t("personal"));
}
