/**
 * Conversation compaction (context compaction spec §4.8): the fields the platform sets and an
 * organization may override, their bounds (the kernel validates the same ranges) and the built-in
 * defaults the kernel starts from.
 */
export interface CompactionSettings {
  enabled: boolean;
  /** The share of the model's context window that starts a compaction (0.5–0.95). */
  threshold: number;
  /** How many of the latest user turns stay outside the summary (0–20). */
  keepRecentTurns: number;
  /** The safety margin left below the window (0–50,000 tokens). */
  reserveTokens: number;
  /** The summary call's output cap (1,024–32,000 tokens). */
  maxOutputTokens: number;
}

/** A change to the compaction settings: only the fields given. */
export type CompactionSettingsPatch = Partial<CompactionSettings>;

/** The kernel's `COMPACTION_SETTINGS` defaults (what a deployment without stored values uses). */
export const COMPACTION_DEFAULTS: CompactionSettings = {
  enabled: true,
  threshold: 0.8,
  keepRecentTurns: 4,
  reserveTokens: 8000,
  maxOutputTokens: 20_000,
};

/** The bounds of the kernel's compaction fields (a value outside them is a 400). */
export const COMPACTION_BOUNDS = {
  threshold: { min: 0.5, max: 0.95, decimal: true },
  keepRecentTurns: { min: 0, max: 20, decimal: false },
  reserveTokens: { min: 0, max: 50_000, decimal: false },
  maxOutputTokens: { min: 1024, max: 32_000, decimal: false },
} as const;

/** The values an organization gets: its stored override over the platform's settings. */
export function effectiveCompaction(
  platform: CompactionSettings,
  override: CompactionSettingsPatch | undefined,
): CompactionSettings {
  return {
    enabled: override?.enabled ?? platform.enabled,
    threshold: override?.threshold ?? platform.threshold,
    keepRecentTurns: override?.keepRecentTurns ?? platform.keepRecentTurns,
    reserveTokens: override?.reserveTokens ?? platform.reserveTokens,
    maxOutputTokens: override?.maxOutputTokens ?? platform.maxOutputTokens,
  };
}
