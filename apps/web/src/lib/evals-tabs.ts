/** The two views of the "Evals & runs" page head: the tab row links the two routes. */
export function evalsTabs(
  t: (key: "tabs.sets" | "tabs.runs") => string,
  counts: { sets?: number; runs?: number } = {},
) {
  return [
    {
      id: "sets",
      label: t("tabs.sets"),
      href: "/evals",
      ...(counts.sets !== undefined ? { count: counts.sets } : {}),
    },
    {
      id: "runs",
      label: t("tabs.runs"),
      href: "/trajectories",
      ...(counts.runs !== undefined ? { count: counts.runs } : {}),
    },
  ];
}
