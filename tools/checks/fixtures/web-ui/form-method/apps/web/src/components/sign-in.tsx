import { Input } from "@capybara-hq/design";
import React from "react";

export function SignIn() {
  return (
    <>
      <form onSubmit={() => {}}>
        <Input name="password" type="password" />
      </form>
      <form method="get">
        <Input name="password" type="password" />
      </form>
      <form method="post">
        <Input name="password" type="password" />
      </form>
      <form method={"POST"}>
        <Input name="password" type="password" />
      </form>
      {React.createElement("form", { onSubmit: () => {} })}
      {React.createElement("form", { method: "post" })}
    </>
  );
}
