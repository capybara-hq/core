import { beta } from "@capybara-hq/plugin-beta"; // MARK import-beta

export const BETA = join(repoRoot, "plugins/beta/src/index.ts"); // MARK root-beta
export const ANY = (n: string) => new URL(`../../../plugins/${n}/src/index.ts`, import.meta.url); // MARK dynamic
export const GAMMA = new URL("../../../plugins/gamma/src/index.ts", import.meta.url);
export { beta };
