import { PrincipalPickerFrame, Stack } from "@capybara-hq/design";
import { PRINCIPAL_PICKER_FIXTURE as F } from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// PrincipalPicker (spec §6.70): the picker in its states. The blocks have the same ids and boxes
// as docs/design/reference/src/principal-picker.html; every state is drawn still by
// PrincipalPickerFrame (the live picker is PrincipalPicker).

const options = F.options.map((o) => ({ ...o }));

function principalPickerBlocks(): ReactNode {
  const open = (props: Partial<Parameters<typeof PrincipalPickerFrame>[0]>) => (
    <PrincipalPickerFrame
      options={options}
      value={[]}
      placeholder={F.placeholder}
      label={F.label}
      {...props}
    />
  );
  return (
    <>
      <RefBlock id="principal-picker-closed" width={720} pad>
        <Stack gap={12}>
          {open({ closed: true, value: ["u-zhou"] })}
          {open({ closed: true })}
        </Stack>
      </RefBlock>
      <RefBlock id="principal-picker-open" width={720} pad>
        {open({ value: ["u-lin"], activeId: "u-zhou" })}
      </RefBlock>
      <RefBlock id="principal-picker-searching" width={720} pad>
        {open({ query: F.search, activeId: "u-zhou" })}
      </RefBlock>
      <RefBlock id="principal-picker-grouped" width={720} pad>
        {open({ groups: true, activeId: "u-lin" })}
      </RefBlock>
      <RefBlock id="principal-picker-multi" width={720} pad>
        {open({ multiple: true, groups: true, value: ["u-zhou", "a-support"], activeId: "u-lin" })}
      </RefBlock>
      <RefBlock id="principal-picker-disabled-option" width={720} pad>
        {open({ activeId: "u-lin" })}
      </RefBlock>
      <RefBlock id="principal-picker-empty" width={720} pad>
        {open({ options: [], query: F.noMatch })}
      </RefBlock>
      <RefBlock id="principal-picker-loading" width={720} pad>
        {open({ options: options.slice(0, 2), loading: true, activeId: "u-lin" })}
      </RefBlock>
      <RefBlock id="principal-picker-compact" width={390} height={640}>
        {open({ form: "compact", groups: true, value: ["u-zhou"], activeId: "u-zhou" })}
      </RefBlock>
    </>
  );
}

export const PRINCIPAL_PICKER_BLOCKS = {
  "principal-picker": principalPickerBlocks,
} as const;
