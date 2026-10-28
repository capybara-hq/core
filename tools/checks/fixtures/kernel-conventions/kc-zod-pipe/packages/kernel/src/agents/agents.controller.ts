import { Body, Controller, Inject, Param, Post, Query } from "@nestjs/common";
import { ZodPipe } from "../http/zod.pipe.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CreateAgentDto, ListAgentsQuery } from "./agents.dto.js";

@Controller("agents")
export class AgentsController {
  constructor(@Inject(Svc) private readonly svc: Svc) {}

  @Post()
  create(@Body(new ZodPipe(schema)) body: unknown) {} // expect: kc-zod-pipe

  @Post("dto")
  createDto(@Body() body: CreateAgentDto) {} // expect: kc-zod-pipe

  @Post("list")
  list(@Query() q: ListAgentsQuery, @Param("id") id: string) {} // expect: kc-zod-pipe

  @Post("ok")
  ok(@ZBody(CreateAgentDto) body: CreateAgentDto) {}
}
