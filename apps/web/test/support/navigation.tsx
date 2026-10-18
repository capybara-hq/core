/**
 * `src/i18n/navigation` 的测试替身：页面测试里 `vi.mock("../src/i18n/navigation", () => import("./support/navigation"))`，
 * 再从本模块取 `router` 断言跳转。
 */
import type { ReactNode } from "react";
import { vi } from "vitest";

export const router = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
  forward: vi.fn(),
};

export const pathname = { current: "/" };

export const usePathname = () => pathname.current;
export const useRouter = () => router;
export const redirect = vi.fn();
export const getPathname = vi.fn();

export function Link({
  href,
  children,
  locale: _locale,
  ...rest
}: {
  href: string;
  children?: ReactNode;
  locale?: string;
  [k: string]: unknown;
}) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

export function resetNavigation(path = "/") {
  pathname.current = path;
  for (const fn of Object.values(router)) fn.mockReset();
}
