import { createContext, useContext } from "react";

/**
 * Whether the right panel is maximised inside the conversation page (spec §6.16.18): set by
 * `ConversationPage` around its panel while `rightFull`, read by the panel's full-screen button
 * (`RightPanel`, the file preview's frame), which then reads "Exit full screen" (`minimize-2`).
 */
export const RightFullContext = createContext(false);

/** The panel is maximised inside the page. */
export const useRightFull = (): boolean => useContext(RightFullContext);

/**
 * The right area is a page pushed over the conversation on a phone (mobile layout spec §5.4): the
 * page owns back (the shell's top bar, or its own bar), so the panel draws no ×, no full-screen
 * button and no back chevron of its own.
 */
export const RightPushedContext = createContext(false);

/** The panel is a pushed page. */
export const useRightPushed = (): boolean => useContext(RightPushedContext);
