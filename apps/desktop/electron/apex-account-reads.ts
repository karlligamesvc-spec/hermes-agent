/**
 * apex-account-reads.ts — the signed-in account reads main relays with the
 * stored login JWT, which never reaches the renderer: hc-447 更新日志 (list +
 * best-effort read receipt), hc-971 the account's team, the hc-991
 * first-use creator profile (read and written), the hc-995 creator-tip
 * catalog, the hc-995 今日点子 (read, 开做 and 不喜欢) and the hc-1016 memory
 * ledger (read and edited). Each handler's
 * request and ok:false shapes live in its own module;
 * this file only registers them, so main.ts holds one call instead of one
 * handler per read.
 */

import { fetchAnnouncements, markAnnouncementRead } from './apex-announcements'
import { type CreatorProfileDeps, creatorProfileRequest } from './apex-creator-profile'
import { type CreatorTipsCache, fetchCreatorTips } from './apex-creator-tips'
import { dailyIdeasRequest } from './apex-daily-ideas'
import { memoryLedgerRequest } from './apex-memory-ledger'
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
  const creatorTips: CreatorTipsCache = { hash: '', tips: [] }
  ipcMain.handle('hermes:managed:creatorTips', async (_event, request) =>
    fetchCreatorTips(reads, process.env, creatorTips, request)
  )
  ipcMain.handle('hermes:managed:dailyIdeas', async (_event, request) =>
    dailyIdeasRequest(reads, process.env, request)
  )
  ipcMain.handle('hermes:managed:memoryLedger', async (_event, request) =>
    memoryLedgerRequest(reads, hermesHome, request)
  )
}
