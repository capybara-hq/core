import { EXTENSION_NAME_RE, type UiSlotId } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** The DTO schemas and response shapes of the client extension routes (spec §9.2). */

/** `GET /api/v1/admin/ui/client?plugin=`: at most that plugin's platform set. */
export const AdminClientQuery = z.object({
  plugin: z.string().regex(EXTENSION_NAME_RE, "must be an extension name").optional(),
});

/** One file URL of a client build, with the integrity recorded when the package was stored. */
export interface ClientFileRef {
  url: string;
  integrity: string;
}

/** One extension of a shell read: its build's files and the components the viewer may use. */
export interface ClientExtensionItem {
  plugin: string;
  /** The package sha256: the build id in the file URLs. */
  build: string;
  entry: ClientFileRef | null;
  /** Empty in the admin set (spec §9.6). */
  styles: ClientFileRef[];
  components: { id: string; slot: UiSlotId }[];
}

/** The shell read (spec §9.2). */
export interface ClientExtensionsResponse {
  /** False under the kill switch: `items` is then empty. */
  enabled: boolean;
  /** The host's `CLIENT_API_VERSION`, echoed for diagnostics. */
  apiVersion: number;
  items: ClientExtensionItem[];
}

/** The most characters of a report's `message` (spec §10.4): longer is refused, not truncated. */
export const REPORT_MESSAGE_MAX = 500;

/** The UI contribution id grammar of the SDK (`ui[].id`): what a report's `contribution` names. */
const COMPONENT_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * `POST /api/v1/orgs/:orgId/ui/client/reports` and `POST /api/v1/admin/ui/client/reports` (spec
 * §10.4): one crash or load report of client code, from the browser that ran it. `build` is the
 * package sha256 the files were loaded from; `contribution` the component id (null: the whole
 * extension, e.g. the entry failed to load), which must be a component of that build's manifest.
 */
export const ReportBody = z.object({
  plugin: z.string().regex(EXTENSION_NAME_RE, "must be an extension name"),
  build: z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-character lowercase hex sha256"),
  contribution: z
    .string()
    .regex(COMPONENT_ID_RE, "must be a component id of the build (or null)")
    .nullable(),
  kind: z.enum(["load", "render", "event", "api", "budget"]),
  message: z.string().max(REPORT_MESSAGE_MAX),
});
export type ReportBodyInput = z.infer<typeof ReportBody>;
