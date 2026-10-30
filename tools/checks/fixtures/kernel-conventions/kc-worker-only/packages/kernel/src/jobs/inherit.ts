import { Injectable } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { DecoratedProcessor, ScheduledJob } from "./jobs.js";

declare const flag: boolean;

/** Subclasses inherit the class and method metadata: they are jobs too. */
@Injectable()
export class SubProcessor extends DecoratedProcessor {}

@Injectable()
export class SubCron extends ScheduledJob {}

export class SubSubCron extends SubCron {}

/** Decorators held in variables. */
const QueueConsumer = Processor("var");
const EveryMinute = LockedCron("* * * * *", { name: "var" });

@QueueConsumer
export class VarProcessor extends WorkerHost {
  async process() {}
}

@Injectable()
export class VarCron {
  lockService!: unknown;
  log!: unknown;
  @EveryMinute
  async tick() {}
}

/** Decorated through Reflect.decorate. */
@Injectable()
export class ReflectProcessor extends WorkerHost {
  async process() {}
}
Reflect.decorate([Processor("reflect")], ReflectProcessor);

/** Decorators that cannot be resolved statically. */
@(flag ? Processor("maybe") : Injectable()) // expect: kc-worker-only
export class MaybeProcessor extends WorkerHost {
  async process() {}
}
export function decorateAll(decorators: ClassDecorator[]) {
  Reflect.decorate(decorators, MaybeProcessor); // expect: kc-worker-only
}
