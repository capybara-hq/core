import { useEffect, useState } from "react";
import { PAGE_BACKGROUND } from "../tokens";

export { SHELL_ENVIRONMENT_SCRIPT, ShellEnvironmentScript } from "./shell-environment-script";

/**
 * The Shell environment as the design package reads it (mobile layout spec §9): the global a
 * native shell injects, `window.capybaraShell`, is read only here and in apps/web's `lib/shell.ts`
 * (`web-shell-access`). The global is untrusted input: every field is checked before it reaches
 * the document, with the same rules as the inline script (`shell-environment-script.tsx`).
 */

export type ShellKind = "desktop" | "mobile";
export type ShellPlatform = "macos" | "windows" | "linux" | "ios" | "android";

/** What the shell reports, checked: the only values the document is ever given. */
export interface ShellEnvironment {
  kind: ShellKind;
  platform: ShellPlatform | null;
  insets: { top: number; right: number; bottom: number; left: number };
  controls: { x: number; y: number; width: number; height: number } | null;
}

/** The part of the global the design package uses: its change subscription and capabilities. */
interface ShellHandle {
  on(event: "change", listener: () => void): () => void;
  capabilities?: unknown;
}

const PLATFORMS: readonly string[] = ["macos", "windows", "linux", "ios", "android"];
const SIDES = ["top", "right", "bottom", "left"] as const;
const CONTROLS = ["x", "y", "width", "height"] as const;
/** The largest inset a shell may report (CSS px); more is clamped. */
const MAX_INSET = 512;
/** The bounds of the controls rectangle (CSS px); a value past them drops the rectangle. */
const MAX_CONTROLS = { x: 16384, y: 512, width: 512, height: 512 } as const;

const round = (v: number) => Math.round(v * 100) / 100;
const inset = (v: unknown) =>
  typeof v === "number" && v >= 0 && v < Number.POSITIVE_INFINITY
    ? round(Math.min(v, MAX_INSET))
    : 0;
const within = (v: unknown, max: number): v is number =>
  typeof v === "number" && v >= 0 && v <= max;

/** The global, when this is the top frame and it has envelope version 1; else null. */
function shellOf(win: Window): (Record<string, unknown> & ShellHandle) | null {
  try {
    if (win !== win.top) return null;
    const s = (win as Window & { capybaraShell?: unknown }).capybaraShell;
    if (s === null || typeof s !== "object") return null;
    const shell = s as Record<string, unknown>;
    if (shell.version !== 1 || typeof shell.on !== "function") return null;
    return shell as Record<string, unknown> & ShellHandle;
  } catch {
    return null;
  }
}

/**
 * The shell's environment, checked (spec §9.1, §9.3): null outside the top frame, without the
 * global, for another envelope version or an unknown kind. Insets are clamped to 0–512; a controls
 * rectangle with any value that is not a finite non-negative number within bounds is dropped.
 */
export function readShellEnvironment(win: Window): ShellEnvironment | null {
  try {
    const shell = shellOf(win);
    if (shell === null) return null;
    const kind = shell.kind;
    if (kind !== "desktop" && kind !== "mobile") return null;
    const platform = shell.platform;
    const rawInsets = shell.insets;
    const ins = (side: (typeof SIDES)[number]) =>
      rawInsets !== null && typeof rawInsets === "object"
        ? inset((rawInsets as Record<string, unknown>)[side])
        : 0;
    const rawControls = shell.controls;
    let controls: ShellEnvironment["controls"] = null;
    if (rawControls !== null && typeof rawControls === "object") {
      const c = rawControls as Record<string, unknown>;
      const { x, y, width, height } = c;
      if (
        within(x, MAX_CONTROLS.x) &&
        within(y, MAX_CONTROLS.y) &&
        within(width, MAX_CONTROLS.width) &&
        within(height, MAX_CONTROLS.height)
      ) {
        controls = { x: round(x), y: round(y), width: round(width), height: round(height) };
      }
    }
    return {
      kind,
      platform:
        typeof platform === "string" && PLATFORMS.includes(platform)
          ? (platform as ShellPlatform)
          : null,
      insets: { top: ins("top"), right: ins("right"), bottom: ins("bottom"), left: ins("left") },
      controls,
    };
  } catch {
    return null;
  }
}

/**
 * Writes a checked environment on `<html>` (the attributes and properties the inline script
 * sets), or clears them all for null. Only these two attributes and eight properties are written.
 */
export function applyShellEnvironment(root: HTMLElement, env: ShellEnvironment | null): void {
  if (env === null) {
    root.removeAttribute("data-shell");
    root.removeAttribute("data-shell-platform");
    for (const side of SIDES) root.style.removeProperty(`--cb-shell-inset-${side}`);
    for (const name of CONTROLS) root.style.removeProperty(`--cb-shell-controls-${name}`);
    return;
  }
  root.setAttribute("data-shell", env.kind);
  if (env.platform === null) root.removeAttribute("data-shell-platform");
  else root.setAttribute("data-shell-platform", env.platform);
  for (const side of SIDES)
    root.style.setProperty(`--cb-shell-inset-${side}`, `${env.insets[side]}px`);
  for (const name of CONTROLS) {
    if (env.controls === null) root.style.removeProperty(`--cb-shell-controls-${name}`);
    else root.style.setProperty(`--cb-shell-controls-${name}`, `${env.controls[name]}px`);
  }
}

/** `chrome@1` when the shell offers it with a `setAppearance` function. */
function chromeOf(shell: ShellHandle): { setAppearance: (a: unknown) => unknown } | null {
  try {
    const caps = shell.capabilities;
    if (caps === null || typeof caps !== "object" || !Object.hasOwn(caps, "chrome@1")) return null;
    const chrome = (caps as Record<string, unknown>)["chrome@1"];
    if (chrome === null || typeof chrome !== "object") return null;
    const set = (chrome as Record<string, unknown>).setAppearance;
    return typeof set === "function"
      ? (chrome as { setAppearance: (a: unknown) => unknown })
      : null;
  } catch {
    return null;
  }
}

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s/]+\))$/i;

/** The page's background token for the scheme (the computed `--cb-bg`, else the built-in one). */
function backgroundOf(root: HTMLElement, scheme: "dark" | "light"): string {
  const computed = getComputedStyle(root).getPropertyValue("--cb-bg").trim();
  return COLOR.test(computed) ? computed : PAGE_BACKGROUND[scheme];
}

/**
 * The AppShell's side of the Shell environment (spec §9.3), after hydration: re-reads the
 * environment on every `change` (fullscreen hides the traffic lights, a capability appears) and
 * writes it on `<html>`; tells `chrome@1.setAppearance` the scheme and background on mount and
 * once per theme change. Returns the shell's kind for the `shell=` state token, null in a browser
 * and before hydration. Unsubscribes on unmount.
 */
export function useShellEnvironment(): ShellKind | null {
  const [kind, setKind] = useState<ShellKind | null>(null);
  useEffect(() => {
    const shell = shellOf(window);
    if (shell === null) return;
    const root = document.documentElement;
    let sent: string | null = null;
    const appearance = () => {
      const chrome = chromeOf(shell);
      if (chrome === null) return;
      const scheme = root.dataset.theme === "light" ? "light" : "dark";
      const background = backgroundOf(root, scheme);
      const key = `${scheme} ${background}`;
      if (key === sent) return;
      sent = key;
      try {
        const r = chrome.setAppearance({ scheme, background });
        // a rejected call is the shell's business: the page keeps its own theme either way
        Promise.resolve(r).catch(() => {});
      } catch {
        // the native chrome keeps the shell's defaults
      }
    };
    const sync = () => {
      const env = readShellEnvironment(window);
      applyShellEnvironment(root, env);
      setKind(env?.kind ?? null);
      appearance();
    };
    sync();
    let off: (() => void) | undefined;
    try {
      const r = shell.on("change", sync);
      if (typeof r === "function") off = r;
    } catch {
      // a shell that cannot subscribe: the first read stays
    }
    const observer =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(appearance);
    observer?.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      observer?.disconnect();
      try {
        off?.();
      } catch {
        // already gone
      }
    };
  }, []);
  return kind;
}
