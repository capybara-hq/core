import {
  isDeviceProjectName,
  MAX_DEVICE_PROJECT_NAME_LENGTH,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { publicSuffixWildcard } from "./public-suffix.js";

/** A device's name: trimmed, 1-64 characters (unique per person, case-insensitive). */
export const DeviceName = z.string().trim().min(1).max(64);

export const DeviceNameBody = z.object({ name: DeviceName }).strict();
export const DeviceParams = z.object({ id: z.string().min(1).max(100) });

/**
 * `PATCH /devices/:id`: a new name, and a cloud device's `mode`: `sandbox` narrows it, `null`
 * follows the org and the platform again (auto when they allow it; hardening spec D2). `auto` is
 * never stored. A local device's mode lives on its machine, so the service refuses a `mode` for it
 * (`device.mode_on_device`). The mode is a person's choice in a web session: an API token gets
 * `device.mode_requires_session`, and the Platform operation (`devices.rename`) omits it.
 */
export const DevicePatchBody = z
  .object({ name: DeviceName.optional(), mode: z.literal("sandbox").nullable().optional() })
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

/**
 * A project's name (project root §4.1, `isDeviceProjectName`): 1-64 UTF-16 code units, not `.` or
 * `..`, no `/`, no control characters, no leading or trailing whitespace; unique on its device.
 */
export const DeviceProjectName = z
  .string()
  .max(MAX_DEVICE_PROJECT_NAME_LENGTH)
  .refine(isDeviceProjectName, {
    message:
      "A project name is 1-64 characters, not . or .., without / or control characters, and without leading or trailing spaces",
  });

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * `POST /devices/:id/projects`: `path` is relative to the device's base in its current mode (the
 * workspace in sandbox mode and on a cloud device, the owner's home in auto mode; empty or `.`:
 * the base itself), never absolute; `name` defaults to the directory's basename.
 */
export const DeviceProjectAddBody = z
  .object({
    path: z
      .string()
      .max(4096)
      .refine((p) => !p.startsWith("/"), {
        message: "Give the path relative to the device's base, not an absolute path",
      })
      .refine((p) => !CONTROL.test(p) && !p.includes("\\"), {
        message: "The path must not contain control characters or backslashes",
      }),
    name: DeviceProjectName.optional(),
  })
  .strict();

/** `DELETE /devices/:id/projects/:name`. */
export const DeviceProjectParams = DeviceParams.extend({ name: DeviceProjectName });

export class DeviceCreateBodyDto extends createZodDto(DeviceNameBody, "DeviceCreateBody") {}
export class DevicePatchBodyDto extends createZodDto(DevicePatchBody, "DevicePatchBody") {}
export class DeviceParamsDto extends createZodDto(DeviceParams, "DeviceParams") {}
export class DevicePolicyBodyDto extends createZodDto(DevicePolicyBody, "DevicePolicyBody") {}
export class DeviceProjectAddBodyDto extends createZodDto(
  DeviceProjectAddBody,
  "DeviceProjectAddBody",
) {}
export class DeviceProjectParamsDto extends createZodDto(
  DeviceProjectParams,
  "DeviceProjectParams",
) {}
