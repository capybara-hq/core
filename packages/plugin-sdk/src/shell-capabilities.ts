/**
 * Desktop shell capabilities (desktop client spec §8): the shapes of the objects a desktop shell
 * puts in `window.capybaraShell.capabilities` under the keys of `SHELL_CAPABILITY_KEYS`. Types and
 * key constants only; `capybara-hq/clients` implements them. A rejected call carries
 * `{ code: ShellCallError }`.
 */

/** Capability keys, `name@major`; each value is a key of `SHELL_CAPABILITIES`. */
export const SHELL_CAPABILITY_KEYS = {
  device: "device@1",
  notify: "notify@1",
  openExternal: "openExternal@1",
  signIn: "signIn@1",
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
