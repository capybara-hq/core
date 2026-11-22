import { BottomSheet, SheetGroup, SheetRow } from "../overlays/bottom-sheet";

export function Fine() {
  return (
    <BottomSheet open title="x">
      <SheetGroup>
        <SheetRow label="a" onPress={() => {}} />
      </SheetGroup>
    </BottomSheet>
  );
}

// A raw button outside a sheet, and in a sheet's attributes, is not a sheet row.
export function Outside() {
  return <button type="button">x</button>;
}

export function InAttribute() {
  return <BottomSheet open title="x" footer={<button type="button">ok</button>} />;
}
