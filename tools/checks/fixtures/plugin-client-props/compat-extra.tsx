// Red twin of compat.tsx: a package prop the design component does not have must fail.
import type { ButtonProps } from "../../../../packages/plugin-client/src/design";
import type { Button } from "../../../../packages/design/src/index";

type DP<C> = C extends (props: infer P) => unknown ? P : never;
type Extra = ButtonProps & { glow?: boolean };
export const known = <A, B>(_ok: [Exclude<keyof A, keyof B>] extends [never] ? true : false) => {};
known<Extra, DP<typeof Button>>(true);
