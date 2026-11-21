import NotificationsView from "./view";

/**
 * `/account/notifications`: the devices that receive push notifications and the four category
 * switches. It reads nothing: the layout prefetches both on a first load (`lib/query/routes.ts`).
 */
export default function NotificationsPage() {
  return <NotificationsView />;
}
