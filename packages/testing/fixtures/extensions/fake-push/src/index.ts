import { defineExtension, PUSH_PROVIDER_EXTENSION_POINT, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { keyCheck } from "./check.js";
import { fakePushProbe, makeFakePush } from "./push.js";

export { type FakePushSend, fakePushProbe, makeFakePush } from "./push.js";

/**
 * Test fake of a push provider (`push-provider@1`), scripted by the token prefix (see
 * `makeFakePush`). Deployment config: `apps` (the app ids it covers, default
 * `["com.example.app"]`) and an optional secret `key`. Every send attempt is recorded in
 * `plugin_fake_push.sends` (counted across replicas) and on `fakePushProbe().sends` (in process).
 * Its platform setup guide (`guides/fake-push-key.md`, place `extension-deployment`) has one check,
 * `fake-push-key` (`check.ts`), which reads `key`.
 */
const DeploymentConfig = z.object({
  apps: z.array(z.string().min(1)).default(["com.example.app"]),
  key: secret(z.string()).optional(),
});

export default defineExtension({
  name: "fake-push",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [PUSH_PROVIDER_EXTENSION_POINT],
  permissions: { setupChecks: ["fake-push-key"] },
  migrations: "../migrations",
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const cfg = DeploymentConfig.parse(ctx.config);
    const { provider } = makeFakePush({
      apps: cfg.apps,
      probe: fakePushProbe(),
      async onSend(s) {
        await ctx.db
          .insertInto("sends")
          .values({
            registration_id: s.registrationId,
            job_marker: "",
            message: JSON.stringify(s.message),
          })
          .execute();
      },
    });
    ctx.provide(PUSH_PROVIDER_EXTENSION_POINT, provider);
    ctx.setup.check("fake-push-key", keyCheck);
  },
});
