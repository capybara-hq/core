import { Callout, Card, FormSection } from "@capybara-hq/design";

// A hook that returns what it returns itself, and a pair that return each other's: the rule must
// finish, follow what they do draw, and read the cycles as nothing.
function useSelf() {
  const { looped } = useSelf();
  return { looped, drawn: () => <Card title="自身">一</Card> };
}

function usePing() {
  const { echo } = usePong();
  return { echo, card: () => <Card title="乒">二</Card> };
}

function usePong() {
  const { echo } = usePing();
  return { echo };
}

// A module-level name and a parameter of the same name: the parameter shadows it.
const cards = <Card title="外层">三</Card>;

export function Recursive({ items }: { items: string[] }) {
  const { looped, drawn } = useSelf();
  const { echo, card } = usePing();
  return (
    <>
      <FormSection id="self" title="自身">
        {looped}
        {drawn()}
      </FormSection>
      <FormSection id="pair" title="互相">
        {echo}
        {card()}
      </FormSection>
      {items.map((cards) => (
        <FormSection key={String(cards)} id="shadow" title="遮蔽">
          {cards}
        </FormSection>
      ))}
      {/* A Callout draws its unboxed form inside a box (it adapts like a CodeBlock). */}
      <Card title="提示">
        <Callout tone="warn">没有模型。</Callout>
      </Card>
      {cards}
    </>
  );
}

// Two components that draw each other: Loop1's traits are first read while Loop2 is open (so
// without Loop2's Card); they must not be kept, so Loop1 inside a box is still reported.
function Loop1() {
  return <Loop2 />;
}

function Loop2() {
  return (
    <>
      <Loop1 />
      <Card title="环">四</Card>
    </>
  );
}

export function Cycle() {
  return (
    <FormSection id="loop" title="环">
      <Loop1 />
    </FormSection>
  );
}
