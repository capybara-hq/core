// Red twin of compat.tsx: a design component that gains a required prop must fail.
import type { ButtonProps } from "../../../../packages/plugin-client/src/design";
import type { Button } from "../../../../packages/design/src/index";

type DP<C> = C extends (props: infer P) => unknown ? P : never;
type Grown = DP<typeof Button> & { tone: "loud" };
export const accepts = <A, B>(_ok: [A] extends [B] ? true : false) => {};
accepts<ButtonProps, Grown>(true);
