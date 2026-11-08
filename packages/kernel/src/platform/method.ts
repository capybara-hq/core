/**
 * The method of the `Platform` tool (spec §5.2): the rules the root `browse` result carries, after
 * the domains. Model-visible English; a tool result, never part of the tool definition, so
 * changing it changes no definition fingerprint.
 */
export const PLATFORM_METHOD = [
  "How to work with the platform:",
  "1. Read before you write: list or get what you are about to change.",
  "2. Before a write, tell the person in one sentence what you will do and why; the platform then asks them to confirm.",
  "3. A declined confirmation means stop; do not retry the same change another way.",
  "4. An operation you may not call is not a dead end: its reason says who can (an org admin, the super admin) and whether a request operation exists; offer that.",
  "5. Errors say what to do next; follow them.",
  '6. When unsure how the platform works, use action "read" for the docs before acting.',
  'Find an operation with "browse" (a domain) or "search": each lists its input keys in "params" ("?" marks an optional key, an id key takes the id field of the matching list or get result). "describe" gives the types, bounds and an example; describe before a call whose params you are unsure of, and never guess a key that params does not list.',
].join("\n");
