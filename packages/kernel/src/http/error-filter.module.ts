import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ErrorFilter } from "./error.filter.js";

/**
 * The global error filter (`APP_FILTER`: the error envelope for every route).
 */
@Module({ providers: [{ provide: APP_FILTER, useClass: ErrorFilter }] })
export class ErrorFilterModule {}
