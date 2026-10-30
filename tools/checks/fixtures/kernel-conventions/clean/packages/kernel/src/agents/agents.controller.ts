import { Controller, Inject, Post } from "@nestjs/common";
import { ZBody } from "../infra/validation/zod-params.js";
import { CreateAgentDto } from "./agents.dto.js";
import { AgentsService } from "./agents.service.js";

@Controller("agents")
export class AgentsController {
  constructor(@Inject(AgentsService) private readonly agents: AgentsService) {}

  @Post()
  create(@ZBody(CreateAgentDto) body: CreateAgentDto) {
    return this.agents.create();
  }
}
