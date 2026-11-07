export type ExclusionCategory = "human-only" | "secret" | "transport" | "internal" | "later";

/**
 * Kernel HTTP routes the `Platform` tool does not mirror, each with a reason (spec §9);
 * `check:platform-ops` fails a route that is neither mirrored by an operation nor listed here.
 * `later` needs an `issue` URL.
 */
export const PLATFORM_EXCLUSIONS: readonly {
  route: string;
  category: ExclusionCategory;
  reason: string;
  issue?: string;
}[] = [];
