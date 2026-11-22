import * as RD from "@radix-ui/react-dialog";
import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { FIELDS } from "../controls/a11y";
import { Button, IconButton } from "../controls/index";
import { Input } from "../controls/inputs";
import { Icon } from "../icons/icon";
import { BoxScope } from "../layout/box";
import { useHaptics } from "../native";
import { useDesignT } from "../provider";
import { ClassForms } from "../shell/class-forms";
import { BottomSheet } from "./bottom-sheet";
import { useFocusReturn } from "./focus-return";

export type DialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  /** 480 / 640 for ordinary dialogs; 760 / 1060 wide ones (§6.7). */
  size?: 480 | 640 | 760 | 1060;
  footer: ReactNode;
  /**
   * Where focus starts: from 600 up by default the first field of the body when the dialog asks
   * for input, else the primary action; below 600 the sheet's close (§6.59); `cancel` (a dangerous
   * dialog) always starts on Cancel.
   */
  initialFocus?: "primary" | "cancel" | undefined;
  /**
   * A dangerous dialog (paired with `initialFocus="cancel"`): marked `data-danger`; the frame and
   * title stay ordinary, only its destructive button is red (spec §6.7).
   */
  danger?: boolean;
  /** The id of the element that describes the dialog (its `aria-describedby`). */
  describedBy?: string | undefined;
  /**
   * The body. The dialog is drawn anew when the window crosses 600 while it is open (a rotation:
   * the sheet becomes the centred dialog), so the body and the footer keep no state of their own
   * (an uncontrolled field's text would be lost): it lives with the caller (responsive spec §5.3).
   */
  children?: ReactNode;
};

/**
 * Where a dialog's focus starts (spec §6.7): `cancel` on the footer's first button; otherwise the
 * body's first field when it asks for input, else the primary (or destructive) action, else the
 * last button.
 */
function focusTarget(
  body: HTMLElement | null,
  footer: HTMLElement | null,
  initialFocus: DialogProps["initialFocus"],
): HTMLElement | undefined {
  const buttons = Array.from(
    footer?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]") ?? [],
  );
  if (initialFocus === "cancel") return buttons[0];
  // A dialog that asks for input starts on its first field (spec §6.7)
  return (
    body?.querySelector<HTMLElement>(FIELDS) ??
    buttons.find((b) =>
      ["primary", "danger-solid"].includes(b.getAttribute("data-variant") ?? ""),
    ) ??
    buttons[buttons.length - 1]
  );
}

/**
 * A modal dialog: centred from 600 up; below 600 the same dialog is a bottom sheet (interaction
 * model spec §2.2, D1; design spec §6.59): the sheet's handle and head (the centred title, the
 * round close), the body, then the footer's buttons full width, the primary on top. The two forms
 * differ in interaction (a drag, the system back), so each class draws its own (`ClassForms`).
 *
 * Both forms portal their content out of ClassForms' wrappers, so the `inert` it sets on the hidden
 * copy before the prune does not reach it. Accepted: a portal draws nothing until it has mounted,
 * after hydration, by which time only the matching copy is left (one dialog, one focus trap).
 */
export function Dialog(props: DialogProps) {
  return <ClassForms compact={<DialogSheet {...props} />} wide={<CentredDialog {...props} />} />;
}

function CentredDialog({
  open,
  onOpenChange,
  title,
  size = 480,
  footer,
  initialFocus = "primary",
  danger,
  describedBy,
  children,
}: DialogProps) {
  const t = useDesignT();
  const footerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusReturn = useFocusReturn();
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="cb-scrim" />
        <RD.Content
          className="cb-dialog"
          data-cap-part="dialog"
          data-size={size}
          data-danger={danger ? "true" : undefined}
          aria-describedby={describedBy}
          onCloseAutoFocus={focusReturn.restore}
          onOpenAutoFocus={(e) => {
            focusReturn.capture();
            const target = focusTarget(bodyRef.current, footerRef.current, initialFocus);
            if (target) {
              e.preventDefault();
              target.focus();
            }
          }}
        >
          <div className="cb-dialog-head">
            <RD.Title className="cb-dialog-title">{title}</RD.Title>
            <RD.Close asChild>
              <IconButton
                label={t("overlay.close")}
                icon={<Icon name="x" size={14} />}
                density="dense"
              />
            </RD.Close>
          </div>
          <BoxScope kind="dialog">
            <div className="cb-dialog-body" ref={bodyRef}>
              {children}
            </div>
            <div className="cb-dialog-foot" ref={footerRef}>
              {footer}
            </div>
          </BoxScope>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/**
 * A footer's items drawn last first (a fragment's or an array's children), so the compact stack
 * puts the primary on top with the tab order matching; `null` when the footer is one element.
 */
function reversedItems(footer: ReactNode): ReactNode[] | null {
  if (Array.isArray(footer)) return Children.toArray(footer).reverse();
  if (isValidElement<{ children?: ReactNode }>(footer) && footer.type === Fragment) {
    return Children.toArray(footer.props.children).reverse();
  }
  return null;
}

/**
 * The compact form: a bottom sheet (§6.59) with the dialog's body in its scrolling body and the
 * footer's buttons, primary first, in its footer under it. Focus starts on the sheet's close
 * (§6.59: no keyboard jumps up for a field), on Cancel for a dangerous dialog, quietly after a
 * pointer (§2.5), and returns to the opener; the sheet holds one history entry on a compact touch
 * window, so the system back closes it. The size does not apply: a sheet spans the window.
 */
function DialogSheet({
  open,
  onOpenChange,
  title,
  footer,
  initialFocus = "primary",
  danger,
  describedBy,
  children,
}: DialogProps) {
  const footerRef = useRef<HTMLDivElement>(null);
  const reversed = reversedItems(footer);
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      part="dialog-sheet"
      describedBy={describedBy}
      initialFocus={() => {
        if (initialFocus !== "cancel") return undefined;
        const buttons = Array.from(
          footerRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]") ?? [],
        );
        // Cancel comes first in the footer as given, so last once it is drawn reversed
        return reversed ? buttons[buttons.length - 1] : buttons[0];
      }}
      footer={
        <div className="cb-dialog-sheet-foot" ref={footerRef}>
          {reversed ?? footer}
        </div>
      }
    >
      <div
        className="cb-dialog-sheet"
        data-cap-part="dialog"
        data-danger={danger ? "true" : undefined}
      >
        <BoxScope kind="dialog">{children}</BoxScope>
      </div>
    </BottomSheet>
  );
}

export type DangerConfirmProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: ReactNode;
  confirmName: string;
  confirmLabel: string;
  /**
   * Keeps the confirm button disabled even once the name matches: the caller is not ready to
   * confirm yet (what the action does is still being read, or that read failed).
   */
  confirmDisabled?: boolean;
  onConfirm(): void | Promise<void>;
};

export function DangerConfirm({
  open,
  onOpenChange,
  title,
  description,
  confirmName,
  confirmLabel,
  confirmDisabled = false,
  onConfirm,
}: DangerConfirmProps) {
  const t = useDesignT();
  const inputId = useId();
  const descId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 每次开 / 关递增：关闭后才结束的 onConfirm 不再改动下一次打开的状态
  const session = useRef(0);
  useEffect(() => {
    session.current += 1;
    if (open) return;
    setTyped("");
    setBusy(false);
    setError(null);
  }, [open]);
  const ready = typed === confirmName && !confirmDisabled;
  const haptics = useHaptics();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      danger
      initialFocus="cancel"
      describedBy={descId}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("overlay.cancel")}
          </Button>
          <Button
            variant={ready ? "danger-solid" : "danger"}
            disabled={!ready}
            loading={busy}
            onClick={async () => {
              const current = session.current;
              // a destructive confirmation plays the `warning` haptic (a native shell's)
              haptics("warning");
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (err) {
                // 失败时保持对话框打开，在正文下方显示原因，用户可重试或取消
                if (session.current === current) {
                  setError(
                    err instanceof Error && err.message ? err.message : t("overlay.actionFailed"),
                  );
                }
              } finally {
                if (session.current === current) setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="cb-dialog-desc" id={descId}>
        {description}
      </div>
      <div className="cb-dialog-confirm">
        <label htmlFor={inputId}>
          {t("overlay.typeToConfirm")} <code>{confirmName}</code>
        </label>
        <Input
          id={inputId}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
        />
      </div>
      {error ? (
        <div className="cb-dialog-error" role="alert">
          <Icon name="circle-x" size={14} />
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}
