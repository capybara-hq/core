import { Card, CardGrid, ObjectCard, Sheet } from "@capybara-hq/design";

function Grid() {
  return (
    <CardGrid label="卡片">
      <ObjectCard title="a" href="/a" />
    </CardGrid>
  );
}

export function Cards() {
  return (
    <>
      <Card title="外">
        <CardGrid label="卡片">
          <ObjectCard title="a" href="/a" />
        </CardGrid>
      </Card>
      <Sheet open onOpenChange={() => {}} title="侧板">
        <ObjectCard title="b" href="/b" />
      </Sheet>
      <Card title="外">
        <Grid />
      </Card>
      {/* On the page ground: the grid and its cards are fine. */}
      <CardGrid label="页面上">
        <ObjectCard title="c" href="/c" />
      </CardGrid>
      <Grid />
    </>
  );
}
