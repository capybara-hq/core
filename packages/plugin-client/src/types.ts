import type { ReactNode } from "react";

/** A JSON value (what `UiView.data` and action payloads carry). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A server-rendered extension view (`ctx.ui.view`). The blocks are the SDK's `UiBlock`s; this
 * package imports no SDK, so a block is typed by its `type` only.
 */
export interface UiView {
  badge?: string;
  open?: unknown;
  blocks: Array<{ type: string; [key: string]: unknown }>;
  /** Only a component's view carries data (at most 32 768 bytes of JSON). */
  data?: JsonValue;
}

export type RunState = "idle" | "running" | "waiting" | "failed";

export type ClientRole = "owner" | "admin" | "member" | "guest" | "superAdmin";

/** localStorage / sessionStorage under the prefix "cap-ext:<plugin>:"; never throws. */
export interface ClientStorage {
  get(key: string, scope?: "local" | "session"): string | null;
  set(key: string, value: string | null, scope?: "local" | "session"): void;
}

export type CapybaraEventType =
  | "run.started"
  | "run.finished"
  | "run.failed"
  | "message.sent"
  | "message.received"
  | "tool.started"
  | "tool.finished"
  | "approval.requested";

export interface EventBase {
  conversationId: string;
  seq: number;
  /** ISO time of the event. */
  at: string;
}

export type CapybaraEvent =
  | ({ type: "run.started" } & EventBase)
  | ({ type: "run.finished"; reason: string } & EventBase)
  | ({ type: "run.failed"; code: string } & EventBase)
  | ({ type: "message.sent" } & EventBase)
  | ({ type: "message.received" } & EventBase)
  | ({ type: "tool.started"; callId: string; tool: string } & EventBase)
  | ({ type: "tool.finished"; callId: string; tool: string; isError: boolean } & EventBase)
  | ({ type: "approval.requested"; callId: string } & EventBase);

export type CapybaraEventOf<K extends CapybaraEventType> = Extract<CapybaraEvent, { type: K }>;

/**
 * The viewer's sign-in as this plugin sees it. `id` is opaque: the same for one sign-in (every
 * page and tab of it, across token refreshes) and new after the next sign-in, so client code can
 * do something once per sign-in (store the last id it acted on). It differs per plugin, is no
 * credential and reveals nothing about the session.
 */
export interface SignIn {
  id: string;
}

/** What `events` listeners get (no React context there). */
export interface ClientApi {
  locale: "zh" | "en";
  reducedMotion: boolean;
  storage: ClientStorage;
  assetUrl(path: string): string;
  signIn: SignIn;
}

/** Props every component receives, plus its slot's own. */
export interface BaseComponentProps {
  plugin: string;
  contribution: string;
  slot: import("./slots.generated.js").ComponentSlotId;
}

export interface SlotComponentProps {
  "conversation.panel": { conversationId: string; item?: string; close(): void };
  "conversation.properties.section": { conversationId: string };
  "conversation.tool-result.card": {
    conversationId: string;
    card: { callId: string; key?: string };
  };
  "org.page": Record<string, never>;
  "agent.detail.section": { agentId: string };
  "org.settings.section": Record<string, never>;
  "platform.page": Record<string, never>;
  "shell.brand": {
    /** The built-in brand (the Logo, its wordmark only in the full sidebar and the drawer). */
    builtin: ReactNode;
    /** The sidebar is the rail. */
    collapsed: boolean;
    /** The sidebar panel this node is drawn in; the host renders the brand once per drawn panel. */
    panel: "full" | "rail" | "drawer";
  };
  "shell.overlay": Record<string, never>;
  "conversation.empty": { builtin: ReactNode; agentId: string | null; greeting: string };
  "conversation.composer.frame": {
    /** The built-in frame with the composer inside. */
    builtin: ReactNode;
    /** The built-in composer inputs, without the frame; render exactly once. */
    children: ReactNode;
    /** null on the new-conversation page. */
    conversationId: string | null;
    runState: RunState;
  };
}
