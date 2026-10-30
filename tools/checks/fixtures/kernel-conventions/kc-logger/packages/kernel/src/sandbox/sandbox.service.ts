import { Logger } from "@nestjs/common";
import pino from "pino";
import { createLogger } from "../log.js";
import { createLogger as mk } from "../log.js";

const log = createLogger("info"); // expect: kc-logger
export const nestLog = new Logger("sandbox"); // expect: kc-logger
const raw = pino(); // expect: kc-logger
const aliased = mk("warn"); // expect: kc-logger
const make = createLogger;
const held = make("error"); // expect: kc-logger
let late: unknown;
late = createLogger("late"); // expect: kc-logger

export class Holder {
  static readonly log = createLogger("static"); // expect: kc-logger
  readonly own = createLogger("instance");
}

export function inside() {
  return createLogger("debug");
}
