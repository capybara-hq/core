// Red twin of components.tsx: a component whose render takes another slot's props is refused in
// the `components` map (the map is not widened to accept anything).
import { type ComponentProps, defineClientExtension } from "../../src/index";

const Section = ({ conversationId }: ComponentProps<"conversation.properties.section">) => (
  <span>{conversationId}</span>
);

export default defineClientExtension({
  name: "demo",
  components: {
    brand: { slot: "shell.brand", render: Section },
  },
});
