import { defineClientExtension, defineComponent } from "@capybara-hq/plugin-client";

const Boom = (): never => {
  throw new Error("fake-client-broken: boom");
};

const Empty = (): never => {
  throw new Error("fake-client-broken: empty");
};

export default defineClientExtension({
  name: "fake-client-broken",
  components: {
    boom: defineComponent("conversation.properties.section", Boom),
    empty: defineComponent("conversation.empty", Empty),
  },
  events: {
    "run.started": () => {
      throw new Error("fake-client-broken: run.started");
    },
  },
});
