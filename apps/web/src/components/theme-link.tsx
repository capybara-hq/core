import type { ThemeRef } from "../lib/themes";

/**
 * The resolved theme's stylesheet (themes spec §8), served by the kernel (immutable per version).
 * React hoists it into `<head>` in the `theme` precedence, after the design stylesheet, and the
 * streamed document waits for it, so the first paint is themed. React keeps a superseded link in
 * `<head>`; `ThemeRoot` disables every theme link but the current one. Nothing for the built-in
 * theme.
 */
export function ThemeLink({ theme }: { theme: ThemeRef | null }) {
  if (theme === null) return null;
  return <link rel="stylesheet" href={theme.cssUrl} precedence="theme" />;
}
