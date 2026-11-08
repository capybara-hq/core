import type { PermissionGroup } from "./extensions";

/**
 * What an extension can do, read from its permission groups (`provides` and the `tools` / `ui`
 * categories), and the 扩展 pages' tabs by capability (workspace `/extensions` and the admin
 * console's `/admin/extensions`). This module is the one place that maps extension points to tabs.
 *
 * - A tab per kind of capability: 模型, 网页, 连接器, 沙箱, 存储, and 工具与界面.
 * - An extension that provides points of two tabs is in both; in 全部 it is one row. Under a tab
 *   its row shows only what it provides there.
 * - 工具与界面 is the catch-all: an extension that provides none of the mapped points (only agent
 *   tools, UI views, or a point this module does not know, such as `channel` or a future one)
 *   falls there, so every extension sits in at least one capability tab and no 其他 tab exists.
 */

export const CAPABILITY_TABS = [
  "model",
  "web",
  "connector",
  "sandbox",
  "storage",
  "tools",
] as const;
export type CapabilityTab = (typeof CAPABILITY_TABS)[number];
export type ExtensionTab = "all" | CapabilityTab;

/** One thing an extension can do, drawn as a chip (`extensions.capability.<id>`). */
export type Capability =
  | "model"
  | "webSearch"
  | "webFetch"
  | "connector"
  | "sandbox"
  | "objectStore"
  | "channel"
  | "directory"
  | "identity"
  | "filePreview"
  | "tools"
  | "ui"
  /** A point this module does not name: shown by its own name. */
  | `point:${string}`;

/** Extension point (without its major version) → the capability it gives and its tab. */
const POINTS: Record<string, { capability: Capability; tab: CapabilityTab }> = {
  "model-provider": { capability: "model", tab: "model" },
  "web-search": { capability: "webSearch", tab: "web" },
  "web-fetch": { capability: "webFetch", tab: "web" },
  connector: { capability: "connector", tab: "connector" },
  sandbox: { capability: "sandbox", tab: "sandbox" },
  "object-store": { capability: "objectStore", tab: "storage" },
  // Points with no tab of their own: they go to the catch-all with a chip of their own.
  channel: { capability: "channel", tab: "tools" },
  directory: { capability: "directory", tab: "tools" },
  "identity-source": { capability: "identity", tab: "tools" },
  "file-preview": { capability: "filePreview", tab: "tools" },
};

/** The capability of an extension point ref (`sandbox@2` → `sandbox`; an unknown one by its name). */
export const capabilityOfPoint = (ref: string): Capability => {
  const p = ref.split("@")[0] ?? ref;
  return POINTS[p]?.capability ?? `point:${p}`;
};

const itemsOf = (groups: readonly PermissionGroup[], category: string): string[] =>
  groups.filter((g) => g.category === category).flatMap((g) => g.items);

/** The extension points an extension provides, without their major version (`web-search@1` → `web-search`). */
export const pointsOf = (groups: readonly PermissionGroup[]): string[] => [
  ...new Set(itemsOf(groups, "provides").map((i) => i.split("@")[0] ?? i)),
];

/** Each capability with the tab it belongs to, in a stable order (points first, then tools and UI). */
export function capabilitiesOf(
  groups: readonly PermissionGroup[],
): { capability: Capability; tab: CapabilityTab }[] {
  const out: { capability: Capability; tab: CapabilityTab }[] = pointsOf(groups).map(
    (p) => POINTS[p] ?? { capability: `point:${p}` as const, tab: "tools" },
  );
  if (itemsOf(groups, "tools").length > 0) out.push({ capability: "tools", tab: "tools" });
  if (itemsOf(groups, "ui").length > 0) out.push({ capability: "ui", tab: "tools" });
  return out;
}

/**
 * The capability tabs an extension sits in: the tabs of its mapped points; 工具与界面 when it maps to
 * none of the other tabs (tools, UI, an unknown point or nothing at all).
 */
export function tabsOf(groups: readonly PermissionGroup[]): CapabilityTab[] {
  const tabs = new Set(capabilitiesOf(groups).map((c) => c.tab));
  const own = CAPABILITY_TABS.filter((t) => t !== "tools" && tabs.has(t));
  return own.length > 0 ? own : ["tools"];
}

/** The capabilities a row shows under a tab: all of them in 全部, else only that tab's. */
export function capabilitiesIn(
  groups: readonly PermissionGroup[],
  tab: ExtensionTab,
): Capability[] {
  const all = capabilitiesOf(groups);
  if (tab === "all") return all.map((c) => c.capability);
  if (tab === "tools" && !tabsOf(groups).includes("tools")) return [];
  return all.filter((c) => c.tab === tab).map((c) => c.capability);
}

/** The rows of a tab: everything in 全部, else the extensions that sit in that tab. */
export function inTab<T>(
  rows: readonly T[],
  tab: ExtensionTab,
  groupsOf: (row: T) => readonly PermissionGroup[],
): T[] {
  return tab === "all" ? [...rows] : rows.filter((r) => tabsOf(groupsOf(r)).includes(tab));
}

/** The number of extensions in each tab (an extension counted once per tab it sits in). */
export function tabCounts<T>(
  rows: readonly T[],
  groupsOf: (row: T) => readonly PermissionGroup[],
): Record<ExtensionTab, number> {
  const counts = Object.fromEntries(["all", ...CAPABILITY_TABS].map((t) => [t, 0])) as Record<
    ExtensionTab,
    number
  >;
  for (const r of rows) {
    counts.all += 1;
    for (const t of tabsOf(groupsOf(r))) counts[t] += 1;
  }
  return counts;
}

/** A tab id from the URL (`?tab=`), or 全部 for anything else. */
export const parseExtensionTab = (raw: string | undefined | null): ExtensionTab =>
  raw !== undefined && raw !== null && (CAPABILITY_TABS as readonly string[]).includes(raw)
    ? (raw as CapabilityTab)
    : "all";

/**
 * Sorts rows into the order of the 扩展 pages: what needs attention first, then what is on, then
 * what is off or unavailable; by display name within each group (`rank` 0, 1, 2).
 */
export function sortExtensions<T>(
  rows: readonly T[],
  rank: (row: T) => 0 | 1 | 2,
  name: (row: T) => string,
  locale: string,
): T[] {
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b), locale, { sensitivity: "base" }),
  );
}

/** A row matches the search when its display name or its id contains the query (case-insensitive). */
export const matchesSearch = (query: string, ...texts: string[]): boolean => {
  const q = query.trim().toLowerCase();
  return q === "" || texts.some((t) => t.toLowerCase().includes(q));
};
