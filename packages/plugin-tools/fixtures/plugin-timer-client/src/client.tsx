// Client entry: browser code may use timers (one tab, not a replica).
import { flicker } from "#fx/flicker";
import { glitch } from "./ui/glitch";
import { both } from "./shared.js";
import { blink } from "./ui/index.js";
import { later } from "./util.js";

export const boot = () => setTimeout(() => {}, 1500);
export default { both, blink, flicker, glitch, later };
