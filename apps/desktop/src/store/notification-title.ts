/**
 * hc-1077: the seam a system notification's title goes through. A leaf on
 * purpose — the notification dispatcher is imported almost everywhere, and the
 * several-assistants stores must not ride along into that graph. The
 * single-thread shell installs the namer while several assistants are on
 * (store/bot-notifications.ts); without one, a title is exactly what it was.
 */

export type NotificationTitleNamer = (title: string, storedSessionId: null | string | undefined) => string

let namer: NotificationTitleNamer | null = null

export function setNotificationTitleNamer(next: NotificationTitleNamer | null): void {
  namer = next
}

export function notificationTitle(title: string, storedSessionId: null | string | undefined): string {
  return namer ? namer(title, storedSessionId) : title
}
