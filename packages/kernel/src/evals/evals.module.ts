import { Module } from "@nestjs/common";
import { EventLogModule } from "../conversations/event-log.js";
import { IdentityModule } from "../identity/identity.module.js";
import { ModelsModule } from "../models/models.module.js";
import { TrajectoryService } from "./trajectory.service.js";

/** Evals (Task 3.6a: the trajectory viewer; Task 3.9 adds eval sets, runs and the worker). */
@Module({
  imports: [EventLogModule, ModelsModule, IdentityModule],
  providers: [TrajectoryService],
  exports: [TrajectoryService],
})
export class EvalsModule {}
