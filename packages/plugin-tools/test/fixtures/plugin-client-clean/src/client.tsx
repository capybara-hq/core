import { defineClientExtension, defineComponent } from "@capybara-hq/plugin-client";
import { useState } from "react";

function Hud() {
  const [n] = useState(0);
  return <div data-cap-part="shell">{n}</div>;
}

export default defineClientExtension({
  name: "fixture-plugin-client-clean",
  components: { hud: defineComponent("conversation.properties.section", Hud) },
});
