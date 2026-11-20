import type { SetupCheckDefinition } from "@capybara-hq/plugin-sdk";

/**
 * The platform setup check of `fake-push` (place `extension-deployment`), registered in
 * `index.ts` as `fake-push-key`: it reads the deployment config's `key` from its target (the
 * extension's own deployment config) and answers without a third-party call:
 *
 * - no key: `failing` (set one);
 * - a key starting with `bad`: `failing`, with a reason and a fix that echo the key (the kernel
 *   must redact it; a key of 8 characters or more is redacted);
 * - any other key: `ok`, with a reason naming the plugin and the org the check got (`none` for the
 *   platform), so a test sees what the kernel passed.
 */
export const keyCheck: SetupCheckDefinition = {
  place: "extension-deployment",
  async run(args) {
    if (args.target.kind !== "extension-deployment") throw new Error("not a deployment target");
    const key = (args.target.config as { key?: unknown } | null)?.key;
    if (typeof key !== "string" || key === "") {
      return {
        status: "failing",
        reason: { en: "No key is set in the deployment config." },
        fix: { en: "Save a key in the deployment config field key." },
      };
    }
    if (key.startsWith("bad")) {
      return {
        status: "failing",
        reason: { en: `The fake push service refused the key ${key}.` },
        fix: { en: `Replace ${key} with a key from the fake push console.` },
      };
    }
    return {
      status: "ok",
      reason: {
        en: `The fake push service accepted the key of ${args.target.plugin} (org: ${args.orgId ?? "none"}).`,
      },
    };
  },
};
