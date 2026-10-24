import { isIP } from "node:net";
import type { KernelConfig } from "../config/schema.js";

/** Path prefix of the channel webhook route on the gateway role (F9). */
export const CHANNEL_WEBHOOK_PREFIX = "/channels/webhook/";

const isLoopbackHost = (host: string) => {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || (isIP(h) === 4 && h.startsWith("127."));
};

type WebhookConfig = Pick<KernelConfig, "channels"> & {
  tools: Pick<KernelConfig["tools"], "oauthAllowInsecureLoopback">;
};

/**
 * Why `channels.webhookBaseUrl` is unusable, or null when it is unset or fine. It must be https;
 * plain http is accepted only for loopback hosts with `tools.oauthAllowInsecureLoopback` (tests).
 */
export function webhookBaseUrlProblem(config: WebhookConfig): string | null {
  const raw = config.channels.webhookBaseUrl;
  if (raw === undefined) return null;
  const u = new URL(raw);
  if (u.protocol === "https:") return null;
  if (
    u.protocol === "http:" &&
    isLoopbackHost(u.hostname) &&
    config.tools.oauthAllowInsecureLoopback
  ) {
    return null;
  }
  return "channels.webhookBaseUrl must be an https URL (plain http only for loopback hosts with tools.oauthAllowInsecureLoopback)";
}

/** The usable webhook base without a trailing slash, or undefined when unset or unusable. */
export function webhookBase(config: WebhookConfig): string | undefined {
  const raw = config.channels.webhookBaseUrl;
  if (raw === undefined || webhookBaseUrlProblem(config) !== null) return undefined;
  return raw.replace(/\/+$/, "");
}

/** The callback URL the admin registers with the platform: `<base>/channels/webhook/<id>`. */
export const webhookUrlOf = (base: string, connectionId: string) =>
  `${base}${CHANNEL_WEBHOOK_PREFIX}${connectionId}`;
