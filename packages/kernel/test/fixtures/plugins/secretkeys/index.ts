import { defineExtension, secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

const T = (zh: string, en: string) => ({ zh, en });

const Endpoint = z.object({ name: z.string().min(1), baseUrl: z.string() });

/**
 * `endpoints` draws two secret records per item (`apiKeys`, `fileKeys`); `otherKeys` is a secret
 * record no hint names. Every `apiKeys` key must name an endpoint, so renaming an endpoint needs
 * its key renamed in the same save.
 */
export const SecretkeysSchema = z
  .object({
    endpoints: ui(z.array(Endpoint), {
      label: T("端点", "Endpoints"),
      secrets: [
        { path: "apiKeys", keyBy: "name", label: T("API 密钥", "API key") },
        { path: "fileKeys", keyBy: "name", label: T("文件密钥", "File key") },
      ],
    }).default([]),
    apiKeys: secret(z.record(z.string(), z.string())).default({}),
    fileKeys: secret(z.record(z.string(), z.string())).optional(),
    otherKeys: secret(z.record(z.string(), z.string())).optional(),
  })
  .superRefine((c, ctx) => {
    const names = new Set(c.endpoints.map((e) => e.name));
    for (const k of Object.keys(c.apiKeys)) {
      if (!names.has(k)) {
        ctx.addIssue({ code: "custom", path: ["apiKeys", k], message: "no such endpoint" });
      }
    }
  });

/** Deployment config with secret records drawn per item (extension config forms spec §4.3). */
export default defineExtension({
  name: "secretkeys",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: { deployment: SecretkeysSchema },
  setup() {},
});
