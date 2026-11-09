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
