// Red twin of compat.tsx for a generic forwarded component: a DataTable prop the design table no
// longer accepts (here `rowHeight`) must fail like a drifted Button prop does.
import type { DataTableProps } from "../../../../packages/plugin-client/src/design";
import type { DataTable } from "../../../../packages/design/src/index";

type DP<C> = C extends (props: infer P) => unknown ? P : never;
type Drifted = Omit<DataTableProps<unknown>, "rowHeight"> & { rowHeight?: "huge" };
export const accepts = <A, B>(_ok: [A] extends [B] ? true : false) => {};
accepts<Drifted, DP<typeof DataTable>>(true);
