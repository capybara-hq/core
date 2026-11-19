import { Icon } from "../icons/icon";
import { useDesignLink, useDesignT } from "../provider";
import type { SetupStep } from "./sidebar";

/**
 * The setup frame's steps as a page of their own (spec §5.5, compact): the setup home and the
 * steps as rows, the current one marked, a waiting step with the reason under it. The shell pushes
 * it over the setup home (the tab root) from the top bar's steps button; a link leaves it.
 */
export function SetupSteps({
  home,
  steps,
  current,
}: {
  home: { href: string };
  steps: SetupStep[];
  /** A step id or `home`. */
  current: string;
}) {
  const t = useDesignT();
  const Link = useDesignLink();
  return (
    <nav className="cb-setup-steps" data-part="setup-steps" aria-label={t("shell.steps")}>
      <ul className="cb-setup-steps-list">
        <li>
          <Link
            href={home.href}
            className="cb-setup-step"
            data-part="setup-step"
            data-id="home"
            {...(current === "home" ? { "aria-current": "page" as const } : {})}
          >
            <Icon name="home" size={14} />
            <span className="cb-setup-step-label">{t("sidebar.setupHome")}</span>
          </Link>
        </li>
        {steps.map((step) => {
          const waiting = step.state === "waiting" || step.href === undefined;
          const body = (
            <>
              <Icon
                name={waiting ? "clock" : step.state === "done" ? "check" : "circle"}
                size={14}
              />
              <span className="cb-setup-step-text">
                <span className="cb-setup-step-label">{step.label}</span>
                {waiting ? (
                  <span className="cb-setup-step-reason">
                    {step.reason ?? t("sidebar.stepWaiting")}
                  </span>
                ) : null}
              </span>
            </>
          );
          return (
            <li key={step.id}>
              {waiting ? (
                <span
                  className="cb-setup-step"
                  data-part="setup-step"
                  data-id={step.id}
                  aria-disabled="true"
                >
                  {body}
                </span>
              ) : (
                <Link
                  href={step.href as string}
                  className="cb-setup-step"
                  data-part="setup-step"
                  data-id={step.id}
                  {...(current === step.id ? { "aria-current": "page" as const } : {})}
                >
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
