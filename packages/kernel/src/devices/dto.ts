import { validateAllowHost } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { publicSuffixWildcard } from "./public-suffix.js";

/** A device's name: trimmed, 1-64 characters (unique per person, case-insensitive). */
export const DeviceName = z.string().trim().min(1).max(64);

export const DeviceNameBody = z.object({ name: DeviceName }).strict();
export const DeviceParams = z.object({ id: z.string().min(1).max(100) });

/**
 * `PATCH /devices/:id`: a new name, and a cloud device's narrowing `mode` (`sandbox` only: auto
 * mode is never set from the web, auto mode spec §4.3). A local device's mode lives on its machine,
 * so the service refuses a `mode` for it (`device.mode_on_device`). The mode is a person's choice
 * in a web session: an API token gets `auth.session_required`.
 */
export const DevicePatchBody = z
  .object({ name: DeviceName.optional(), mode: z.literal("sandbox").optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.mode !== undefined, {
    message: "Give at least one of name or mode",
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
 * `POST /devices/:id/policy` (network ask-to-allow spec §7; auto mode spec §4.1): the device
 * owner's change of the machine's local policy. `add` and `remove` change its sandbox-mode
 * allowlist; `mode: "sandbox"` turns the sandbox back on (turning auto mode on is decided on the
 * machine only).
 */
export const DevicePolicyBody = z
  .object({
    add: z.array(AddHost).min(1).max(20).optional(),
    remove: z.array(PolicyHost).min(1).max(100).optional(),
    mode: z.literal("sandbox").optional(),
  })
  .strict()
  .refine((b) => b.add !== undefined || b.remove !== undefined || b.mode !== undefined, {
    message: "Give at least one of add, remove or mode",
  });

export class DeviceCreateBodyDto extends createZodDto(DeviceNameBody, "DeviceCreateBody") {}
export class DevicePatchBodyDto extends createZodDto(DevicePatchBody, "DevicePatchBody") {}
export class DeviceParamsDto extends createZodDto(DeviceParams, "DeviceParams") {}
export class DevicePolicyBodyDto extends createZodDto(DevicePolicyBody, "DevicePolicyBody") {}
