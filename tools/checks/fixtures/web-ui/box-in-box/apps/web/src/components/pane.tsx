import { AgentMapDialog, Card, TranscriptFrame } from "@capybara-hq/design";

// A full-height pane starts again on the page ground: a local component that draws into a
// TranscriptFrame does not draw a box inside the box it is followed in, whatever the frame holds.
function Inner() {
  return <Card title="记录">一</Card>;
}

function Middle() {
  return (
    <TranscriptFrame>
      <Inner />
    </TranscriptFrame>
  );
}

export function PaneInDialog() {
  return (
    <AgentMapDialog open onOpenChange={() => {}}>
      <Middle />
    </AgentMapDialog>
  );
}

// Without the pane the same shape is still a second box: the component's Card is inside the dialog.
function Nested() {
  return <Card title="直接">二</Card>;
}

export function NestedInDialog() {
  return (
    <AgentMapDialog open onOpenChange={() => {}}>
      <Nested />
    </AgentMapDialog>
  );
}
