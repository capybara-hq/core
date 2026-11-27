import type { LibraryFilter, LibraryOrigin, LibraryType } from "./library-files";

/**
 * The Files page's filters in the address (file library spec §6): `?origin=` (the head's tabs),
 * `?agent=`, `?type=` and `?q=` (the search). Pure, so the route table reads the same filter the
 * view does and the first paint finds its list in the cache.
 */

export const LIBRARY_ORIGINS: readonly LibraryOrigin[] = ["delivered", "generated", "upload"];
export const LIBRARY_TYPES: readonly LibraryType[] = ["image", "document", "text", "other"];

/** The address's filters as the view holds them: "" for none. */
export interface FilesUrl {
  origin: LibraryOrigin | "";
  agent: string;
  type: LibraryType | "";
  q: string;
}

export const parseOrigin = (raw: string | null | undefined): LibraryOrigin | "" =>
  LIBRARY_ORIGINS.find((o) => o === raw) ?? "";
export const parseType = (raw: string | null | undefined): LibraryType | "" =>
  LIBRARY_TYPES.find((o) => o === raw) ?? "";
/** The kernel takes at most 100 characters of an agent id and 200 of a search. */
export const parseAgent = (raw: string | null | undefined): string => (raw ?? "").slice(0, 100);
export const parseSearch = (raw: string | null | undefined): string => (raw ?? "").slice(0, 200);

type Search = URLSearchParams | Record<string, string | string[] | undefined>;

const get = (s: Search, name: string): string | undefined => {
  if (s instanceof URLSearchParams) return s.get(name) ?? undefined;
  const v = s[name];
  return Array.isArray(v) ? v[0] : v;
};

/** The filters of a page address (server props or the route's search params). */
export function filesUrlOf(search: Search): FilesUrl {
  return {
    origin: parseOrigin(get(search, "origin")),
    agent: parseAgent(get(search, "agent")),
    type: parseType(get(search, "type")),
    q: parseSearch(get(search, "q")),
  };
}

/** The list read for the filters: only the fields set (each set is its own cache entry). */
export function libraryFilterOf(u: FilesUrl): LibraryFilter {
  const q = u.q.trim();
  return {
    ...(u.origin !== "" && { origin: u.origin }),
    ...(u.agent !== "" && { agentId: u.agent }),
    ...(u.type !== "" && { type: u.type }),
    ...(q !== "" && { q }),
  };
}

/** How many of the field filters (agent, type) are set: the compact Filter button's count. */
export const fieldFilterCount = (u: FilesUrl): number =>
  (u.agent !== "" ? 1 : 0) + (u.type !== "" ? 1 : 0);

/** Whether any filter narrows the list (an empty answer is then the filtered-empty state). */
export const isFiltered = (u: FilesUrl): boolean =>
  u.origin !== "" || u.agent !== "" || u.type !== "" || u.q.trim() !== "";
