/**
 * Whether `pathname` (without the locale) is a chat surface of the chat-first compact shell (design
 * spec §4.6): the home's new conversation (`/`) and a conversation (`/chat/<id>`). On compact a chat
 * surface leads with the menu button that opens the drawer; every other page is pushed and leads
 * with back. `/chat` itself only redirects home, so it is no surface of its own.
 */
export function isChatSurface(pathname: string): boolean {
  return pathname === "/" || /^\/chat\/[^/]+$/.test(pathname);
}
