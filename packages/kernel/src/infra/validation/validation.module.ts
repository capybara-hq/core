import { Module } from "@nestjs/common";
import { APP_PIPE } from "@nestjs/core";
import { ZodValidationPipe } from "./zod-validation.pipe.js";

/** Registers the global zod validation pipe. */
@Module({ providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }] })
export class ValidationModule {}
