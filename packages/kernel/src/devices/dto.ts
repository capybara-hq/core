import { validateAllowHost } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { publicSuffixWildcard } from "./public-suffix.js";

/** A device's name: trimmed, 1-64 characters (unique per person, case-insensitive). */
export const DeviceName = z.string().trim().min(1).max(64);

export const DeviceNameBody = z.object({ name: DeviceName }).strict();
export const DeviceParams = z.object({ id: z.string().min(1).max(100) });

/** One host of a device's network allowlist (`validateAllowHost`: lowercase, `*.` allowed). */
const PolicyHost = z
  .string()
  .max(253)
  .superRefine((h, ctx) => {
    for (const message of validateAllowHost(h)) ctx.addIssue({ code: "custom", message });
  });

/**
 * `POST /devices/:id/policy` (network ask-to-allow spec §7): the device owner's change of the
 * machine's local network policy. `add` and `network: "open"` widen it (the machine accepts them
 * only while its local `remoteGrants` is `owner`); `remove` and `network: "allowlist"` narrow it.
 */
/** A host to add: also no `*.` wildcard over a whole public suffix (`*.com`, `*.co.uk`). */
const AddHost = PolicyHost.superRefine((h, ctx) => {
  const tooBroad = publicSuffixWildcard(h);
  if (tooBroad !== null) ctx.addIssue({ code: "custom", message: tooBroad });
});

export const DevicePolicyBody = z
  .object({
    add: z.array(AddHost).min(1).max(20).optional(),
    remove: z.array(PolicyHost).min(1).max(100).optional(),
    network: z.enum(["allowlist", "open"]).optional(),
  })
  .strict()
  .refine((b) => b.add !== undefined || b.remove !== undefined || b.network !== undefined, {
    message: "Give at least one of add, remove or network",
  });

export class DeviceCreateBodyDto extends createZodDto(DeviceNameBody, "DeviceCreateBody") {}
export class DeviceRenameBodyDto extends createZodDto(DeviceNameBody, "DeviceRenameBody") {}
export class DeviceParamsDto extends createZodDto(DeviceParams, "DeviceParams") {}
export class DevicePolicyBodyDto extends createZodDto(DevicePolicyBody, "DevicePolicyBody") {}
