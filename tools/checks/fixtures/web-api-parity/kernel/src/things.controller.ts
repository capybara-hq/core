import { Controller, createZodDto, Get, Post, Put, Res, ZBody } from "./nest.js";
import { CreateThingBody } from "./things.schemas.js";

export type ThingKind = "a" | "b" | "c";

export interface Thing {
  id: string;
  name: string;
  kind: ThingKind;
  createdAt: Date;
  ownerId: string | null;
  tags: string[];
  meta?: { color: string };
}

class CreateThingDto extends createZodDto(CreateThingBody) {}

@Controller("api/v1/orgs/:orgId/things")
export class ThingsController {
  @Get()
  list(): Promise<{ things: Thing[] }> {
    return null as never;
  }

  @Get("archived")
  archived(): Promise<{ things: Thing[]; total: number }> {
    return null as never;
  }

  @Get(":id")
  get(): Promise<{ thing: Thing }> {
    return null as never;
  }

  @Post()
  create(@ZBody(CreateThingDto) _body: unknown): Promise<{ thing: Thing }> {
    return null as never;
  }

  @Put(":id/name")
  rename(@Res({ passthrough: true }) _reply: unknown): Promise<{ name: string }> {
    return null as never;
  }

  @Get(":id/icon")
  icon(@Res() _reply: unknown): Promise<void> {
    return null as never;
  }
}
