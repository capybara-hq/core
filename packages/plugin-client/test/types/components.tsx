// Type-only fixture (test/types.test.ts runs tsc on it under strict): a `components` map of
// components bound to different slots type-checks, and each render gets its own slot's props.
// components-mismatch.tsx is its red twin.
import {
  type ClientComponent,
  type ComponentProps,
  defineClientExtension,
  defineComponent,
} from "../../src/index";

const Brand = ({ builtin, collapsed, panel }: ComponentProps<"shell.brand">) => (
  <span data-collapsed={String(collapsed)} data-panel={panel}>
    {builtin}
  </span>
);
const Section = ({ conversationId }: ComponentProps<"conversation.properties.section">) => (
  <span>{conversationId}</span>
);
const Overlay = () => null;
const Frame = ({ children }: ComponentProps<"conversation.composer.frame">) => (
  <div>{children}</div>
);

const brand = defineComponent("shell.brand", Brand);
export const bound: ClientComponent<"shell.brand"> = brand;

export default defineClientExtension({
  name: "demo",
  components: {
    brand,
    hud: defineComponent("conversation.properties.section", Section),
    scanlines: defineComponent("shell.overlay", Overlay),
    frame: defineComponent("conversation.composer.frame", Frame),
    inline: defineComponent("conversation.empty", ({ builtin, greeting }) => (
      <div title={greeting}>{builtin}</div>
    )),
  },
});
