import { createContext, useContext } from "react";

/**
 * Whether the right panel is maximised inside the conversation page (spec §6.16.18): set by
 * `ConversationPage` around its panel while `rightFull`, read by the panel's full-screen button
 * (`RightPanel`, the file preview's frame), which then reads "Exit full screen" (`minimize-2`).
 */
export const RightFullContext = createContext(false);

/** The panel is maximised inside the page. */
export const useRightFull = (): boolean => useContext(RightFullContext);
