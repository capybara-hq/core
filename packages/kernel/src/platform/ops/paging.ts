import { z } from "zod";

/** `params.cursor` of a paged operation: the `next` of the previous page (an opaque string). */
export const Cursor = z
  .string()
  .regex(/^\d{1,7}$/, "pass the next value of the previous page")
  .describe("The next value of the previous page; omit for the first page.");

/** The offset a cursor stands for (0 without one). */
export const startOf = (cursor: string | undefined): number =>
  cursor === undefined ? 0 : Number(cursor);

/**
 * One page of `items` from `start` (ruling: lists that can exceed 50 entries page themselves):
 * `next` is the cursor of the following page, null on the last one.
 */
export function pageOf<T>(
  items: readonly T[],
  start: number,
  size: number,
): { items: T[]; total: number; next: string | null } {
  const end = start + size;
  return {
    items: items.slice(start, end),
    total: items.length,
    next: end < items.length ? String(end) : null,
  };
}
