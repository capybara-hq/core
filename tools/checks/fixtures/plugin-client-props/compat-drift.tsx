// Red twin of compat.tsx: a package prop the design component does not accept must fail.
import type { ButtonProps } from "../../../../packages/plugin-client/src/design";
import type { Button } from "../../../../packages/design/src/index";

type DP<C> = C extends (props: infer P) => unknown ? P : never;
type Drifted = Omit<ButtonProps, "variant"> & { variant?: "typo" };
export const accepts = <A, B>(_ok: [A] extends [B] ? true : false) => {};
accepts<Drifted, DP<typeof Button>>(true);
