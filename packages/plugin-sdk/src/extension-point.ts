/** Extension point ref, of the form `channel@1` (name@major). */
export type ExtensionPointRef = `${string}@${number}`;

/** Extension point cardinality: `single` allows one provider at a time, `multi` allows several. */
export type Cardinality = "single" | "multi";

/** Registry entry of an extension point. */
export interface ExtensionPointInfo {
  /** What the extension point is for, in one sentence (served to agents by the Platform tool). */
  description: string;
  cardinality: Cardinality;
  /** Brokered by the platform API (extensions may not `requires` it; they use it only through `ctx`). */
  brokered: boolean;
  /** Enabled per org (consumers may pass `orgId` to check that the org enabled the provider). */
  orgScoped: boolean;
  /** The majors of this point the kernel accepts; a plugin providing any other major is refused. */
  majors: readonly number[];
  /**
   * How the kernel picks one provider among several: `org-default` means each org chooses its
   * default provider (absent: no selection, every enabled provider is used).
   */
  selection?: "org-default";
}

const info = (
  majors: readonly number[],
  description: string,
  cardinality: Cardinality,
  brokered = false,
  orgScoped = false,
  selection?: "org-default",
): ExtensionPointInfo => ({
  majors,
  description,
  cardinality,
  brokered,
  orgScoped,
  ...(selection ? { selection } : {}),
});

/** The registered extension points. */
export const EXTENSION_POINTS: Record<string, ExtensionPointInfo> = {
  sandbox: info(
    [2],
    "Runs an device's instance and keeps its files for agents' commands (Docker, E2B).",
    "single",
    true,
  ),
  "config-source": info(
    [1],
    "Supplies deployment configuration from an external store such as Nacos.",
    "single",
  ),
  "secret-store": info(
    [1],
    "Stores and resolves secrets (connector credentials, secret config) outside the database.",
    "single",
    true,
  ),
  "object-store": info(
    [1],
    "Stores files and artifacts in S3-compatible object storage, with presigned uploads.",
    "single",
    true,
  ),
  channel: info(
    [1],
    "Connects an instant-messaging platform (Slack, Lark): inbound events, replies and cards.",
    "multi",
    false,
    true,
  ),
  "model-provider": info(
    [1, 2],
    "Calls a model vendor's API and streams the result back to the runtime.",
    "multi",
    true,
  ),
  "identity-source": info(
    [1],
    "Signs people in through an external identity provider (SSO).",
    "multi",
  ),
  directory: info(
    [1],
    "Syncs members and departments from an external company directory.",
    "multi",
    false,
    true,
  ),
  counter: info([1], "Counts usage so quotas and reports can be built on it.", "multi"),
  connector: info(
    [1],
    "Speaks one protocol (MCP, OpenAPI) to external systems and exposes their tools to agents.",
    "multi",
    true,
  ),
  "file-preview": info(
    [1],
    "Renders previews of files of given types in the conversation UI.",
    "multi",
    false,
    true,
  ),
  "web-search": info(
    [1],
    "Searches the web for the WebSearch tool; each org picks a default provider.",
    "multi",
    true,
    true,
    "org-default",
  ),
  "web-fetch": info(
    [1],
    "Fetches and extracts web pages for the WebFetch tool; each org picks a default provider.",
    "multi",
    true,
    true,
    "org-default",
  ),
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
