/**
 * Config schema → JSON Schema for forms. The conversion (and the secret scrub) lives in the SDK
 * (`configJsonSchema`, extension config forms spec §4.1) so the packer, the checks and the kernel
 * share one implementation; the kernel keeps no copy.
 */
export { configJsonSchema as configToJsonSchema, type JsonSchema } from "@capybara-hq/plugin-sdk";
