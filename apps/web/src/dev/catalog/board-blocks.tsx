import { Board, BoardFrame, EmptyState, Stack, Text } from "@capybara-hq/design";
import { BOARD_FIXTURE as F } from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// Board (spec §6.69): the kanban board in its states. The blocks have the same ids and boxes as
// docs/design/reference/src/board.html. The idle block is the live board (drag a card, or focus
// one and press Space); the held states are drawn still by BoardFrame.

type Task = (typeof F.cards)[number];

/** Four 280 columns and three 12 gaps, inside the block's 16 padding. */
const W = 1188;
const noop = () => {};
const columns = F.columns.map((c) => ({ ...c }));
const cards: Task[] = [...F.cards];

function renderCard(card: Task): ReactNode {
  return (
    <Stack gap={4}>
      <Text>{card.title}</Text>
      <Text variant="small" tone="muted">
        {card.meta}
      </Text>
    </Stack>
  );
}

const frame = (held?: { columnId: string; index: number }, form?: "compact") => (
  <BoardFrame
    columns={columns}
    cards={cards}
    renderCard={renderCard}
    {...(held ? { held: { cardId: F.held, ...held } } : {})}
    {...(form ? { form } : {})}
  />
);

function boardBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="board-idle" width={W} pad>
        <Board
          columns={columns}
          cards={cards}
          renderCard={renderCard}
          onMove={noop}
          onOpen={noop}
        />
      </RefBlock>
      {/* picked up with the keyboard: lifted in its place */}
      <RefBlock id="board-dragging" width={W} pad>
        {frame({ columnId: "todo", index: 1 })}
      </RefBlock>
      <RefBlock id="board-over" width={W} pad>
        {frame({ columnId: "doing", index: 1 })}
      </RefBlock>
      <RefBlock id="board-locked-over" width={W} pad>
        {frame({ columnId: "review", index: 1 })}
      </RefBlock>
      <RefBlock id="board-empty" width={W} pad>
        <Board
          columns={columns}
          cards={[]}
          renderCard={renderCard}
          onMove={noop}
          empty={
            <EmptyState
              text={F.empty.text}
              hint={F.empty.hint}
              action={{ label: F.empty.action, variant: "primary", icon: "plus", onSelect: noop }}
            />
          }
        />
      </RefBlock>
      <RefBlock id="board-loading" width={W} pad>
        <Board columns={columns} cards={[]} renderCard={renderCard} onMove={noop} loading />
      </RefBlock>
      {/* the phone form: snapped columns, a Move to… button per card, no drag */}
      <RefBlock id="board-compact" width={390} pad>
        {frame(undefined, "compact")}
      </RefBlock>
    </>
  );
}

export const BOARD_BLOCKS = {
  board: boardBlocks,
} as const;
