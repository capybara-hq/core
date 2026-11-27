import type { ExtensionPointRef } from "./extension-point.js";
import type { LocalizedName } from "./plugin-package.js";
import type { TriggerSubject } from "./triggers.js";

/** One fact of an event type: its value type and whether automations may filter on it. */
export interface TriggerFactDeclaration {
  type: "string" | "number" | "boolean" | "string[]";
  name: LocalizedName;
  filterable: boolean;
}

/** One event type an extension emits, shown when an org builds an automation. */
export interface TriggerEventDeclaration {
  type: string;
  name: LocalizedName;
  /** Directed events wake one agent (`TriggerEvent.audience`) instead of every subscriber. */
  directed: boolean;
  facts: Record<string, TriggerFactDeclaration>;
}

/** What a `trigger-source@1` provider implements. */
export interface TriggerSource {
  events(): TriggerEventDeclaration[];
  /** Of `accountIds`, the accounts that may see `subject`. */
  visible(args: {
    orgId: string;
    accountIds: string[];
    subject: TriggerSubject;
    config?: unknown;
  }): Promise<string[]>;
  /** A link a person can open for the subject, or null. */
  subjectLink?(args: { orgId: string; subject: TriggerSubject }): Promise<string | null>;
}

/** Trigger source extension point ref. */
export const TRIGGER_SOURCE_EXTENSION_POINT: ExtensionPointRef = "trigger-source@1";
