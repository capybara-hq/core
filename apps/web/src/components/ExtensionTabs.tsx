"use client";

import type { PageHeaderProps } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CAPABILITY_TABS, type Capability, type ExtensionTab } from "../lib/extension-capabilities";

/**
 * The 扩展 pages' tab by capability (`lib/extension-capabilities.ts`): held in state for an instant
 * switch and written to the URL (`?tab=<id>`, none for 全部) so a reload or a shared link opens
 * the same tab. The page passes the tab its server props read.
 */
export function useExtensionTab(initial: ExtensionTab): [ExtensionTab, (t: ExtensionTab) => void] {
  const [tab, setTab] = useState<ExtensionTab>(initial);
  const select = (next: ExtensionTab) => {
    setTab(next);
    // In an event handler, never during render (web-ssr-location).
    const url = new URL(window.location.href);
    if (next === "all") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  };
  return [tab, select];
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
