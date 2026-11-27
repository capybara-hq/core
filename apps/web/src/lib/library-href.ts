/** Where a library file is shown in the Files area: `/files#item=<id>`. */
export const libraryHref = (fileId: string): string => `/files#item=${encodeURIComponent(fileId)}`;
