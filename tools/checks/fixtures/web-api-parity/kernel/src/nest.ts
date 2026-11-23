// Stand-ins for the Nest decorators and the kernel's createZodDto: the check reads them by name.
import type { z } from "zod";

export const Controller = (_prefix?: string): ClassDecorator => () => {};
export const Get = (_path?: string): MethodDecorator => () => {};
export const Post = (_path?: string): MethodDecorator => () => {};
export const Put = (_path?: string): MethodDecorator => () => {};
export const ZBody = (_dto: unknown): ParameterDecorator => () => {};
export const Res = (_opts?: { passthrough?: boolean }): ParameterDecorator => () => {};

export function createZodDto<S extends z.ZodType>(schema: S) {
  return class {
    static readonly schema = schema;
  };
}
