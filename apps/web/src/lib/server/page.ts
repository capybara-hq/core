import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ApiClientError } from "../api";
import { loginPathFor } from "../auth-sources";

/** The request's path and query, as the proxy recorded it (`x-cap-path`). */
export const PATH_HEADER = "x-cap-path";

/** The path (with its query) of the page being rendered; `/` when the proxy did not record it. */
export async function currentPath(): Promise<string> {
  return (await headers()).get(PATH_HEADER) ?? "/";
}

const signedOut = (e: unknown): e is ApiClientError =>
  e instanceof ApiClientError && e.status === 401 && e.code.startsWith("auth.");

/**
 * A page's read: a 401 `auth.*` redirects to sign-in (back to this page afterwards), a 404 is the
 * page's not-found, anything else throws to `error.tsx`.
 */
export async function read<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (signedOut(e)) redirect(loginPathFor(await currentPath()));
    if (e instanceof ApiClientError && e.status === 404) notFound();
    throw e;
  }
}

/** A read the page can do without: a failure resolves to `null` (a 401 still signs in). */
export async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (signedOut(e)) redirect(loginPathFor(await currentPath()));
    if (e instanceof ApiClientError) return null;
    throw e;
  }
}
