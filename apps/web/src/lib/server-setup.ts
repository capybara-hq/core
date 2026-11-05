import { kernelUrl } from "./kernel-proxy";

/** The kernel's access-token cookie (`cap_at`, Path=/): present on page requests while signed in. */
export const ACCESS_COOKIE = "cap_at";

/** How long a page request waits for the kernel before leaving the decision to the browser. */
const SETUP_CHECK_TIMEOUT_MS = 3000;

/**
 * Server side, before a page renders: does the deployment still need its first admin
 * (`GET /api/v1/setup`)? `undefined` when the kernel can't answer (starting, unreachable): the
 * page then renders and the browser decides as before.
 */
export async function serverNeedsSetup(): Promise<boolean | undefined> {
  try {
    const res = await fetch(`${kernelUrl()}/api/v1/setup`, {
      cache: "no-store",
      signal: AbortSignal.timeout(SETUP_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { needsSetup?: unknown };
    return typeof body.needsSetup === "boolean" ? body.needsSetup : undefined;
  } catch {
    return undefined;
  }
}
