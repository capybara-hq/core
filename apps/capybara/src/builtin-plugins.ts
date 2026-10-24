/**
 * Extensions built into the CLI (C14 / D13): the core image carries only `openai-compatible` and
 * `object-store-s3`. Resolved by module from the CLI's own dependencies (independent of the working
 * directory) and passed to the kernel as `builtinExtensions`: source `builtin`, pre-approved, always
 * enabled, no org enablement needed; when the deployment config is incomplete they are "pending
 * configuration" and the kernel starts as usual.
 */
export const BUILTIN_PLUGINS: readonly string[] = [
  import.meta.resolve("@capybara-hq/plugin-openai-compatible"),
  import.meta.resolve("@capybara-hq/plugin-object-store-s3"),
];
