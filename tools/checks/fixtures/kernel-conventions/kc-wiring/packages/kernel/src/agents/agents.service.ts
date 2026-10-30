import { Injectable } from "@nestjs/common";
import { EventLog } from "../runtime/event-log.js";

@Injectable()
export class AgentsService {}

export function wire(): AgentsService {
  void new EventLog(); // expect: kc-wiring
  return new AgentsService(); // expect: kc-wiring
}
