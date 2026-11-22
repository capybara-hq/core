import type { DesignKey } from "../i18n";

/** The label of a row's ⋯ button on compact: it names its row; no name, the plain label. */
export function rowActionsLabel(t: (key: DesignKey) => string, name: string | undefined): string {
  return name === undefined || name === ""
    ? t("table.rowActions")
    : t("table.rowActionsOf").replace("{title}", name);
}
