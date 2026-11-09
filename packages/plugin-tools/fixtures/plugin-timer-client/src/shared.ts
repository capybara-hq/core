// Imported by both entries: it runs on the server too, so it is still refused.
export const both = () => setTimeout(() => {}, 10); // FLAG shared
export let hits = 0; // FLAG shared-state
