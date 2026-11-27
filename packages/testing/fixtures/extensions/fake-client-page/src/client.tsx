import {
  defineClientExtension,
  defineComponent,
  useAction,
  usePluginQuery,
} from "@capybara-hq/plugin-client";

type Items = { items: { id: string; title: string; column: string }[] };

const Board = () => {
  const q = usePluginQuery<Items>("items");
  const act = useAction();
  return (
    <section data-testid="fake-client-page-board" data-status={q.status}>
      {(q.data?.items ?? []).map((i) => (
        <button
          key={i.id}
          type="button"
          data-testid={`fake-client-page-item-${i.id}`}
          onClick={() => void act("move", { payload: { id: i.id, column: "done" } })}
        >
          {i.title}
        </button>
      ))}
    </section>
  );
};

export default defineClientExtension({
  name: "fake-client-page",
  components: { board: defineComponent("org.page", Board) },
});
