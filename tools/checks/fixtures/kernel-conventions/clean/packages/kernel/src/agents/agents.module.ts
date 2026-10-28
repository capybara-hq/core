import { Module } from "@nestjs/common";
import { AgentsService } from "./agents.service.js";

@Module({ providers: [AgentsService], exports: [AgentsService] })
export class AgentsModule {}
