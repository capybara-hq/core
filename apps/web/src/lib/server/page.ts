import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ApiClientError } from "../api";
import { loginPathFor } from "../auth-sources";
import { PATH_HEADER } from "../headers";

export { PATH_HEADER };

/** The path (with its query) of the page being rendered; `/` when the proxy did not record it. */
export async function currentPath(): Promise<string> {
  return (await headers()).get(PATH_HEADER) ?? "/";
}

/** A 401 `auth.*`: the session is gone, the page signs in again. */
export const isSignedOut = (e: unknown): e is ApiClientError =>
  e instanceof ApiClientError && e.status === 401 && e.code.startsWith("auth.");

/** The kernel could not be reached (the proxy saw it down, or the read failed in transit). */
export const isKernelUnavailable = (e: unknown): e is ApiClientError =>
  e instanceof ApiClientError && (e.code === "upstream_unavailable" || e.code === "network");

/**
 * A page's read: a 401 `auth.*` redirects to sign-in (back to this page afterwards), a 404 is the
 * page's not-found, anything else throws to `error.tsx`.
 */
export async function read<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (isSignedOut(e)) redirect(loginPathFor(await currentPath()));
    if (e instanceof ApiClientError && e.status === 404) notFound();
    throw e;
  }
}

/**
 * A read of something the page draws its own fallback for (a secondary section, a value with a
 * default): any failure resolves to `null` and the client view reads it again after mount or uses
 * its default. A 401 `auth.*` still signs in, and an unreachable kernel still throws.
 */
export async function soft<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (isSignedOut(e)) redirect(loginPathFor(await currentPath()));
    if (isKernelUnavailable(e)) throw e;
    return null;
  }
}

/**
 * A read the page can do without when the kernel refuses it: a 403 or 404 resolves to `null`. A 401
 * `auth.*` still signs in; anything else (kernel unavailable, network, 5xx, other 4xx) throws.
 */
export async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (isSignedOut(e)) redirect(loginPathFor(await currentPath()));
    if (e instanceof ApiClientError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}
