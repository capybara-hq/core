"use client";

import type { PageHeaderProps } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import {
  CAPABILITY_TABS,
  type Capability,
  type ExtensionTab,
  parseExtensionTab,
} from "../lib/extension-capabilities";
import { useUrlTab } from "../lib/url-tab";

/**
 * The 扩展 pages' tab by capability (`lib/extension-capabilities.ts`), kept in the address
 * (`?tab=<id>`, none for 全部; `lib/url-tab.ts`): a reload, a shared link or a link to the bare
 * page opens the matching tab. The page passes the tab its server props read.
 */
export function useExtensionTab(initial: ExtensionTab): [ExtensionTab, (t: ExtensionTab) => void] {
  return useUrlTab(initial, parseExtensionTab, "all");
}

/** The head's tabs: 全部 and the six capability tabs, each with its count (none while loading). */
export function useExtensionTabItems(
  counts: Record<ExtensionTab, number> | null,
  select: (t: ExtensionTab) => void,
): NonNullable<PageHeaderProps["tabs"]> {
  const t = useTranslations("extensions.tabs");
  return (["all", ...CAPABILITY_TABS] as const).map((id) => ({
    id,
    label: t(id),
    // While loading, a count of 0 marks the tab as counting (ListPage shows a dash).
    count: counts?.[id] ?? 0,
    onSelect: () => select(id),
  }));
}

/** A capability's chip text (`extensions.capability.<id>`; an unknown point shows its name). */
export function useCapabilityLabel(): (c: Capability) => string {
  const t = useTranslations("extensions.capability");
  return (c) => (c.startsWith("point:") ? c.slice("point:".length) : t(c));
}
