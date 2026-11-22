import { DIAL_IN_PROTOCOL_RE } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { DeviceName } from "../devices/dto.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";

/** `POST /api/v1/device/authorize`: the machine as the program describes it. */
export const DeviceAuthorizeBody = z
  .object({
    name: z.string().trim().min(1).max(64),
    os: z.enum(["darwin", "linux"]),
    arch: z.string().trim().min(1).max(32),
    programVersion: z.string().trim().min(1).max(64),
    /** The dial-in protocol the program speaks (`<name>/<major>`): its providers are offered. */
    protocol: z.string().regex(DIAL_IN_PROTOCOL_RE),
  })
  .strict();

/** `POST /api/v1/device/token`: the secret device code from `authorize`. */
export const DeviceTokenBody = z.object({ deviceCode: z.string().min(1).max(200) }).strict();

/** A user code as typed (`XXXX-XXXX`; case, spaces and the dash are forgiven). */
const UserCode = z.string().min(1).max(32);

export const DeviceUserCodeParams = z.object({ userCode: UserCode });
export const DeviceUserCodeBody = z.object({ userCode: UserCode }).strict();

/** A dial-in provider: a plugin name, or the kernel's interim `@local`. */
const ProviderName = z.string().min(1).max(100);

/** `GET /api/v1/device/providers`: the dial-in providers a pending code may choose in an org. */
export const DeviceProvidersQuery = z
  .object({ orgId: z.string().min(1).max(100), userCode: UserCode })
  .strict();

/**
 * `POST /api/v1/device/confirm`: the org, the dial-in provider, and exactly one of an existing
 * device of the person's of that provider (`deviceId`) or the name of a new one (`name`).
 */
export const DeviceConfirmBody = z
  .object({
    userCode: UserCode,
    orgId: z.string().min(1).max(100),
    provider: ProviderName,
    deviceId: z.uuid().optional(),
    name: DeviceName.optional(),
  })
  .strict()
  .refine((b) => (b.deviceId === undefined) !== (b.name === undefined), {
    message: "Give exactly one of deviceId and name",
    path: ["deviceId"],
  });

export class DeviceAuthorizeBodyDto extends createZodDto(
  DeviceAuthorizeBody,
  "DeviceAuthorizeBody",
) {}
export class DeviceTokenBodyDto extends createZodDto(DeviceTokenBody, "DeviceTokenBody") {}
export class DeviceUserCodeParamsDto extends createZodDto(
  DeviceUserCodeParams,
  "DeviceUserCodeParams",
) {}
export class DeviceUserCodeBodyDto extends createZodDto(DeviceUserCodeBody, "DeviceUserCodeBody") {}
export class DeviceProvidersQueryDto extends createZodDto(
  DeviceProvidersQuery,
  "DeviceProvidersQuery",
) {}
export class DeviceConfirmBodyDto extends createZodDto(DeviceConfirmBody, "DeviceConfirmBody") {}
