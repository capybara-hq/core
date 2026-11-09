import { defineClientExtension, defineComponent } from "@capybara-hq/plugin-client";

const Hud = () => <span>hud</span>;
const Brand = () => <span>brand</span>;
const Empty = () => <span>empty</span>;
const Frame = ({ children }: { children?: unknown }) => <div>{children as never}</div>;
const Fx = () => null;
const Card = () => <span>card</span>;

export default defineClientExtension({
  name: "ui-components",
  components: {
    hud: defineComponent("conversation.properties.section", Hud),
    brand: defineComponent("shell.brand", Brand),
    empty: defineComponent("conversation.empty", Empty),
    frame: defineComponent("conversation.composer.frame", Frame),
    fx: defineComponent("shell.overlay", Fx),
    card: defineComponent("conversation.tool-result.card", Card),
  },
});
