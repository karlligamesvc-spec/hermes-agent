/**
 * apex-account-reads.ts — the signed-in account reads main relays with the
 * stored login JWT, which never reaches the renderer: hc-447 更新日志 (list +
 * best-effort read receipt), hc-971 the account's team, and the hc-991
 * first-use creator profile (read and written). Each handler's request and
 * ok:false shapes live in its own module; this file only registers them, so
 * main.ts holds one call instead of one handler per read.
 */

import { fetchAnnouncements, markAnnouncementRead } from './apex-announcements'
import { type CreatorProfileDeps, creatorProfileRequest } from './apex-creator-profile'
import { fetchMyTeam } from './apex-team'

export interface IpcHandleRegistry {
  handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => void
}

export function registerApexAccountReads(
  ipcMain: IpcHandleRegistry,
  reads: CreatorProfileDeps,
  hermesHome: string
): void {
  ipcMain.handle('hermes:announcements:list', async () => fetchAnnouncements(reads))
  ipcMain.handle('hermes:announcements:markRead', async (_event, announcementId) =>
    markAnnouncementRead(reads, announcementId)
  )
  ipcMain.handle('hermes:managed:team', async () => fetchMyTeam(reads))
  ipcMain.handle('hermes:managed:creatorProfile', async (_event, request) =>
    creatorProfileRequest(reads, hermesHome, request)
  )
}
