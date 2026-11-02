import type { Data } from "./view";
import XView, { type Data as D2 } from "./view";
import { PAGE_SIZE } from "./view";
import * as all from "./view";
export { PAGE_SIZE as SIZE } from "./view";
export { default as XViewAgain, type Data as D3 } from "./view";

export default async function Page() {
  const initial: Data & D2 = { n: PAGE_SIZE + Object.keys(all).length };
  return <XView initial={initial} />;
}
