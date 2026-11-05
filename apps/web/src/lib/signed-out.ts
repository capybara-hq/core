import { ApiClientError } from "./api";

/**
 * A 401 `auth.*` (after `apiFetch`'s own refresh retry): the session is gone, so the page or the
 * client signs in again. Shared by the server pages and the client's session guard.
 */
export const isSignedOut = (e: unknown): e is ApiClientError =>
  e instanceof ApiClientError && e.status === 401 && e.code.startsWith("auth.");
