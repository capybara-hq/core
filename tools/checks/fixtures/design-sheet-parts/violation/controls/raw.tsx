import { BottomSheet, BottomSheetContent } from "../overlays/bottom-sheet";

export function RawButton() {
  return (
    <BottomSheet open title="x">
      <div>
        <button type="button">row</button>
      </div>
    </BottomSheet>
  );
}

export function RawLink() {
  return (
    <BottomSheetContent title="x">
      <a href="/x">row</a>
      <ul>
        <li>row</li>
      </ul>
    </BottomSheetContent>
  );
}
