import "server-only";
// Registers the server transport (idempotent), whatever module a page loads first.
import "./register";
import { headers } from "next/headers";
import { ApiClientError } from "../api";
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
