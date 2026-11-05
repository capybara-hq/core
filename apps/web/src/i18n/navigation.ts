import NextLink from "next/link";
import {
  redirect as nextRedirect,
  usePathname as nextUsePathname,
  useRouter as nextUseRouter,
} from "next/navigation";

/**
 * Navigation for the app's pages. URLs carry no language prefix (the language is a cookie, see
 * `routing.ts`), so these are Next's own; pages import them from here so tests can swap them.
 */
export const Link = NextLink;
export const usePathname = nextUsePathname;
export const useRouter = nextUseRouter;
export const redirect = nextRedirect;
