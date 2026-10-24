export const ERROR_CODES = {
  internal: 500,
  "catalog.item_not_found": 404,
  "directory.item_not_found": 404,
} as const satisfies Record<string, number>;
