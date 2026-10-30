import { Module } from "@nestjs/common";
import { AgentsService } from "./agents.service.js";
import { EventLog } from "../runtime/event-log.js";

@Module({ providers: [AgentsService, EventLog], exports: [AgentsService] }) // expect: kc-wiring
export class AgentsModule {}
