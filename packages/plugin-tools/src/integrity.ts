import { createHash } from "node:crypto";

/** sha512 SRI (`sha512-<base64>`), the form marketplaces, bootstrap pins and npm pin tgz files with. */
export const integrityOf = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
