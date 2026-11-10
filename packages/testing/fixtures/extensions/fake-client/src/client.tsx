import {
  defineClientExtension,
  defineComponent,
  useClientStorage,
  useView,
} from "@capybara-hq/plugin-client";

const Hud = () => {
  // useView() is the view state ({ view, status, retry }); the server view's data is on `view`
  const { view } = useView();
  const data = view?.data as { n?: number } | undefined;
  return <span data-testid="fake-client-hud">{`hud ${data?.n ?? "-"}`}</span>;
};

const Brand = ({ builtin }: { builtin: unknown }) => (
  <span data-testid="fake-client-brand">{builtin as never}</span>
);

const Empty = ({ greeting }: { greeting: string }) => (
  <p data-testid="fake-client-empty">{greeting}</p>
);

const Frame = ({ children }: { children?: unknown }) => (
  <div data-testid="fake-client-frame">{children as never}</div>
);

const Fx = () => {
  const storage = useClientStorage();
  return <i data-testid="fake-client-fx" data-last={storage.get("last") ?? ""} />;
};

export default defineClientExtension({
  name: "fake-client",
  components: {
    hud: defineComponent("conversation.properties.section", Hud),
    brand: defineComponent("shell.brand", Brand),
    empty: defineComponent("conversation.empty", Empty),
    frame: defineComponent("conversation.composer.frame", Frame),
    fx: defineComponent("shell.overlay", Fx),
  },
  events: {
    "run.started": (e, api) => api.storage.set("last", e.type),
    "run.finished": (e, api) => api.storage.set("last", e.type),
    "run.failed": (e, api) => api.storage.set("last", e.type),
    "message.sent": (e, api) => api.storage.set("last", e.type),
    "message.received": (e, api) => api.storage.set("last", e.type),
    "tool.started": (e, api) => api.storage.set("last", e.type),
    "tool.finished": (e, api) => api.storage.set("last", e.type),
    "approval.requested": (e, api) => api.storage.set("last", e.type),
  },
});
