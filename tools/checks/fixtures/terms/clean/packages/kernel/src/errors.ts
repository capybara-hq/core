export const ERROR_CODES = {
  internal: 500,
  "catalog.item_not_found": 404,
  "plugin.extension_conflict": 409,
  "directory.not_configured": 409,
} as const satisfies Record<string, number>;
