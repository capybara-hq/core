import { CatalogPage } from "../frame";
import { ButtonsSection } from "./buttons";
import { DisplaySection } from "./display";
import { InputsSection } from "./inputs";
import { NavigationSection } from "./navigation";
import { ShellSection } from "./shell";
import { TogglesSection } from "./toggles";

/** `/dev/ui/components`：spec §6 每个组件的每个可静态呈现的状态。 */
export function ComponentsCatalog() {
  return (
    <CatalogPage title="组件 Components" subtitle="@capybara-hq/design · 每个组件的全部状态">
      <ButtonsSection />
      <InputsSection />
      <TogglesSection />
      <NavigationSection />
      <DisplaySection />
      <ShellSection />
    </CatalogPage>
  );
}
