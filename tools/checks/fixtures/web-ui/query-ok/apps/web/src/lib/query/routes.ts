export const ROUTES = [
  { pattern: "/x", queries: () => [] },
  { pattern: "/[...rest]", queries: () => [], none: "unknown route: 404" },
];
