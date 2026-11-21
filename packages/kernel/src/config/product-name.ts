import type { KernelConfig } from "./schema.js";

/** The product name when the deployment sets no `platform.name`. */
export const DEFAULT_PRODUCT_NAME = "Capybara";

/**
 * The name people see for this deployment (`platform.name`, else {@link DEFAULT_PRODUCT_NAME}).
 * `platform.name` is hot: read it per use, never cache it.
 */
export function productName(config: Pick<KernelConfig, "platform">): string {
  return config.platform.name ?? DEFAULT_PRODUCT_NAME;
}
