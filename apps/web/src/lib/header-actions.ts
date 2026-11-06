import type { HeaderAction } from "@capybara-hq/design";

/**
 * A page head's actions while one of them runs (spec §6.17, never a click that seems to do
 * nothing): the running one keeps its loading state, the head's other buttons and links are
 * disabled until it settles. Menus are left as they are (a menu of disabled items would vanish).
 */
export function lockWhileRunning(actions: readonly HeaderAction[], busy?: boolean): HeaderAction[] {
  const running = busy === true || actions.some((a) => !("menu" in a) && a.loading === true);
  if (!running) return [...actions];
  return actions.map((a) =>
    "menu" in a || a.loading === true || a.href !== undefined ? a : { ...a, disabled: true },
  );
}
