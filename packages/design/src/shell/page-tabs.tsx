import { Tabs, type TabsProps } from "../display/index";

export function PageTabs(p: TabsProps) {
  return (
    <div className="cb-pagetabs">
      <Tabs {...p} />
    </div>
  );
}
