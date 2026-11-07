import { defineExtension, type ModelRequestHookPayload } from "@capybara-hq/plugin-sdk";

/** The `model.request` payloads the observe hook saw, in order (same process as the test). */
export function embedObserver(): { seen: ModelRequestHookPayload[] } {
  const g = globalThis as { __embedObserver?: { seen: ModelRequestHookPayload[] } };
  g.__embedObserver ??= { seen: [] };
  return g.__embedObserver;
}

/**
 * Test plugin: an observe hook on `model.request` that keeps every payload (`embedObserver()`), so
 * a test can check what an embedding call's hook payload carries (model platform spec B §5.4).
 */
export default defineExtension({
  name: "embed-observer",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { hooks: ["model.request"] },
  setup(ctx) {
    ctx.hooks.on(
      "model.request",
      (p) => {
        embedObserver().seen.push(p);
      },
      { mode: "observe" },
    );
  },
});
