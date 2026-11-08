"use client";

import { useLocale, useTranslations } from "next-intl";
import { type Environment, environmentName } from "../lib/environments";
import { labelLocale } from "../lib/extension-label";

/** `environmentName` in the page's language: 个人环境 / 个人环境（Docker 沙箱） / the given name. */
export function useEnvironmentName(): (e: Pick<Environment, "name" | "demotedFrom">) => string {
  const t = useTranslations("environments");
  const locale = labelLocale(useLocale());
  return (e) =>
    environmentName(
      e,
      { personal: t("personal"), demoted: (provider) => t("demotedName", { provider }) },
      locale,
    );
}
