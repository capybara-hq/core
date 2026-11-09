import { ListPage, ReplaceableFrame } from "@capybara-hq/design";
import { ClientComponentBlock } from "../components/extension-ui/ClientComponentBlock";
import { ReplaceableSlot } from "../components/extension-ui/ReplaceableSlot";

export default function Page() {
  return (
    <ListPage title="x">
      <ClientComponentBlock />
      <ReplaceableSlot />
      <ReplaceableFrame pending={false} />
    </ListPage>
  );
}
