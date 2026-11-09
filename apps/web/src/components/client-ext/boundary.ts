"use client";

// The navigation boundary of client code (client extensions spec §9.6): modules cannot be
// unloaded, so the loaded set is fixed for a document. A client navigation to a page whose client
// set differs (workspace ↔ admin console, into or out of a `/admin/p/<plugin>/<id>` page) becomes a
// document navigation, so the admin console never runs org client code in the same document.
import { useEffect, useLayoutEffect, useRef } from "react";
import { usePathname } from "../../i18n/navigation";
import { type ClientScopeKey, clientScopeOf } from "../../lib/client-extensions";

/**
 * Whether a navigation from `from` to `to` must load a new document. Never in safe mode (a reload
 * without the parameter would end it); never within one scope. Out of a document that loaded client
 * code, always; into a scope that may carry client code (`targetHasCode` says unknown or yes), too:
 * the plain admin console carries none.
 */
export function crossesBoundary(
  from: ClientScopeKey,
  to: ClientScopeKey,
  o: { safe: boolean; loaded: boolean; targetHasCode(key: ClientScopeKey): boolean },
): boolean {
  if (o.safe || from === to) return false;
  if (o.loaded) return true;
  return to !== "admin" && o.targetHasCode(to);
}

/** A same-document link click the app router would take (left button, no modifier, same origin). */
function routerLinkTarget(e: MouseEvent): URL | null {
  if (e.defaultPrevented || e.button !== 0) return null;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a[href]");
  if (!(a instanceof HTMLAnchorElement)) return null;
  if (a.target !== "" && a.target !== "_self") return null;
  if (a.hasAttribute("download")) return null;
  const url = new URL(a.href, window.location.href);
  return url.origin === window.location.origin ? url : null;
}

/**
 * Enforces the boundary for the document: a link click across it is taken over before the router
 * sees it (capture phase) and becomes `navigate(href)`; any other client transition across it (a
 * `router.push`, Back / Forward) is caught when the path changes and reloads the new URL.
 */
export function useClientBoundary(o: {
  safe: boolean;
  loaded: boolean;
  targetHasCode(key: ClientScopeKey): boolean;
  navigate(href: string): void;
}): void {
  const pathname = usePathname();
  const latest = useRef(o);
  latest.current = o;
  // The scope of the document: where it was loaded (a crossing never lands in this document).
  const documentScope = useRef<ClientScopeKey | null>(null);
  if (documentScope.current === null) documentScope.current = clientScopeOf(pathname);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const url = routerLinkTarget(e);
      if (url === null) return;
      const from = documentScope.current ?? "org";
      if (!crossesBoundary(from, clientScopeOf(url.pathname), latest.current)) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.navigate(`${url.pathname}${url.search}${url.hash}`);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useLayoutEffect(() => {
    const from = documentScope.current ?? "org";
    if (!crossesBoundary(from, clientScopeOf(pathname), latest.current)) return;
    const loc = window.location;
    // The router updates the address before layout effects run; if not, the path alone.
    latest.current.navigate(
      loc.pathname === pathname ? `${loc.pathname}${loc.search}${loc.hash}` : pathname,
    );
  }, [pathname]);
}
