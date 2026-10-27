/** Extension point ref, of the form `channel@1` (name@major). */
export type ExtensionPointRef = `${string}@${number}`;

/** Extension point cardinality: `single` allows one provider at a time, `multi` allows several. */
export type Cardinality = "single" | "multi";

/** Registry entry of an extension point. */
export interface ExtensionPointInfo {
  cardinality: Cardinality;
  /** Brokered by the platform API (extensions may not `requires` it; they use it only through `ctx`). */
  brokered: boolean;
  /** Enabled per org (consumers may pass `orgId` to check that the org enabled the provider). */
  orgScoped: boolean;
}

const info = (
  cardinality: Cardinality,
  brokered = false,
  orgScoped = false,
): ExtensionPointInfo => ({
  cardinality,
  brokered,
  orgScoped,
});

/** The registered extension points. */
export const EXTENSION_POINTS: Record<string, ExtensionPointInfo> = {
  sandbox: info("single", true),
  "config-source": info("single"),
  "secret-store": info("single", true),
  "object-store": info("single", true),
  channel: info("multi", false, true),
  "model-provider": info("multi", true),
  "identity-source": info("multi"),
  directory: info("multi", false, true),
  counter: info("multi"),
  connector: info("multi", true),
  "file-preview": info("multi", false, true),
};

/** Cardinality of the registered extension points (derived from EXTENSION_POINTS). */
export const EXTENSION_POINT_CARDINALITY: Record<string, Cardinality> = Object.fromEntries(
  Object.entries(EXTENSION_POINTS).map(([k, v]) => [k, v.cardinality]),
);

/** Connector extension point ref (see `connector.ts`). */
export const CONNECTOR_EXTENSION_POINT = "connector@1";

/** IM channel extension point ref (see `channel.ts`). */
export const CHANNEL_EXTENSION_POINT = "channel@1";

/** Third-party login identity source extension point ref (see `identity.ts`). */
export const IDENTITY_SOURCE_EXTENSION_POINT = "identity-source@1";

/** Directory sync extension point ref (see `directory.ts`). */
export const DIRECTORY_EXTENSION_POINT = "directory@1";

/** Parses an extension point ref; throws when the format is invalid. */
export function parseExtensionPoint(ref: string): { name: string; major: number } {
  const m = /^([a-z][a-z0-9-]*)@(\d+)$/.exec(ref);
  if (!m) throw new Error(`invalid extension point ref "${ref}", expected "<name>@<major>"`);
  return { name: m[1] as string, major: Number(m[2]) };
}
