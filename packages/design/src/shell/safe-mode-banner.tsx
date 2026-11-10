import type { JSX } from "react";
import { Button } from "../controls/button";
import { useDesignT } from "../provider";

/**
 * The banner of safe mode (client extensions spec §9.6): plugin interface code is off, built-in
 * interface only. A person leaves safe mode with the button.
 */
export function SafeModeBanner({ onExit }: { onExit(): void }): JSX.Element {
  const t = useDesignT();
  return (
    <div className="cb-safe-banner" data-part="safe-mode-banner" role="status">
      <span className="cb-safe-banner-text">{t("safeMode.message")}</span>
      <Button onClick={onExit}>{t("safeMode.exit")}</Button>
    </div>
  );
}
