/**
 * Shell environment (mobile layout spec §9, desktop client spec): the contract of the global a
 * native shell injects as `window.capybaraShell`, only into the top frame of the deployment's
 * origin. Types and the capability registry only; `capybara-hq/clients` implements it.
 */

export interface CapybaraShell {
  /** The envelope version; bumped only on an incompatible change of this shape. */
  readonly version: 1;
  /** Which shell: drives nothing but the shell attributes. */
  readonly kind: "desktop" | "mobile";
  /** The operating system, for platform conventions only (traffic lights, back gesture). */
  readonly platform: "macos" | "windows" | "linux" | "ios" | "android";
  /** The shell's own version, for reports and diagnostics; never parsed for features. */
  readonly shellVersion: string;
  /**
   * CSS px the shell's own chrome covers at each edge of the web view, beyond the OS safe areas
   * (macOS traffic lights with `titleBarStyle: hiddenInset`, a native title bar overlay).
   */
  readonly insets: { top: number; right: number; bottom: number; left: number };
  /**
   * The rectangle the shell's window controls occupy over the web view, in CSS px from the web
   * view's top-left corner (macOS traffic lights, a Windows caption-button overlay at the right);
   * null when there are none or they are hidden (fullscreen). Modelled on Window Controls
   * Overlay's `titlebar-area-*`. Optional: a shell without overlaid controls omits it.
   */
  readonly controls?: { x: number; y: number; width: number; height: number } | null;
  /** Capabilities by `name@major` (as extension points are named, `channel@1`). */
  readonly capabilities: Readonly<Record<string, object>>;
  /**
   * Insets, controls or capabilities changed (fullscreen hides the traffic lights; a capability
   * appears after load). Returns unsubscribe.
   */
  on(event: "change", listener: () => void): () => void;
}

declare global {
  interface Window {
    capybaraShell?: CapybaraShell;
  }
}

/**
 * The registry of capability names (mobile layout spec §9.2). A new capability is added here
 * (key, owner) by the spec that defines it; the owner names the spec holding its functions.
 */
export const SHELL_CAPABILITIES: readonly { key: string; owner: string }[] = [
  { key: "device@1", owner: "desktop client spec (2026-11-07-desktop-client-design.md)" },
  { key: "notify@1", owner: "desktop client spec (2026-11-07-desktop-client-design.md)" },
  { key: "openExternal@1", owner: "desktop client spec (2026-11-07-desktop-client-design.md)" },
  { key: "signIn@1", owner: "desktop client spec (2026-11-07-desktop-client-design.md), §6.5" },
  { key: "chrome@1", owner: "mobile layout spec (2026-11-19-mobile-layout-design.md)" },
];
