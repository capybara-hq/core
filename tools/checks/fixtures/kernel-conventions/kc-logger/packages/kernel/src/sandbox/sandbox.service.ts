import { Logger } from "@nestjs/common";
import pino from "pino";
import { createLogger } from "../log.js";

const log = createLogger("info"); // expect: kc-logger
export const nestLog = new Logger("sandbox"); // expect: kc-logger
const raw = pino(); // expect: kc-logger

export function inside() {
  return createLogger("debug");
}
