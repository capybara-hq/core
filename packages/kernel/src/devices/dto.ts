import { type SandboxTier, validateAllowHost } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { publicSuffixWildcard } from "./public-suffix.js";

/** A device's name: trimmed, 1-64 characters (unique per person, case-insensitive). */
export const DeviceName = z.string().trim().min(1).max(64);

export const DeviceNameBody = z.object({ name: DeviceName }).strict();
export const DeviceParams = z.object({ id: z.string().min(1).max(100) });

/** A sandbox tier (sandbox dev tiers spec §5). */
export const DeviceTier = z.enum(["strict", "dev", "open"]) satisfies z.ZodType<SandboxTier>;

/**
 * `PATCH /devices/:id`: a new name, and for a cloud device its sandbox tier (null = follow the
 * org's default; sandbox dev tiers spec §7.2). The tier is a person's choice in a web session:
 * an API token gets `auth.session_required` and the Platform tool leaves the field out.
 */
export const DevicePatchBody = z
  .object({ name: DeviceName.optional(), tier: DeviceTier.nullable().optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.tier !== undefined, {
    message: "Give at least one of name or tier",
  });

/** One host of a device's network allowlist (`validateAllowHost`: lowercase, `*.` allowed). */
const PolicyHost = z
  .string()
  .max(253)
  .superRefine((h, ctx) => {
    for (const message of validateAllowHost(h)) ctx.addIssue({ code: "custom", message });
  });

/** A host to add: also no `*.` wildcard over a whole public suffix (`*.com`, `*.co.uk`). */
const AddHost = PolicyHost.superRefine((h, ctx) => {
  const tooBroad = publicSuffixWildcard(h);
  if (tooBroad !== null) ctx.addIssue({ code: "custom", message: tooBroad });
});

/**
 * `POST /devices/:id/policy` (network ask-to-allow spec §7, sandbox dev tiers spec §7.3): the
 * device owner's change of the machine's local policy. `add` and a higher `tier` widen it (the
 * machine accepts them only while its local `remoteGrants` is `owner`); `remove` and a lower
 * `tier` narrow it. `tier: null` follows the org's default. `isolation` only turns the sandbox
 * back on: running without one is decided on the machine.
 */
export const DevicePolicyBody = z
  .object({
    add: z.array(AddHost).min(1).max(20).optional(),
    remove: z.array(PolicyHost).min(1).max(100).optional(),
    tier: DeviceTier.nullable().optional(),
    isolation: z.literal("sandbox").optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.add !== undefined ||
      b.remove !== undefined ||
      b.tier !== undefined ||
      b.isolation !== undefined,
    { message: "Give at least one of add, remove, tier or isolation" },
  );

export class DeviceCreateBodyDto extends createZodDto(DeviceNameBody, "DeviceCreateBody") {}
export class DevicePatchBodyDto extends createZodDto(DevicePatchBody, "DevicePatchBody") {}
export class DeviceParamsDto extends createZodDto(DeviceParams, "DeviceParams") {}
export class DevicePolicyBodyDto extends createZodDto(DevicePolicyBody, "DevicePolicyBody") {}
