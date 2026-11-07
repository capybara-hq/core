import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";

/** An environment's name: trimmed, 1-64 characters (unique per person, case-insensitive). */
export const EnvironmentName = z.string().trim().min(1).max(64);

export const EnvironmentNameBody = z.object({ name: EnvironmentName }).strict();
export const EnvironmentParams = z.object({ id: z.string().min(1).max(100) });

export class EnvironmentCreateBodyDto extends createZodDto(
  EnvironmentNameBody,
  "EnvironmentCreateBody",
) {}
export class EnvironmentRenameBodyDto extends createZodDto(
  EnvironmentNameBody,
  "EnvironmentRenameBody",
) {}
export class EnvironmentParamsDto extends createZodDto(EnvironmentParams, "EnvironmentParams") {}
