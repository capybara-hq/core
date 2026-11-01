import { ListPage } from "@capybara-hq/design";
import { Panel } from "./panel";

export default function View() {
  return <ListPage header={{ path: [], title: "x" }}><Panel /></ListPage>;
}
