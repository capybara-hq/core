import { ListPage } from "@capybara-hq/design";
import React from "react";

export default function Page() {
  return (
    <ListPage title="x">
      {React.createElement("div", { style: { margin: 4 } })}
    </ListPage>
  );
}
