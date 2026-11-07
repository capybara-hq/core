import { Card } from "@capybara-hq/design";

/** A hook that hands back a render function (the PurposeEditor shape before AB wave 2). */
export function usePurposeEditor() {
  const editor = (i: number) => <Card title="用途">{i}</Card>;
  return { editor, count: 1 };
}
