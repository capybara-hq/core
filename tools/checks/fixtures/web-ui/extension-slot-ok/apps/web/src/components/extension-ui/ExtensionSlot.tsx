import { Text } from "@capybara-hq/design";
import { ExtensionPanel } from "./ExtensionBlocks";

export function ExtensionSlot(_: { slot: string }) {
  return (
    <Text>
      <ExtensionPanel />
    </Text>
  );
}
