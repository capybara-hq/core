// Server entry: timers here and in what it imports are refused (lines marked FLAG).
import { retry } from "./server-helper.js";
import { both } from "./shared.js";
import { later } from "#util";

export const extension = () => setTimeout(() => {}, 10); // FLAG server-entry
export { both, later, retry };
