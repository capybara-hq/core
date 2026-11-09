// Client entry: browser code may use timers and module state (one document, not a replica).
import { flicker } from "#fx/flicker";
import { glitch } from "./ui/glitch";
import { both } from "./shared.js";
import { blink } from "./ui/index.js";
import { later } from "./util.js";

let booted = false;
export const boot = () => setTimeout(() => (booted = true), 1500);
export const isBooted = () => booted;
export default { both, blink, flicker, glitch, later };
