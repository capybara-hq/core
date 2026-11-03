import "server-only";
// Registers the server transport (idempotent), whatever module a page loads first.
import "./register";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ApiClientError } from "../api";
import { loginPathFor } from "../auth-sources";
import { PATH_HEADER } from "../headers";
import { isSignedOut } from "../signed-out";

export { PATH_HEADER };

/** The path (with its query) of the page being rendered; `/` when the proxy did not record it. */
export async function currentPath(): Promise<string> {
  return (await headers()).get(PATH_HEADER) ?? "/";
}

export { isSignedOut };

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
 * A secondary section's read (web-SSR spec §6.2, ruling R5): when the kernel fails it (5xx) or
 * refuses it (403 / 404) it resolves to `null` and the view draws that section's own error or empty
 * state, never a read after mount. A 401 `auth.*` still signs in, an unreachable kernel still
 * throws, and anything else (another 4xx, a bug in the page's code) throws to `error.tsx`.
 */
export async function section<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (isSignedOut(e)) redirect(loginPathFor(await currentPath()));
    if (isKernelUnavailable(e)) throw e;
    if (e instanceof ApiClientError && (e.status >= 500 || e.status === 403 || e.status === 404))
      return null;
    throw e;
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
