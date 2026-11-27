import { filesUrlOf } from "../../../lib/files-url";
import FilesView from "./view";

/**
 * `/files` (Files): the person's file library (file library spec §6), filtered by the address
 * (`?origin=`, `?agent=`, `?type=`, `?q=`); the open file is the hash (`#item=<id>`). It reads
 * nothing: the layout prefetches the list for these filters and the usage on a first load
 * (`lib/query/routes.ts`), and the view reads them from the cache.
 */
export default async function FilesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <FilesView initial={filesUrlOf((await searchParams) ?? {})} />;
}
