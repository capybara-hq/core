/**
 * Request headers the proxy (`src/proxy.ts`) sets for server code. They are trusted internal
 * headers: the proxy strips any client-sent copy before setting its own. Kept free of
 * `server-only` so the proxy can import them.
 */

/** Set by the proxy when the kernel could not renew or check the session (`unavailable`). */
export const SESSION_STATE_HEADER = "x-cap-session";

/** The request's path and query, as the proxy recorded it. */
export const PATH_HEADER = "x-cap-path";
