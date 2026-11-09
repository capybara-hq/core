import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";

/** A device's name: trimmed, 1-64 characters (unique per person, case-insensitive). */
export const DeviceName = z.string().trim().min(1).max(64);

export const DeviceNameBody = z.object({ name: DeviceName }).strict();
export const DeviceParams = z.object({ id: z.string().min(1).max(100) });

export class DeviceCreateBodyDto extends createZodDto(DeviceNameBody, "DeviceCreateBody") {}
export class DeviceRenameBodyDto extends createZodDto(DeviceNameBody, "DeviceRenameBody") {}
export class DeviceParamsDto extends createZodDto(DeviceParams, "DeviceParams") {}
