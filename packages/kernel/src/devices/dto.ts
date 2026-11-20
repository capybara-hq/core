import {
  isDeviceProjectName,
  MAX_DEVICE_PROJECT_NAME_LENGTH,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";

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
 * A cloud device's sandbox network (approval-only profiles design, "Settings model"): `open` (the
 * public internet), `allowlist` (its org's hosts, narrowed to `hosts` when given: a device list
 * never adds a host, and an empty one follows the org's), `none` (closed), or `null` to follow its
 * org again. `hosts` only with `allowlist`.
 */
export const DeviceNetworkBody = z
  .object({
    mode: z.enum(["open", "allowlist", "none"]).nullable(),
    hosts: z.array(PolicyHost).max(100).optional(),
  })
  .strict()
  .refine((n) => n.hosts === undefined || n.hosts.length === 0 || n.mode === "allowlist", {
    message: "Give hosts only with the allowlist network",
  });

/**
 * `PATCH /devices/:id`: a new name, and a cloud device's sandbox `network`
 * ({@link DeviceNetworkBody}), within its org's and the platform's ceilings (`device.network_not_allowed`
 * above them). A local device's network lives on its machine (`device.ceiling_on_machine`: narrow
 * it with `POST /devices/:id/policy`, widen it on the machine). Through an API token or the
 * Platform tool (`devices.set-network`) the network may only narrow.
 */
export const DevicePatchBody = z
  .object({
    name: DeviceName.optional(),
    network: DeviceNetworkBody.optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || b.network !== undefined, {
    message: "Give at least one of name or network",
  });

/**
 * `POST /devices/:id/policy` (approval-only profiles design, "Settings model"): the device owner
 * narrows the local machine's sandbox from the web: `remove` hosts from its allowlist, and narrow
 * its owner ceiling (`outsideSandbox: false`, `network: "allowlist"`, `restrictedProjectReach:
 * "workspace"`). The web never widens it: the owner adds hosts, opens the network or allows
 * running outside the sandbox on the machine (`capybara-device policy add allowedDomains`,
 * `capybara-device ceiling set`).
 */
export const DevicePolicyBody = z
  .object({
    remove: z.array(PolicyHost).min(1).max(100).optional(),
    ownerCeiling: z
      .object({
        outsideSandbox: z.literal(false).optional(),
        network: z.literal("allowlist").optional(),
        restrictedProjectReach: z.literal("workspace").optional(),
      })
      .strict()
      .refine(
        (c) =>
          c.outsideSandbox !== undefined ||
          c.network !== undefined ||
          c.restrictedProjectReach !== undefined,
        {
          message:
            "Give outsideSandbox: false, network: allowlist or restrictedProjectReach: workspace",
        },
      )
      .optional(),
  })
  .strict()
  .refine((b) => b.remove !== undefined || b.ownerCeiling !== undefined, {
    message: "Give at least one of remove or ownerCeiling",
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
