import { ListPage } from "@capybara-hq/design";
import { ExtensionSlot } from "../components/extension-ui/ExtensionSlot";

function ExtensionSection() {
  return null;
}

export default function Page() {
  return (
    <ListPage title="x">
      <ExtensionSlot slot="org.page" />
      <ExtensionSection />
    </ListPage>
  );
}
