import type { PushPlatform } from "./push.js";

/**
 * Desktop shell capabilities (desktop client spec §8): the shapes of the objects a desktop shell
 * puts in `window.capybaraShell.capabilities` under the keys of `SHELL_CAPABILITY_KEYS`. Types and
 * key constants only; `capybara-hq/clients` implements them. A rejected call carries
 * `{ code: ShellCallError }`.
 */

/** Capability keys, `name@major`; each value is a key of `SHELL_CAPABILITIES`. */
export const SHELL_CAPABILITY_KEYS = {
  chrome: "chrome@1",
  notify: "notify@1",
  openExternal: "openExternal@1",
  signIn: "signIn@1",
  haptics: "haptics@1",
  share: "share@1",
  menu: "menu@1",
  nav: "nav@1",
  profiles: "profiles@1",
  push: "push@1",
} as const;

/** The `code` of a rejected shell call. */
export type ShellCallError = "busy" | "no_activation" | "cancelled" | "failed";

/** `notify@1`: a native notification; `path` is the in-app path opened on click. */
export interface NotifyCapabilityV1 {
  notify(input: { title: string; body: string; path?: string }): Promise<void>;
}

/** `openExternal@1`: open a URL in the system browser. */
export interface OpenExternalCapabilityV1 {
  open(url: string): Promise<void>;
}

/** `signIn@1`: sign in through the system browser (desktop client spec §6.5). */
export interface SignInCapabilityV1 {
  start(): Promise<"signedIn" | "cancelled">;
}

/**
 * The page's main color tokens (the computed `--cb-bg`, `--cb-panel`, `--cb-ink`, `--cb-muted`,
 * `--cb-line`, `--cb-accent`, `--cb-on-accent`), each a CSS hex or `rgb()` / `rgba()` color. The
 * shell validates them and uses them only as custom properties of its own pages, never as markup.
 */
export interface ShellChromeTokens {
  bg: string;
  panel: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  onAccent: string;
}

/**
 * `chrome@1` (mobile layout spec §9.2): the native chrome (window background, title bar, the
 * shell's own pages) follows the page's theme. `tokens` is sent only when all seven are colors;
 * `singleScheme` is true under a UI theme with one scheme (no light / dark toggle on either side).
 */
export interface ChromeCapabilityV1 {
  setAppearance(input: {
    scheme: "light" | "dark";
    background: string;
    tokens?: ShellChromeTokens;
    singleScheme?: boolean;
  }): Promise<void>;
  /** The web's first paint is done (mobile app spec §5.2); a shell may leave it out. */
  ready?(): Promise<void>;
}

export type HapticKind = "selection" | "light" | "success" | "warning";

/** `haptics@1`: a haptic impact (mobile app spec §5.2). */
export interface HapticsCapabilityV1 {
  impact(kind: HapticKind): Promise<void>;
}

export interface ShareInputV1 {
  title?: string;
  text?: string;
  url?: string;
}

/** `share@1`: the system share sheet; resolves whether shared or dismissed. */
export interface ShareCapabilityV1 {
  share(input: ShareInputV1): Promise<void>;
}

export interface MenuItemV1 {
  id: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

export interface MenuInputV1 {
  title?: string;
  items: MenuItemV1[];
  /** A rect in CSS px from the web view's top-left corner. */
  anchor?: { x: number; y: number; width: number; height: number };
}

/** `menu@1`: a native menu; resolves the chosen item id, or null when dismissed. */
export interface MenuCapabilityV1 {
  show(input: MenuInputV1): Promise<string | null>;
}

/** The shell validates every input against these (and the web keeps within them). */
export const MOBILE_SHELL_LIMITS = {
  menuItems: 12,
  menuLabel: 64,
  menuTitle: 128,
  shareTitle: 256,
  shareText: 4000,
  url: 2048,
  /** `nav@1`: an item or action label is 1..32 characters. */
  navLabel: 32,
  /** `nav@1`: a badge count is an integer 0..9999 (`countMore` says there are more). */
  navCount: 9999,
  /** `nav@1`: the account's name is 1..64 characters (its initial 1..2). */
  navAccountName: 64,
} as const;

/** The menu item id pattern, checked on `menu@1.show` (the shell validates every input). */
export const MENU_ITEM_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The strip's items: the four sections and, last, `search` (opens the web's command palette; never
 * `current`).
 */
export type NavSectionId = "chats" | "inbox" | "agents" | "schedules" | "search";

/** The strip's items in display order. */
export const NAV_SECTION_ORDER: readonly NavSectionId[] = [
  "chats",
  "inbox",
  "agents",
  "schedules",
  "search",
];

export interface NavBadgeV1 {
  count?: number;
  countMore?: boolean;
}

export interface NavItemV1 extends NavBadgeV1 {
  id: NavSectionId;
  label: string;
}

/**
 * The pill's top item, accent-filled: the page's primary action, else the new conversation
 * (`id` matches MENU_ITEM_ID, `label` 1..navLabel; the shell draws its own glyph per `icon`).
 */
export interface NavActionV1 {
  id: string;
  label: string;
  icon: "plus" | "square-pen";
}

/**
 * The account avatar under the strip's status: the image at `avatarUrl` (an absolute https URL
 * or one on the profile's origin), else `initial` in a circle; `badge` a count 0..navCount.
 */
export interface NavAccountV1 {
  name: string;
  avatarUrl?: string | null;
  initial: string;
  badge?: number;
}

export interface NavStateV1 {
  /** The items the person sees, in NAV_SECTION_ORDER (a guest has no `schedules`). */
  items: NavItemV1[];
  /**
   * The section of the page on screen; `null`: no section is selected and the shell clears its
   * highlight (the new-conversation home, a page outside the sections). Never `search`.
   */
  current: NavSectionId | null;
  /** The pill's top item: the page's primary, else the new conversation (no menu button, D12). */
  action: NavActionV1;
  /** The avatar under the status (absent: the shell shows none). */
  account?: NavAccountV1;
}

/**
 * `nav@1`: offered only while the window has a strip (mobile app spec §6.1): presence is
 * visibility. `side` is the edge the strip is on (right unless the app is the left one of a
 * split), reported with the capability and updated with the envelope's `change`. The shell and
 * the web ship this shape in lockstep (no older-shell path before 0.1.0): the shell's nav@1
 * minor version of 2026-11-22 ships with or before the web that sends it.
 */
export interface NavCapabilityV1 {
  set(state: NavStateV1): Promise<void>;
  onSelect(listener: (id: NavSectionId) => void): () => void;
  /** The pill's top item was tapped: the web runs the action. */
  onAction(listener: () => void): () => void;
  /** The account avatar was tapped: the web opens its account sheet. */
  onAccount(listener: () => void): () => void;
  readonly side?: "left" | "right";
}

/** `profiles@1`: the native profile switcher. */
export interface ProfilesCapabilityV1 {
  /** Opens the native profile switcher; resolves when it closes, with nothing. */
  show(): Promise<void>;
}

export type PushPermission = "granted" | "denied" | "prompt";

export interface PushStatus {
  permission: PushPermission;
  /** The server-side registration id this install holds, or null. */
  registrationId: string | null;
  /** The OS token differs from the one last registered. */
  tokenChanged: boolean;
}

/** What the shell hands the web app to register with the deployment. */
export interface PushRegistration {
  platform: PushPlatform;
  appId: string;
  provider: string;
  token: string;
}

/** `push@1`: native push registration (mobile shells). */
export interface PushCapabilityV1 {
  status(): Promise<PushStatus>;
  /** User activation only when permission is "prompt"; rejects { code: "cancelled" } when denied. */
  register(): Promise<PushRegistration>;
  /** Tells the shell the deployment's registration id for this install. */
  registered(id: string): Promise<void>;
  unregister(): Promise<void>;
}
