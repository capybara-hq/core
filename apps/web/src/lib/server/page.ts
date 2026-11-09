import "server-only";
// Registers the server transport (idempotent), whatever module a page loads first.
import "./register";
import { headers } from "next/headers";
import { ApiClientError } from "../api";
import { NONCE_HEADER, PATH_HEADER } from "../headers";
import { isSignedOut } from "../signed-out";

export { PATH_HEADER };

/** The path (with its query) of the page being rendered; `/` when the proxy did not record it. */
export async function currentPath(): Promise<string> {
  return (await headers()).get(PATH_HEADER) ?? "/";
}

/**
 * The document's CSP nonce, for scripts a layout renders itself (`<script nonce>`); Next's own
 * scripts carry it already. `""` when the proxy did not run (then the document has no CSP either).
 */
export async function currentNonce(): Promise<string> {
  return (await headers()).get(NONCE_HEADER) ?? "";
}

export { isSignedOut };

/** The kernel could not be reached (the proxy saw it down, or the read failed in transit). */
export const isKernelUnavailable = (e: unknown): e is ApiClientError =>
  e instanceof ApiClientError && (e.code === "upstream_unavailable" || e.code === "network");
