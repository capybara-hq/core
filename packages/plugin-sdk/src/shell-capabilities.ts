/**
 * Desktop shell capabilities (desktop client spec §8): the shapes of the objects a desktop shell
 * puts in `window.capybaraShell.capabilities` under the keys of `SHELL_CAPABILITY_KEYS`. Types and
 * key constants only; `capybara-hq/clients` implements them. A rejected call carries
 * `{ code: ShellCallError }`.
 */

/** Capability keys, `name@major`; each value is a key of `SHELL_CAPABILITIES`. */
export const SHELL_CAPABILITY_KEYS = {
  chrome: "chrome@1",
  device: "device@1",
  notify: "notify@1",
  openExternal: "openExternal@1",
  signIn: "signIn@1",
  haptics: "haptics@1",
  share: "share@1",
  menu: "menu@1",
} as const;

export type KeepAwakeMode = "off" | "while-busy" | "connected";

export type DeviceConnection = "starting" | "online" | "offline" | "draining" | "stopped";

/** What this machine is to the deployment the shell shows. */
export type ThisMachineStatus =
  | { state: "not_connected" }
  | { state: "connected_elsewhere"; origin: string }
  | {
      state: "connected";
      deviceId: string;
      orgId: string;
      mode: "os" | "docker";
      connection: DeviceConnection;
      offlineReason?: string;
      serviceInstalled: boolean;
      keepAwake: { mode: KeepAwakeMode; held: boolean; unavailable?: string };
      lastWakeAt?: string;
    };

/** One operation running on this machine for the deployment. */
export interface RunningOperationView {
  tag: string;
  conversationId: string | null;
  accountId: string | null;
  isolation: "restricted" | "full";
  startedAt: string;
}

/** The `code` of a rejected shell call. */
export type ShellCallError = "busy" | "no_activation" | "cancelled" | "failed";

/**
 * A change to this machine's owner ceiling, as `capybara-device ceiling set` takes it
 * (`--outside-sandbox on|off`, `--network open|allowlist`, `--project-reach workspace|os-user`):
 * only the fields to change. A field left out is never touched, so a stale value on the page can
 * never narrow it. A widening needs the shell's native confirmation; a narrowing applies at once.
 */
export interface DeviceCeilingRequest {
  outsideSandbox?: boolean;
  network?: "open" | "allowlist";
  projectReach?: "workspace" | "os-user";
}

/** `device@1`: connect this machine to the deployment as a device. */
export interface DeviceCapabilityV1 {
  status(): Promise<ThisMachineStatus>;
  onStatus(listener: (s: ThisMachineStatus) => void): () => void;
  running(): Promise<RunningOperationView[]>;
  connect(input: { orgId: string; deviceId?: string }): Promise<"connected" | "cancelled">;
  pause(): Promise<void>;
  resume(): Promise<"resumed" | "cancelled">;
  disconnect(): Promise<void>;
  requestCeiling(input: DeviceCeilingRequest): Promise<"applied" | "cancelled">;
  setKeepAwake(mode: KeepAwakeMode): Promise<"applied" | "cancelled">;
}

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
} as const;

/** The menu item id pattern, checked on `menu@1.show` (the shell validates every input). */
export const MENU_ITEM_ID = /^[A-Za-z0-9_.-]{1,64}$/;
