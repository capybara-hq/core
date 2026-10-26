// 违规 fixture：各种形态的定时器。
import { setTimeout as sleep } from "node:timers/promises";
import timers from "timers";

export function run(): void {
  setTimeout(() => {}, 10);
  setInterval(() => {}, 10);
  setImmediate(() => {});
  globalThis.setTimeout(() => {}, 10);
  globalThis["setInterval"](() => {}, 10);
  const alias = setTimeout;
  alias(() => {}, 10);
  timers.setTimeout(() => {}, 10);
  void sleep(10);
}
